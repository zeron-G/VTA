/**
 * `@vta/tools` — the agent's LEAST-PRIVILEGE, READ-ONLY tool set for the Virtual
 * Teaching Assistant.
 *
 * The agent may ONLY read course information. There is deliberately no 'send',
 * write, exec, or filesystem tool: the model produces answer text, but
 * delivering it is the core/adapter's job, AFTER egress governance. Every tool
 * is tenant-scoped via the injected `ToolContext` (`courseId`), never via its
 * arguments, and the contract is framework-agnostic so a later wave can wrap it
 * for both the governance tool-gate and the Pi adapter.
 */

// Contract types.
export type { ToolContext, ToolResult, VtaTool } from './types.js';

// Individual tool factories.
export { createRetrieveTool } from './retrieveTool.js';
export { createCatalogLookupTool } from './catalogLookupTool.js';
export { createWebSearchTool } from './webSearchTool.js';
export type { WebSearchFn, WebSearchResultLike } from './webSearchTool.js';

import type { Db } from '@vta/data';
import type { RagRetriever } from '@vta/rag';

import { createRetrieveTool } from './retrieveTool.js';
import { createCatalogLookupTool } from './catalogLookupTool.js';
import { createWebSearchTool } from './webSearchTool.js';
import type { WebSearchFn } from './webSearchTool.js';
import type { VtaTool } from './types.js';

/** Dependencies needed to assemble the default read-only tool set. */
export interface DefaultToolsDeps {
  readonly retriever: RagRetriever;
  readonly db: Db;
  /**
   * Optional web-search backend. When provided, a `web_search` tool is added so
   * the agent can answer general / current questions the course materials do
   * not cover. Omit it to keep the tool set course-materials-only.
   */
  readonly webSearch?: WebSearchFn;
}

/**
 * Assemble the default read-only tool set, in a stable order:
 *   1. `retrieve`       — semantic search over course material.
 *   2. `catalog_lookup` — structured listing of what material exists.
 *   3. `web_search`     — public-web search (added only when a backend is injected).
 *
 * The returned tools are framework-agnostic `VtaTool`s; the caller is
 * responsible for wrapping them (tool-gate, Pi adapter) and for injecting the
 * per-request `ToolContext` at call time.
 */
export function createDefaultTools(deps: DefaultToolsDeps): VtaTool[] {
  const tools: VtaTool[] = [
    createRetrieveTool(deps.retriever),
    createCatalogLookupTool(deps.db),
  ];
  if (deps.webSearch !== undefined) {
    tools.push(createWebSearchTool(deps.webSearch));
  }
  return tools;
}
