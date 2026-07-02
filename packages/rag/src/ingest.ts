/**
 * Ingestion: turn course materials (synced from Canvas, or uploaded by a
 * professor) into course-scoped, embedded `chunks` ready for retrieval.
 *
 * Cost discipline: embeddings are the expensive step, so we re-chunk and
 * re-embed a material ONLY when its content actually changed. Change is detected
 * by comparing the freshly-computed `contentHash` against the stored one for the
 * same `(courseId, sourceType, externalId)`. Unchanged materials are still
 * upserted (so metadata like title/uri stays fresh) but skip embedding.
 *
 * Tenant safety: `courseId` is threaded through every repository call and every
 * database read. No code path here reads or writes another course's rows.
 *
 * Policy: this pipeline NEVER ingests quiz questions or enrollments. The Canvas
 * client exposes no method for quiz questions, and we simply never call
 * `listEnrollments` here — there is no content surface for either.
 */

import type { CanvasClient } from '@vta/canvas';
import {
  toNormalizedAnnouncement,
  toNormalizedAssignment,
  toNormalizedFile,
  toNormalizedModule,
  toNormalizedPage,
  toNormalizedSyllabus,
  contentHash as computeContentHash,
} from '@vta/canvas';
import type { NormalizedMaterial } from '@vta/canvas';
import type { CourseId, Logger } from '@vta/shared';
import { createLogger, toError } from '@vta/shared';
import type {
  ChunkInput,
  ChunkRepository,
  MaterialRepository,
  NewMaterialRow,
} from '@vta/data';
import { EMBEDDING_DIMENSIONS } from '@vta/data';

import { approximateTokenCount, chunkMarkdown } from './chunking.js';
import { extractText, isExtractable } from './extraction.js';
import type { EmbeddingProvider, IngestStats } from './types.js';

/** Dependencies injected into the ingestor. */
export interface RagIngestorDeps {
  readonly canvas: CanvasClient;
  readonly embedder: EmbeddingProvider;
  readonly materialRepo: MaterialRepository;
  /**
   * Held for read-side parity and future direct chunk operations. Chunk WRITES
   * during ingestion go through `materialRepo.replaceChunks`, which performs the
   * delete+insert atomically in one transaction (the only safe way to swap a
   * material's chunk set); `ChunkRepository` exposes read/search only.
   */
  readonly chunkRepo: ChunkRepository;
  readonly logger?: Logger;
}

/** How many chunk texts to embed per provider call. */
const EMBED_BATCH_SIZE = 64;

/**
 * Course-scoped ingestion pipeline. One instance can ingest many courses; the
 * `courseId` is always passed per call, never stored on the instance.
 */
export class RagIngestor {
  private readonly canvas: CanvasClient;
  private readonly embedder: EmbeddingProvider;
  private readonly materialRepo: MaterialRepository;
  private readonly chunkRepo: ChunkRepository;
  private readonly log: Logger;

  constructor(deps: RagIngestorDeps) {
    this.canvas = deps.canvas;
    this.embedder = deps.embedder;
    this.materialRepo = deps.materialRepo;
    this.chunkRepo = deps.chunkRepo;
    this.log = deps.logger ?? createLogger({ name: 'rag-ingestor' });
  }

