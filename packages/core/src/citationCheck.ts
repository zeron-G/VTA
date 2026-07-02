/**
 * Citation verification — the deterministic anti-hallucination guarantee for
 * web-sourced answers.
 *
 * The agent is instructed to cite only the exact URLs the web_search tool listed
 * back to it. This function ENFORCES that: it cross-checks every http(s) URL in
 * the answer against the set of URLs carried by the real captured citations
 * (retrieve citations have no URL and are ignored here — the fabrication-prone
 * kind is web links). Any URL the model emitted that is NOT a real captured
 * source is replaced with a neutral marker so a fabricated link never reaches a
 * student, and the caller records a governance verdict.
 *
 * This is intentionally NOT an LLM step: it is a cheap, deterministic membership
 * check that cannot itself hallucinate.
 */

import type { Citation } from '@vta/shared';

/** Marker substituted for a URL that does not correspond to a real source. */
export const UNVERIFIED_SOURCE_MARKER = '[unverified source removed]';

/** Matches bare/inline http(s) URLs (stops at whitespace and common delimiters). */
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/gi;

export interface CitationCheckResult {
  /** The answer text with any non-real URL replaced by {@link UNVERIFIED_SOURCE_MARKER}. */
  readonly text: string;
  /** How many distinct URL occurrences were stripped as unverifiable. */
  readonly fabricatedCount: number;
}

/** Normalize a URL for comparison: drop trailing slash + lowercase. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/** Trailing punctuation the URL regex may greedily include. */
function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?]+$/, '');
}

/**
 * Verify the URLs cited in `answer` against the real captured `citations`.
 * Returns the (possibly cleaned) text and the count of stripped fabrications.
 */
export function verifyCitations(
  answer: string,
  citations: readonly Citation[],
): CitationCheckResult {
  // Allowed URLs come from real captured citations. Web citations carry the URL
  // in both sourceId and locator; course citations carry a material uuid (not a
  // URL) and therefore contribute nothing here.
  const allowed = new Set<string>();
  for (const c of citations) {
    for (const value of [c.sourceId, c.locator]) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        allowed.add(normalizeUrl(stripTrailingPunct(value)));
      }
    }
  }

  let fabricatedCount = 0;
  const cleaned = answer.replace(URL_RE, (raw) => {
    if (allowed.has(normalizeUrl(stripTrailingPunct(raw)))) return raw;
    fabricatedCount += 1;
    return UNVERIFIED_SOURCE_MARKER;
  });

  return { text: fabricatedCount > 0 ? cleaned : answer, fabricatedCount };
}
