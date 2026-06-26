/**
 * `catalog_lookup` — a STRUCTURED complement to the semantic `retrieve` tool.
 *
 * Where `retrieve` answers "what does the material SAY about X", this answers
 * "what material EXISTS" — e.g. "list the modules", "is there a syllabus",
 * "what slides are posted". It runs a parameterized, course-scoped SELECT over
 * the `materials` table and returns title / kind / uri rows.
 *
 * Tenancy + safety (both load-bearing):
 *   - The query is ALWAYS filtered by `ctx.courseId`. There is no course field
 *     in the arguments, so the model cannot widen scope.
 *   - Every predicate is built with Drizzle operators (`eq`, `ilike`), which
 *     emit bound parameters — the optional `kind`/`query` values are NEVER
 *     string-interpolated into SQL, so they cannot be used for injection.
 *   - Read-only: a single SELECT, no mutation.
 */

import { and, eq, ilike } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, MaterialRow } from '@vta/data';
import { materials } from '@vta/data';

import type { ToolContext, ToolResult, VtaTool } from './types.js';

/** Maximum number of catalog rows returned in a single call. */
const MAX_ROWS = 50;

/** Validated arguments for the `catalog_lookup` tool. */
const catalogParameters = z.object({
  /** Optional exact material kind filter, e.g. 'page' | 'pdf' | 'slides' | 'syllabus'. */
  kind: z.string().optional(),
  /** Optional case-insensitive substring to match against the material title. */
  query: z.string().optional(),
});

type CatalogArgs = z.infer<typeof catalogParameters>;

/** The projected columns returned to the model (and surfaced as structured `data`). */
type CatalogRow = Pick<MaterialRow, 'title' | 'kind' | 'uri'>;

/**
 * Build the `catalog_lookup` tool bound to a `Db` handle. The course is supplied
 * per call via the `ToolContext`, so a single tool instance safely serves every
 * tenant without ever crossing course boundaries.
 */
export function createCatalogLookupTool(db: Db): VtaTool<CatalogArgs> {
  return {
    name: 'catalog_lookup',
    description:
      'List the course materials that exist, optionally filtered by kind ' +
      "(e.g. 'slides', 'pdf', 'syllabus') and/or a title substring. Use it for " +
      'structured questions like "what modules are posted?" or "is there a ' +
      'syllabus?" — for the CONTENTS of a material, use the retrieve tool instead. ' +
      'Returns each material\'s title, kind, and link (if any).',
    parameters: catalogParameters,
    async execute(args: CatalogArgs, ctx: ToolContext): Promise<ToolResult> {
      // Tenant predicate first — ALWAYS scoped to ctx.courseId, never to args.
      const predicates: SQL[] = [eq(materials.courseId, ctx.courseId)];

      // Optional exact-kind filter (bound parameter).
      const kind = args.kind?.trim();
      if (kind !== undefined && kind !== '') {
        predicates.push(eq(materials.kind, kind));
      }

      // Optional case-insensitive title match. `ilike` binds the pattern as a
      // parameter; we escape LIKE metacharacters so user input is treated as a
      // literal substring rather than a wildcard pattern.
      const titleQuery = args.query?.trim();
      if (titleQuery !== undefined && titleQuery !== '') {
        predicates.push(ilike(materials.title, `%${escapeLike(titleQuery)}%`));
      }

      // `and(...)` returns a single SQL for a non-empty list (predicates always
      // has the courseId clause). Avoids indexing (predicates[0] would be typed
      // SQL | undefined under noUncheckedIndexedAccess).
      const whereClause = and(...predicates);

      const rows = await db
        .select({
          title: materials.title,
          kind: materials.kind,
          uri: materials.uri,
        })
        .from(materials)
        .where(whereClause)
        .orderBy(materials.kind, materials.title)
        .limit(MAX_ROWS);

      return {
        content: formatCatalog(rows),
        data: rows,
      };
    },
  };
}

/**
 * Escape the LIKE/ILIKE wildcard metacharacters (`%`, `_`) and the default
 * escape character (`\`) so a user-supplied substring matches literally instead
 * of being interpreted as a pattern.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Render the catalog rows into a readable, model-facing string. */
function formatCatalog(rows: readonly CatalogRow[]): string {
  if (rows.length === 0) {
    return 'No course materials match this lookup.';
  }

  const lines = rows.map((row, i) => {
    const link = row.uri !== null && row.uri !== undefined ? ` — ${row.uri}` : '';
    return `[${i + 1}] ${row.title} (${row.kind})${link}`;
  });

  return [`Found ${rows.length} material(s):`, lines.join('\n')].join('\n');
}
