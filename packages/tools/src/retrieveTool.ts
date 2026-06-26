/**
 * `retrieve` — semantic search over a course's materials.
 *
 * This is the agent's primary grounding tool. It delegates to the hybrid
 * `RagRetriever` (dense + sparse, fused with RRF) and formats the result into a
 * single readable `content` string that INCLUDES the citations (title +
 * locator). The model only ever sees `content`, so the citations must be inline
 * for the model to ground its answer and cite sources.
 *
 * Tenancy: the course is taken STRICTLY from `ctx.courseId`. The tool's
 * arguments carry no course field, and even if the model invented one it would
 * be ignored — `retriever.retrieve` is called with `ctx.courseId` only.
 */

import { z } from 'zod';
import type { Citation } from '@vta/shared';
import type { RagRetriever, RetrievalResult } from '@vta/rag';

import type { ToolContext, ToolResult, VtaTool } from './types.js';

/** Validated arguments for the `retrieve` tool. */
const retrieveParameters = z.object({
  /** The natural-language search query. Must be non-empty. */
  query: z.string().min(1),
  /** Optional number of chunks to fetch (1..20). Falls back to the retriever default. */
  k: z.number().int().positive().max(20).optional(),
});

type RetrieveArgs = z.infer<typeof retrieveParameters>;

/**
 * Build the `retrieve` tool bound to a course-agnostic `RagRetriever`. The
 * retriever is stateless across courses; the per-call `courseId` comes from the
 * `ToolContext` at execution time, keeping the tool tenant-scoped.
 */
export function createRetrieveTool(retriever: RagRetriever): VtaTool<RetrieveArgs> {
  return {
    name: 'retrieve',
    description:
      'Semantic search over this course\'s materials (lecture notes, slides, ' +
      'pages, syllabus). Use it to find passages that answer a student\'s ' +
      'question, then ground your reply in the returned text and cite the ' +
      'listed sources. Returns the most relevant excerpts plus their citations.',
    parameters: retrieveParameters,
    async execute(args: RetrieveArgs, ctx: ToolContext): Promise<ToolResult> {
      // Tenant scope comes ONLY from ctx.courseId — never from args.
      const result = await retriever.retrieve(ctx.courseId, args.query, {
        ...(args.k !== undefined ? { k: args.k } : {}),
      });

      return {
        content: formatRetrieval(result),
        data: result,
      };
    },
  };
}

/**
 * Render a `RetrievalResult` into a self-contained string for the model: the
 * grounding excerpts first, then a numbered list of the citations (title +
 * locator) so the model can attribute each claim to a source.
 */
function formatRetrieval(result: RetrievalResult): string {
  if (result.chunks.length === 0) {
    return 'No matching course material was found for this query.';
  }

  const excerpts = result.chunks.map((chunk, i) => {
    const label = chunk.title ?? chunk.materialId;
    const where = chunk.locator !== undefined ? ` (${chunk.locator})` : '';
    return `[${i + 1}] ${label}${where}\n${chunk.content.trim()}`;
  });

  const sections = [`Retrieved ${result.chunks.length} excerpt(s):`, excerpts.join('\n\n')];

  const citationLines = formatCitations(result.citations);
  if (citationLines !== undefined) {
    sections.push(citationLines);
  }

  return sections.join('\n\n');
}

/**
 * Format the deduped citation list into a "Sources" block, or `undefined` when
 * there are none so the caller can omit the section entirely.
 */
function formatCitations(citations: readonly Citation[]): string | undefined {
  if (citations.length === 0) return undefined;
  const lines = citations.map((citation, i) => {
    const locator = citation.locator !== undefined ? ` — ${citation.locator}` : '';
    return `[${i + 1}] ${citation.title}${locator} (source: ${citation.sourceId})`;
  });
  return ['Sources:', lines.join('\n')].join('\n');
}