  /**
   * Ingest an entire Canvas course: pages, assignments, announcements, modules,
   * the syllabus, and uploaded FILES (PDF/DOCX/PPTX/text are downloaded and their
   * text extracted). Quiz questions and enrollments are intentionally excluded.
   *
   * @param courseId        the VTA tenant id (NOT the Canvas id) — tenant scope.
   * @param canvasCourseId  the Canvas course id (a numeric string).
   */
  async ingestCanvasCourse(
    courseId: CourseId,
    canvasCourseId: string,
  ): Promise<IngestStats> {
    const canvasId = Number.parseInt(canvasCourseId, 10);
    if (!Number.isFinite(canvasId)) {
      throw new Error(
        `ingestCanvasCourse: canvasCourseId "${canvasCourseId}" is not a numeric Canvas id`,
      );
    }

    const { materials: normalized, complete } = await this.collectCanvasMaterials(
      courseId,
      canvasId,
    );

    let materialsProcessed = 0;
    let materialsChanged = 0;
    let chunksWritten = 0;

    for (const material of normalized) {
      const result = await this.ingestMaterial(courseId, toParts(material));
      materialsProcessed += 1;
      if (result.changed) {
        materialsChanged += 1;
        chunksWritten += result.chunksWritten;
      }
    }

    // Reconcile deletions: any stored canvas material whose externalId was NOT
    // seen this run has been removed OR unpublished upstream, so drop it (chunks
    // cascade). Only do this on a CLEAN sync — if any fetch failed, `complete`
    // is false and we skip, so a transient Canvas error can never wipe still-
    // valid content (a genuinely-deleted item is then cleaned on the next clean
    // sync). Uploads (sourceType 'upload') are never touched.
    let materialsRemoved = 0;
    if (complete) {
      const seen = new Set(normalized.map((m) => m.externalId));
      const stored = await this.materialRepo.listExternalIdsBySource(courseId, 'canvas');
      const stale = stored
        .filter((s) => s.externalId !== null && !seen.has(s.externalId))
        .map((s) => s.id);
      materialsRemoved = await this.materialRepo.deleteByIds(courseId, stale);
    } else {
      this.log.warn(
        { courseId },
        'canvas sync had fetch errors; skipping delete-reconcile to avoid removing still-valid materials',
      );
    }

    this.log.info(
      { courseId, canvasCourseId, materialsProcessed, materialsChanged, chunksWritten, materialsRemoved },
      'canvas course ingestion complete',
    );
    return { materialsProcessed, materialsChanged, chunksWritten, materialsRemoved };
  }

