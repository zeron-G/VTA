/**
 * OpenAI-hosted web search.
 *
 * Wraps the OpenAI Responses API `web_search` tool: OpenAI runs the search
 * server-side (the same model-provider-hosted approach Claude Code / Codex use)
 * and returns a synthesised answer with source URL citations. This needs NO
 * third-party search API and NO extra credential — it reuses the OpenAI key the
 * router already resolves for embeddings/fallback.
 *
 * It is deliberately standalone (not a chat `LlmProvider`/role): web search is a
 * TOOL capability, not a logical chat role. `@vta/core` builds one of these from
 * the resolved OpenAI key and injects its `search` into the web_search tool.
 */

import OpenAI from 'openai';
import { LlmUnavailableError, toError } from '@vta/shared';
import type { Citation } from '@vta/shared';

export interface OpenAiWebSearchOptions {
  /** OpenAI API key (the same `openai.api-key` used elsewhere). */
  readonly apiKey: string;
  /** Search-capable model. Defaults to a current OpenAI model. */
  readonly model?: string;
  /** Optional base URL override (must be an OpenAI Responses-compatible host). */
  readonly endpoint?: string;
}

/** The result of a web search: a synthesised answer plus source citations. */
export interface WebSearchResult {
  readonly text: string;
  readonly citations: Citation[];
}

const DEFAULT_MODEL = 'gpt-5.4-mini';

/** Minimal shape of the Responses output we read for URL citations. */
interface UrlAnnotation {
  readonly type?: string;
  readonly url?: string;
  readonly title?: string;
}
interface OutContentBlock {
  readonly annotations?: readonly UrlAnnotation[];
}
interface OutItem {
  readonly content?: readonly OutContentBlock[];
}

/** Pull `url_citation` annotations out of a Responses result, deduped by URL. */
function extractCitations(output: readonly OutItem[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const item of output) {
    for (const block of item.content ?? []) {
      for (const ann of block.annotations ?? []) {
        if (ann.type === 'url_citation' && typeof ann.url === 'string' && !seen.has(ann.url)) {
          seen.add(ann.url);
          citations.push({
            sourceId: ann.url,
            title: ann.title !== undefined && ann.title !== '' ? ann.title : ann.url,
            locator: ann.url,
          });
        }
      }
    }
  }
  return citations;
}

export class OpenAiWebSearch {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAiWebSearchOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.endpoint !== undefined ? { baseURL: options.endpoint } : {}),
    });
    this.model = options.model ?? DEFAULT_MODEL;
  }

  /** Run a web search and return a concise, source-cited answer. */
  async search(query: string): Promise<WebSearchResult> {
    try {
      const response = await this.client.responses.create({
        model: this.model,
        tools: [{ type: 'web_search' }] as OpenAI.Responses.Tool[],
        input:
          'Search the web and answer the following concisely with the key facts. ' +
          'Always include the source URLs you used.\n\nQuery: ' +
          query,
      });

      const text = response.output_text ?? '';
      const citations = extractCitations(
        (response.output ?? []) as unknown as OutItem[],
      );
      return { text, citations };
    } catch (err) {
      throw new LlmUnavailableError('web search failed', {
        model: this.model,
        cause: toError(err).message,
      });
    }
  }
}
