/**
 * `web_search` — read-only search of the PUBLIC web.
 *
 * Unlike the other tools this is NOT scoped to course materials: it answers
 * general / current-information questions the course content does not cover. It
 * is still strictly READ-ONLY (it cannot mutate anything or emit to a channel),
 * and its output — like every answer — still passes through egress governance.
 *
 * The actual search is INJECTED as a `WebSearchFn` so this package stays
 * framework- and provider-agnostic (`@vta/core` supplies an OpenAI-hosted
 * implementation). No course/tenant data is read here, so `ToolContext` is
 * intentionally unused.
 */

import { z } from 'zod';
import type { Citation } from '@vta/shared';

import type { ToolContext, ToolResult, VtaTool } from './types.js';

/** The shape a web-search backend returns. */
export interface WebSearchResultLike {
  readonly text: string;
  readonly citations: readonly Citation[];
}

/** An injected web-search backend: query -> synthesised answer + source citations. */
export type WebSearchFn = (query: string) => Promise<WebSearchResultLike>;

const webSearchParameters = z.object({
  /** The natural-language search query. Must be non-empty. */
  query: z.string().min(1),
});

type WebSearchArgs = z.infer<typeof webSearchParameters>;

/** Build the `web_search` tool bound to an injected search backend. */
export function createWebSearchTool(search: WebSearchFn): VtaTool<WebSearchArgs> {
  return {
    name: 'web_search',
    description:
      'Search the public web for current events or general knowledge NOT covered ' +
      "by this course's own materials. Returns a concise summary with source URLs. " +
      'Use it when the "retrieve" tool finds nothing relevant or the question is ' +
      'general background — but always prefer course materials when they answer ' +
      'the question, and make clear when an answer comes from the web rather than ' +
      'the course.',
    parameters: webSearchParameters,
    async execute(args: WebSearchArgs, _ctx: ToolContext): Promise<ToolResult> {
      const result = await search(args.query);
      if (result.text.trim() === '' && result.citations.length === 0) {
        return { content: 'No web results were found for this query.', data: result };
      }
      // Give the model an EXPLICIT, numbered source list with exact URLs so it
      // can build accurate APA references and cite ONLY these real URLs — never
      // invented ones. The verifier later cross-checks the answer's URLs against
      // exactly this set (carried on `data.citations`).
      const sourceLines = result.citations.map(
        (c, i) => `  [${i + 1}] ${c.title}${c.locator !== undefined ? ` — ${c.locator}` : ''} (${c.sourceId})`,
      );
      const content =
        result.text.trim() +
        (sourceLines.length > 0
          ? `\n\nWEB SOURCES (cite ONLY these exact URLs; do not invent others):\n${sourceLines.join('\n')}`
          : '');
      return { content, data: result };
    },
  };
}
