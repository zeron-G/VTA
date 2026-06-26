/**
 * Unit tests for the deterministic Markdown chunker.
 *
 * Pure logic only: `chunkMarkdown` has no I/O. These pin the three load-bearing
 * guarantees — content is never dropped, the size ceiling holds, and ordinals
 * are emitted in order.
 */

import { describe, expect, it } from 'vitest';

import { chunkMarkdown } from './chunking.js';

/**
 * A multi-section Markdown document long enough to span several chunks at a
 * small ceiling. Built deterministically so assertions are stable.
 */
function sampleDoc(): string {
  const sections: string[] = [];
  for (let i = 1; i <= 8; i += 1) {
    sections.push(
      `## Section ${i}\n\n` +
        `This is the body of section ${i}. ` +
        'It contains several sentences so the packing loop has to make real ' +
        `decisions about where to break. Token marker S${i}END appears once.`,
    );
  }
  return sections.join('\n\n');
}

/** Split into significant word tokens (drop punctuation-only fragments). */
function tokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9]/g, ''))
    .filter((t) => t.length > 0);
}

describe('chunkMarkdown', () => {
  it('never drops content (every input token survives into some chunk)', () => {
    const doc = sampleDoc();
    const chunks = chunkMarkdown(doc, { maxChars: 300, overlapChars: 40 });
    const haystack = chunks.map((c) => c.content).join('\n');

    for (const tok of tokens(doc)) {
      expect(haystack).toContain(tok);
    }
    // Each per-section unique marker must appear (no whole section dropped).
    for (let i = 1; i <= 8; i += 1) {
      expect(haystack).toContain(`S${i}END`);
    }
  });

  it('respects the maxChars ceiling on every chunk, even when a block is oversized', () => {
    const maxChars = 200;
    // A single block far larger than the ceiling forces a hard-split.
    const giant = 'word '.repeat(400).trim();
    const doc = `# Heading\n\n${giant}\n\nShort tail paragraph.`;

    const chunks = chunkMarkdown(doc, { maxChars, overlapChars: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('returns ord values in ascending, gapless order starting at 0', () => {
    const chunks = chunkMarkdown(sampleDoc(), { maxChars: 250, overlapChars: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.ord).toBe(i);
    });
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n  \t ')).toEqual([]);
  });
});