  /**
   * Ingest a single professor-uploaded material supplied as Markdown.
   *
   * TODO(extraction-frontend): binary uploads (PDF/PPTX/DOCX) must be converted
   * to Markdown by a separate text-extraction front-end before reaching this
   * method; out of scope here. This method accepts pre-extracted Markdown only.
   */
  async ingestUpload(
    courseId: CourseId,
    material: { externalId: string; title: string; kind: string; markdown: string },
  ): Promise<IngestStats> {
    const markdown = typeof material.markdown === 'string' ? material.markdown : '';
    // Uploads persist under the 'upload' source namespace (NOT 'canvas'), so
    // change detection keys on ('upload', externalId) and never collides with a
    // synced Canvas material that happens to share an external id.
    const parts: MaterialParts = {
      sourceType: 'upload',
      externalId: material.externalId,
      title: material.title,
      kind: material.kind,
      markdown,
      contentHash: computeContentHash(markdown),
    };

    const result = await this.ingestMaterial(courseId, parts);

    const stats: IngestStats = {
      materialsProcessed: 1,
      materialsChanged: result.changed ? 1 : 0,
      chunksWritten: result.changed ? result.chunksWritten : 0,
    };
    this.log.info({ courseId, externalId: material.externalId, ...stats }, 'upload ingestion complete');
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Internals.
  // ---------------------------------------------------------------------------

  /**
   * Fetch every supported Canvas resource and normalize it. Page bodies require
   * a per-page fetch (the list endpoint omits the body), so we expand those.
   *
   * UNPUBLISHED CONTENT IS SKIPPED: pages/assignments/modules with
   * `published === false`, and files that are `locked`/`hidden`, are not
   * ingested — so not-yet-released material (future homework/exam keys) never
   * becomes student-retrievable. (When a course later opts into
   * `allowUnreleasedMaterial`, this is the single site that would gate the skip.)
   *
   * Returns `complete: false` if ANY fetch failed, so the caller skips the
   * delete-reconcile pass (a partial sync must never delete still-valid content).
   */
  private async collectCanvasMaterials(
    courseId: CourseId,
    canvasId: number,
  ): Promise<{ materials: NormalizedMaterial[]; complete: boolean }> {
    const out: NormalizedMaterial[] = [];
    // Any fetch failure flips this; unpublished-SKIPS do NOT (they are intended
    // and should let reconcile remove a now-unpublished material).
    let hadError = false;

    // --- Pages: list gives metadata only; fetch each page for its body. -------
    const pageStubs = await this.canvas.listPages(canvasId);
    for (const stub of pageStubs) {
      if (stub.published === false) continue;
      try {
        const full = await this.canvas.getPage(canvasId, stub.url);
        if (full.published === false) continue;
        out.push(toNormalizedPage(full));
      } catch (cause) {
        hadError = true;
        this.log.warn(
          { courseId, pageUrl: stub.url, err: toError(cause).message },
          'skipping page that failed to fetch',
        );
      }
    }

    // --- Assignments: descriptions are inlined on the list endpoint. ----------
    const assignments = await this.canvas.listAssignments(canvasId);
    for (const a of assignments) {
      if (a.published === false) continue;
      out.push(toNormalizedAssignment(a));
    }

    // --- Announcements (discussion topics — no separate publish state). -------
    const announcements = await this.canvas.listAnnouncements(canvasId);
    for (const ann of announcements) out.push(toNormalizedAnnouncement(ann));

    // --- Modules (items inlined). ---------------------------------------------
    const modules = await this.canvas.listModules(canvasId);
    for (const m of modules) {
      if (m.published === false) continue;
      out.push(toNormalizedModule(m));
    }

    // --- Syllabus: needs the course object + the syllabus HTML. ---------------
    try {
      const course = await this.canvas.getCourse(canvasId);
      const syllabusHtml = await this.canvas.getSyllabus(canvasId);
      const syllabus = toNormalizedSyllabus(course, syllabusHtml);
      // Only index a syllabus that has actual content.
      if (syllabus.markdown.trim() !== '') out.push(syllabus);
    } catch (cause) {
      hadError = true;
      this.log.warn(
        { courseId, err: toError(cause).message },
        'skipping syllabus that failed to fetch',
      );
    }

    // --- Files: download supported documents (PDF/DOCX/PPTX/text) and extract
    //     their text. This is where most of a course's substance lives (lecture
    //     slides, readings) — absent from the HTML endpoints above. Each file is
    //     isolated: a single download/parse failure is logged and skipped, never
    //     aborting the sync.
    try {
      const files = await this.canvas.listFiles(canvasId);
      for (const file of files) {
        if (file.locked === true || file.hidden === true) continue; // unpublished/hidden
        if (
          !isExtractable({
            filename: file.filename,
            contentType: file['content-type'],
            size: file.size,
          })
        ) {
          continue;
        }
        try {
          const bytes = await this.canvas.downloadFile(file);
          const text = await extractText(bytes, {
            filename: file.filename,
            contentType: file['content-type'],
          });
          if (text.trim() === '') continue; // nothing extractable (e.g. scanned image PDF)
          out.push(toNormalizedFile(file, text));
        } catch (cause) {
          hadError = true;
          this.log.warn(
            { courseId, fileId: file.id, err: toError(cause).message },
            'skipping file that failed to download/extract',
          );
        }
      }
    } catch (cause) {
      hadError = true;
      this.log.warn(
        { courseId, err: toError(cause).message },
        'skipping files listing that failed to fetch',
      );
    }

    return { materials: out, complete: !hadError };
  }

  /**
   * Upsert one material and, only when its content changed, chunk + embed +
   * replace its chunks. Returns whether it changed and how many chunks were
   * written. This is the single shared path for both Canvas and upload sources.
   */
  private async ingestMaterial(
    courseId: CourseId,
    parts: MaterialParts,
  ): Promise<{ changed: boolean; chunksWritten: number }> {
    // Detect change against the existing row for this (courseId, sourceType,
    // externalId). The upsert below reuses that SAME row id (idempotent), so when
    // content is unchanged the already-embedded chunks remain valid and we skip
    // the expensive re-embed.
    const existing = await this.materialRepo.findByExternalKey(
      courseId,
      parts.sourceType,
      parts.externalId,
    );
    const changed =
      existing === undefined || existing.contentHash !== parts.contentHash;

    // Upsert metadata now, but do NOT advance the contentHash yet when content
    // changed: keep the row "dirty" (its old hash, or '' on first ingest) so that
    // if embedding throws below, the material is NOT marked current and IS
    // retried on the next sync. `replaceChunks` stamps the new hash in the same
    // transaction as the chunk write, so the hash only advances once chunks land.
    const row: NewMaterialRow = {
      courseId,
      sourceType: parts.sourceType,
      externalId: parts.externalId,
      title: parts.title,
      kind: parts.kind,
      contentHash: changed ? (existing?.contentHash ?? '') : parts.contentHash,
      ...(parts.uri !== undefined ? { uri: parts.uri } : {}),
    };
    const saved = await this.materialRepo.upsertMaterial(courseId, row);

    if (!changed) {
      this.log.debug(
        { courseId, externalId: parts.externalId },
        'material unchanged; skipping re-embed',
      );
      return { changed: false, chunksWritten: 0 };
    }

    // Embed (may throw on network/rate-limit) BEFORE the hash is advanced.
    const chunkInputs = await this.buildChunkInputs(parts.markdown);
    // Replace chunks AND stamp the new contentHash atomically in one transaction.
    await this.materialRepo.replaceChunks(courseId, saved.id, chunkInputs, parts.contentHash);

    return { changed: true, chunksWritten: chunkInputs.length };
  }

  /**
   * Chunk the markdown, embed each chunk's content (batched to bound request
   * size), and assemble `ChunkInput`s carrying the embedding + approximate
   * token count. Returns an empty array for empty content (a valid state: the
   * material exists but has no retrievable body).
   */
  private async buildChunkInputs(markdown: string): Promise<ChunkInput[]> {
    const chunks = chunkMarkdown(markdown);
    if (chunks.length === 0) return [];

    const texts = chunks.map((c) => c.content);
    const embeddings = await this.embedBatched(texts);

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `embedding count mismatch: got ${embeddings.length} vectors for ${chunks.length} chunks`,
      );
    }

