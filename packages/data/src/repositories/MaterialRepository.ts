import { and, eq, inArray } from "drizzle-orm";
import type { CourseId } from "@vta/shared";
import type { Db } from "../client.js";
import { materials, chunks } from "../schema/materials.js";
import type {
  MaterialRow,
  NewMaterialRow,
  NewChunkRow,
} from "../schema/materials.js";
import { guardCourse } from "./guard.js";

/**
 * Input shape for replacing a material's chunks. The caller supplies the chunk
 * bodies; `courseId` and `materialId` are filled in by the repository so they
 * cannot drift from the scoped values.
 */
export type ChunkInput = Omit<NewChunkRow, "courseId" | "materialId">;

/**
 * Course-scoped access to materials and their chunks. Every method takes an
 * explicit `courseId` and refuses to touch rows belonging to another course.
 */
export class MaterialRepository {
  constructor(private readonly db: Db) {}

  /**
   * Insert or update a material, scoped to `courseId`. Conflict key is
   * (courseId, sourceType, externalId) when an `externalId` is present; for
   * uploads without an external id we always insert a new row.
   *
   * The `courseId` carried in `input` must equal the explicit `courseId`.
   */
  async upsertMaterial(
    courseId: CourseId,
    input: NewMaterialRow,
  ): Promise<MaterialRow> {
    guardCourse(courseId, input.courseId);

    const values: NewMaterialRow = { ...input, courseId };

    // Idempotent on (course_id, source_type, external_id) — see the unique index
    // in schema/materials.ts. Re-syncing the same source reuses the SAME row id,
    // so its chunks (keyed by material_id) are never orphaned and rows do not
    // accumulate across syncs.
    const rows = await this.db
      .insert(materials)
      .values(values)
      .onConflictDoUpdate({
        target: [materials.courseId, materials.sourceType, materials.externalId],
        set: {
          title: values.title,
          kind: values.kind,
          contentHash: values.contentHash,
          uri: values.uri ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    const row = rows[0];
    if (row === undefined) {
      throw new Error("MaterialRepository.upsertMaterial: expected a returned row");
    }
    return row;
  }

  /** Fetch a material by id, scoped to a course. Returns `undefined` if absent. */
  async getById(
    courseId: CourseId,
    materialId: string,
  ): Promise<MaterialRow | undefined> {
    const rows = await this.db
      .select()
      .from(materials)
      .where(and(eq(materials.id, materialId), eq(materials.courseId, courseId)))
      .limit(1);
    return rows[0];
  }

  /**
   * Fetch the single material for a source key, scoped to a course. With the
   * unique index on (course_id, source_type, external_id) there is at most one.
   * Used by ingestion to detect change (compare stored contentHash) and to reuse
   * the stable row id across re-syncs.
   */
  async findByExternalKey(
    courseId: CourseId,
    sourceType: string,
    externalId: string,
  ): Promise<MaterialRow | undefined> {
    const rows = await this.db
      .select()
      .from(materials)
      .where(
        and(
          eq(materials.courseId, courseId),
          eq(materials.sourceType, sourceType),
          eq(materials.externalId, externalId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Atomically replace ALL chunks of a material with a new set, and OPTIONALLY
   * stamp the material's `contentHash` in the SAME transaction. Verifies the
   * material belongs to `courseId` before mutating, and stamps every new chunk
   * with the scoped `courseId`/`materialId`.
   *
   * Passing `contentHash` here (rather than at upsert time) is what makes change
   * detection safe: the hash only advances once the chunks are successfully
   * written, so a failed embed upstream never leaves a material marked "current"
   * with stale/absent chunks (it stays dirty and is retried on the next sync).
   */
  async replaceChunks(
    courseId: CourseId,
    materialId: string,
    newChunks: readonly ChunkInput[],
    contentHash?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Confirm the material exists AND belongs to this course before mutating.
      const owner = await tx
        .select({ courseId: materials.courseId })
        .from(materials)
        .where(eq(materials.id, materialId))
        .limit(1);
      const ownerRow = owner[0];
      if (ownerRow !== undefined) {
        guardCourse(courseId, ownerRow.courseId);
      }
      // If the material does not exist we still scope the delete by courseId,
      // so this is a no-op rather than a cross-tenant action.

      await tx
        .delete(chunks)
        .where(
          and(eq(chunks.materialId, materialId), eq(chunks.courseId, courseId)),
        );

      if (newChunks.length > 0) {
        const rows: NewChunkRow[] = newChunks.map((c) => ({
          ...c,
          courseId,
          materialId,
        }));
        await tx.insert(chunks).values(rows);
      }

      // Stamp the hash LAST, inside the same tx, so it is atomic with the chunk
      // write. Scoped by courseId + id so it cannot touch another tenant's row.
      if (contentHash !== undefined) {
        await tx
          .update(materials)
          .set({ contentHash, updatedAt: new Date() })
          .where(and(eq(materials.id, materialId), eq(materials.courseId, courseId)));
      }
    });
  }

  /**
   * List (id, externalId) for every material of a given `sourceType` in a
   * course. Used by ingestion to reconcile: any stored canvas material whose
   * externalId was NOT seen in a (clean) sync has been deleted upstream.
   */
  async listExternalIdsBySource(
    courseId: CourseId,
    sourceType: string,
  ): Promise<Array<{ id: string; externalId: string | null }>> {
    return this.db
      .select({ id: materials.id, externalId: materials.externalId })
      .from(materials)
      .where(and(eq(materials.courseId, courseId), eq(materials.sourceType, sourceType)));
  }

  /**
   * Delete materials by id, scoped to `courseId`; their chunks are removed via
   * the ON DELETE CASCADE on `chunks.material_id`. Returns the number deleted.
   */
  async deleteByIds(courseId: CourseId, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const deleted = await this.db
      .delete(materials)
      .where(and(eq(materials.courseId, courseId), inArray(materials.id, [...ids])))
      .returning({ id: materials.id });
    return deleted.length;
  }
}
