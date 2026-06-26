/**
 * Unit tests for the {@link EgressGovernor} fail-safe behavior.
 *
 * Pure logic only: the LlmJudge and PiiRedactor ports are injected fakes, so
 * there is no DB / LLM / network. These pin the load-bearing fail-safe contract:
 * a missing citation refuses, a THROWING off-topic judge refuses (no
 * deterministic floor on that axis), and a clean grounded answer is answered.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTENT_RULES } from '@vta/tenancy';

import { EgressGovernor, UNGROUNDED_REFUSAL } from './egress.js';
import type { GovernanceContext } from './context.js';
import type { LlmJudge, PiiRedactor } from './ports.js';

/** A trivial redactor that never finds PII (so it never alters the answer). */
const NOOP_PII: PiiRedactor = {
  redact: (text: string) => Promise.resolve({ redacted: text, foundCount: 0 }),
};

/** Build a context with the real conservative default content rules. */
const CTX: GovernanceContext = {
  courseId: 'course-1',
  role: 'standard',
  rules: DEFAULT_CONTENT_RULES,
  requestId: 'req-1',
};

/** A judge that always answers "no" (no violation on any boundary axis). */
const JUDGE_SAYS_NO: LlmJudge = {
  judge: () => Promise.resolve('no'),
};

/** A judge that throws on every call — exercises the fail-safe `unknown` path. */
const JUDGE_THROWS: LlmJudge = {
  judge: () => Promise.reject(new Error('judge backend unavailable')),
};

describe('EgressGovernor fail-safe', () => {
  it('refuses when citations are required but none are provided', async () => {
    const gov = new EgressGovernor({ pii: NOOP_PII, judge: JUDGE_SAYS_NO });

    const decision = await gov.inspect(
      'Photosynthesis converts light into chemical energy.',
      CTX,
      { citations: [] },
    );

    expect(decision.status).toBe('refused');
    expect(decision.text).toBe(UNGROUNDED_REFUSAL);
    expect(decision.citations).toHaveLength(0);
    expect(
      decision.verdicts.some(
        (v) => v.check === 'grounding' && v.decision === 'block',
      ),
    ).toBe(true);
  });

  it('refuses (fail-safe) when the off-topic judge throws — no deterministic floor', async () => {
    const gov = new EgressGovernor({ pii: NOOP_PII, judge: JUDGE_THROWS });

    // Citations present so grounding passes; the failure must come from the
    // off-topic axis where a throwing judge is `unknown` and `unknown` refuses.
    const decision = await gov.inspect(
      'The capital of France is Paris.',
      CTX,
      { citations: [{ sourceId: 'm1', title: 'Geography Notes' }] },
    );

    expect(decision.status).toBe('refused');
    expect(decision.text).toBe(CTX.rules.offTopicMessage);
    expect(
      decision.verdicts.some(
        (v) => v.check === 'content.offtopic' && v.decision === 'block',
      ),
    ).toBe(true);
  });

  it('answers a clean, grounded answer when citations exist and the judge says no', async () => {
    const gov = new EgressGovernor({ pii: NOOP_PII, judge: JUDGE_SAYS_NO });

    const answer =
      'A binary search halves the search space each step, giving O(log n) time on a sorted array.';
    const decision = await gov.inspect(answer, CTX, {
      citations: [{ sourceId: 'm1', title: 'Algorithms, Lecture 3' }],
    });

    expect(decision.status).toBe('answered');
    expect(decision.text).toBe(answer);
    expect(decision.citations).toHaveLength(1);
    expect(decision.citations[0]?.sourceId).toBe('m1');
  });
});
