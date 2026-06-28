/**
 * Unit tests for the `web_search` tool — it must forward the query to the
 * injected backend, surface its text, and degrade gracefully on empty results.
 */

import { describe, it, expect } from 'vitest';

import { createWebSearchTool } from './webSearchTool.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = { courseId: 'course-1', role: 'standard' };

describe('createWebSearchTool', () => {
  it('forwards the query to the backend and returns its text + structured data', async () => {
    let seen = '';
    const tool = createWebSearchTool((query) => {
      seen = query;
      return Promise.resolve({
        text: 'Paris is the capital of France.',
        citations: [{ sourceId: 'https://example.org', title: 'Example' }],
      });
    });

    const parsed = tool.parameters.parse({ query: 'capital of France' });
    const out = await tool.execute(parsed, ctx);

    expect(seen).toBe('capital of France');
    expect(out.content).toContain('Paris');
    expect(out.data).toBeDefined();
  });

  it('returns a "no results" message when the backend yields empty text', async () => {
    const tool = createWebSearchTool(() => Promise.resolve({ text: '   ', citations: [] }));
    const out = await tool.execute({ query: 'obscure query' }, ctx);
    expect(out.content).toBe('No web results were found for this query.');
  });

  it('rejects an empty query at the schema', () => {
    const tool = createWebSearchTool(() => Promise.resolve({ text: 'x', citations: [] }));
    expect(tool.parameters.safeParse({ query: '' }).success).toBe(false);
  });
});