    return chunks.map((chunk, i): ChunkInput => {
      const embedding = embeddings[i];
      if (embedding === undefined) {
        throw new Error(`missing embedding for chunk ord=${chunk.ord}`);
      }
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `embedding dimension mismatch for chunk ord=${chunk.ord}: ` +
            `got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`,
        );
      }
      return {
        ord: chunk.ord,
        content: chunk.content,
        tokenCount: approximateTokenCount(chunk.content),
        embedding,
      };
    });
  }

  /** Embed `texts` in fixed-size batches, preserving input order in the output. */
  private async embedBatched(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await this.embedder.embed(batch);
      if (vectors.length !== batch.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for a batch of ${batch.length}`,
        );
      }
      for (const v of vectors) out.push(v);
    }
    return out;
  }

}

// -----------------------------------------------------------------------------
// Internal material shape shared by both ingestion paths.
// -----------------------------------------------------------------------------

/**
 * The persistable + chunkable fields of a material, source-agnostic. Canvas
 * materials and uploads both reduce to this before upsert/chunk/embed, so the
 * core pipeline never branches on origin.
 */
interface MaterialParts {
  /** Source namespace: 'canvas' for synced material, 'upload' for manual. */
  readonly sourceType: string;
  readonly externalId: string;
  readonly title: string;
  readonly kind: string;
  readonly markdown: string;
  readonly contentHash: string;
  readonly uri?: string;
}

/** Reduce a Canvas `NormalizedMaterial` to the source-agnostic `MaterialParts`. */
function toParts(material: NormalizedMaterial): MaterialParts {
  return {
    sourceType: material.sourceType,
    externalId: material.externalId,
    title: material.title,
    kind: material.kind,
    markdown: material.markdown,
    contentHash: material.contentHash,
    ...(material.uri !== undefined ? { uri: material.uri } : {}),
  };
}
