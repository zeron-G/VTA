/**
 * Egress chokepoint (governance stage `egress`).
 *
 * The last gate before any answer leaves the system. It enforces the dual
 * requirement at the OUTPUT boundary, in a fixed, defensible order:
 *
 *   (1) GROUNDING        — when the course requires citations and there are none,
 *                          refuse. No source -> no claim: the joint
 *                          anti-fabrication AND anti-leak control. (When a course
 *                          opts OUT of citations, grounding is not enforced but
 *                          that fact is recorded as a `flag` verdict.)
 *   (2) CONTENT BOUNDARIES — refuse grade inquiries, full homework solutions, and
 *                          off-topic answers per the course `ContentRules`, using
 *                          deterministic patterns AND (when injected) an
 *                          LLM-as-judge for the semantic call.
 *   (3) OUTPUT PII SCAN  — redact any PII that survived into the outbound text.
 *   (4) MODERATION       — a no-op seam today; TODO(swap) Llama Guard / Azure
 *                          Content Safety.
 *
 * FAIL-SAFE (load-bearing):
 *   - A judge/detector that THROWS or returns an unparseable answer is treated as
 *     `unknown`, NEVER as a pass. On the off-topic axis — which has no reliable
 *     deterministic floor — `unknown` REFUSES. On grades/homework `unknown` falls
 *     back to the deterministic patterns and emits a `flag`.
 *   - A PII-redactor error refuses rather than emit un-scanned text.
 *   - ANY unexpected error in `inspect` is caught and converted to a refusal, so
 *     a throw can never bypass the gates.
 *
 * Every refusal path emits a verdict for the audit log; the returned status is
 * one of `@vta/shared`'s `ReplyStatus` values.
 */

import { makeVerdict } from '@vta/audit';
import type { GovernanceVerdict } from '@vta/audit';
import type { Citation, ReplyStatus } from '@vta/shared';
import { toError } from '@vta/shared';

import type { GovernanceContext } from './context.js';
import type { LlmJudge, PiiRedactor } from './ports.js';

/** Refusal message for a request to produce a full homework solution. */
export const HOMEWORK_REFUSAL =
  'I can’t provide a complete solution to graded work. I can explain the underlying concepts, point you to the relevant course material, or help you debug your own attempt.';

/** Generic refusal used when grounding is required but missing (or on internal error). */
export const UNGROUNDED_REFUSAL =
  'I couldn’t find this in the course materials, so I can’t answer confidently. Please check the syllabus or ask your instructor.';

/** Dependencies injected into {@link EgressGovernor}. */
export interface EgressGovernorDeps {
  readonly pii: PiiRedactor;
  /** Optional LLM-as-judge for semantic content-boundary checks. */
  readonly judge?: LlmJudge;
}

/** The retrieval provenance accompanying an answer. */
export interface EgressRetrieval {
  readonly citations: readonly Citation[];
}

/** Outcome of an egress inspection. */
export interface EgressDecision {
  /** Final reply status. `answered` only when every gate passed. */
  readonly status: ReplyStatus;
  /** The final outbound text: a refusal message, or the (PII-scanned) answer. */
  readonly text: string;
  /** Citations to render with the answer (empty on refusal). */
  readonly citations: readonly Citation[];
  /** All verdicts produced at egress, for the audit log. */
  readonly verdicts: GovernanceVerdict[];
}

/** Tri-state result of a judge call: an explicit yes/no, or inconclusive. */
type JudgeResult = 'yes' | 'no' | 'unknown';

const STAGE = 'egress';

/* -------------------------------------------------------------------------- */
/* Deterministic content-boundary patterns                                    */
/* -------------------------------------------------------------------------- */

/**
 * Phrases that signal an ANSWER reveals/discusses an individual's grade. These
 * are answer-shaped (what a leak looks like), not question-shaped — the gate
 * inspects the candidate answer, so "your grade was 82%" must match, not just
 * "what grade did I get".
 */
const GRADE_PATTERNS: readonly RegExp[] = [
  // Answer-leak phrasings.
  /\b(?:your|his|her|their|the)\s+(?:grade|score|mark)\s+(?:is|was|=|:)/i,
  /\bscored?\s+\d+\s*(?:\/|out of|%|points)\b/i,
  /\b(?:you|they|he|she)\s+(?:got|earned|received|scored)\b[^.?!]{0,30}\b(?:\d{1,3}\s*%|\d+\s*\/\s*\d+|[A-DF][+-]?)\b/i,
  /\breceived\s+(?:an?\s+)?[A-DF][+-]?\b/i,
  // Request/topic phrasings (also worth refusing if echoed).
  /\b(?:my|his|her|their|the)\s+grade\b/i,
  /\bwhat\s+(?:grade|score|mark)\s+did\b/i,
  /\b(?:final|midterm|exam|assignment|course)\s+grade\b/i,
  /\bgrade(?:book)?\s+(?:for|of)\b/i,
  /\bdid\s+i\s+pass\b/i,
  /\bgpa\b/i,
];

/** Phrases that signal an answer is handing over a complete homework solution. */
const HOMEWORK_PATTERNS: readonly RegExp[] = [
  /\bhere(?:'s| is)\s+the\s+(?:full|complete|entire)\s+(?:solution|answer|code)\b/i,
  /\bthe\s+(?:complete|full)\s+solution\s+(?:is|to)\b/i,
  /\bsolution\s+to\s+(?:the\s+)?(?:homework|assignment|problem\s+set|pset|hw)\b/i,
  /\bfinal\s+answer\s*(?::|is)\b/i,
];

const Q_GRADES =
  'Does this assistant answer reveal or discuss an individual student’s grade, score, or GPA?';
const Q_HOMEWORK =
  'Does this assistant answer provide a full, ready-to-submit solution to graded homework or an assignment (as opposed to conceptual help)?';
const Q_OFFTOPIC =
  'Is this assistant answer unrelated to the academic course it is supposed to support (off-topic)?';

/** Returns `true` when any pattern matches. */
function matchAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

export class EgressGovernor {
  private readonly pii: PiiRedactor;
  private readonly judge: LlmJudge | undefined;

  constructor(deps: EgressGovernorDeps) {
    this.pii = deps.pii;
    this.judge = deps.judge;
  }

  /**
   * Inspect a candidate answer and decide what (if anything) may be returned.
   * Runs the four gates in order; the first refusal short-circuits. The whole
   * body is wrapped so ANY unexpected error fails safe (refusal), never a pass.
   */
  async inspect(
    answer: string,
    ctx: GovernanceContext,
    retrieval: EgressRetrieval,
  ): Promise<EgressDecision> {
    const verdicts: GovernanceVerdict[] = [];
    try {
      // Normalize provenance defensively — a missing/garbled retrieval object
      // must read as "no citations", never throw past the grounding gate.
      const citations: readonly Citation[] = Array.isArray(retrieval?.citations)
        ? retrieval.citations
        : [];

      // (1) GROUNDING — no source, no claim.
      if (ctx.rules.requireCitations) {
        if (citations.length === 0) {
          verdicts.push(
            makeVerdict(STAGE, 'grounding', 'block', 'answer has no citations but citations are required'),
          );
          return { status: 'refused', text: UNGROUNDED_REFUSAL, citations: [], verdicts };
        }
        verdicts.push(makeVerdict(STAGE, 'grounding', 'allow'));
      } else {
        // Grounding intentionally not enforced for this course — record it so the
        // audit log shows the guarantee was waived (it is not silently skipped).
        verdicts.push(
          makeVerdict(STAGE, 'grounding', 'flag', 'grounding not enforced (course requireCitations=false)'),
        );
      }

      // (2) CONTENT BOUNDARIES — grades / homework solutions / off-topic.
      const boundary = await this.checkContentBoundaries(answer, ctx, verdicts);
      if (boundary !== null) {
        return { status: boundary.status, text: boundary.text, citations: [], verdicts };
      }

      // (3) OUTPUT PII SCAN — last-line redaction of anything that slipped through.
      let outbound = answer;
      try {
        const { redacted, foundCount } = await this.pii.redact(answer);
        outbound = redacted;
        verdicts.push(
          makeVerdict(
            STAGE,
            'pii.egress',
            foundCount > 0 ? 'flag' : 'allow',
            foundCount > 0 ? `redacted ${foundCount} PII span(s) from answer` : undefined,
          ),
        );
      } catch (err) {
        // FAIL-SAFE: cannot guarantee the answer is PII-clean -> refuse to emit it.
        const reason = `output PII scan error (refusing to emit unscanned answer): ${toError(err).message}`;
        verdicts.push(makeVerdict(STAGE, 'pii.egress', 'block', reason));
        return { status: 'refused', text: UNGROUNDED_REFUSAL, citations: [], verdicts };
      }

      // (4) MODERATION — seam only today.
      verdicts.push(this.moderationSeam(outbound));

      // Return a defensive copy of citations so callers cannot mutate our input.
      return { status: 'answered', text: outbound, citations: [...citations], verdicts };
    } catch (err) {
      // FAIL-SAFE backstop: any unexpected throw becomes a refusal, never a pass.
      verdicts.push(
        makeVerdict(STAGE, 'internal', 'block', `egress internal error (default-deny): ${toError(err).message}`),
      );
      return { status: 'refused', text: UNGROUNDED_REFUSAL, citations: [], verdicts };
    }
  }

  /**
   * Content-boundary gate. Combines deterministic pattern checks with an optional
   * LLM-judge. Returns a refusal descriptor on violation, or `null` when within
   * bounds. Appends verdicts as a side effect.
   *
   * FAIL-SAFE by axis:
   *   - grades / homework: have a deterministic floor (patterns). An `unknown`
   *     judge result falls back to that floor and emits a `flag`.
   *   - off-topic: has NO reliable deterministic floor, so an `unknown` judge
   *     result (error or unparseable) REFUSES. Only an explicit `no` allows.
   *     When no judge is wired at all, off-topic cannot be evaluated -> `flag`
   *     and allow (an explicit, audited capability gap, not an error).
   */
  private async checkContentBoundaries(
    answer: string,
    ctx: GovernanceContext,
    verdicts: GovernanceVerdict[],
  ): Promise<{ status: ReplyStatus; text: string } | null> {
    const rules = ctx.rules;

    // --- Grades (deterministic floor + optional judge) ---
    if (rules.refuseGrades) {
      const deterministic = matchAny(GRADE_PATTERNS, answer);
      const jr: JudgeResult | 'no-judge' = this.judge
        ? await this.judgeBoundary('grades', answer, Q_GRADES, verdicts)
        : 'no-judge';
      if (deterministic || jr === 'yes') {
        verdicts.push(makeVerdict(STAGE, 'content.grades', 'block', 'answer touches individual grades'));
        return { status: 'refused', text: rules.gradeRedirectMessage };
      }
      if (jr === 'no-judge') {
        verdicts.push(
          makeVerdict(STAGE, 'content.grades', 'flag', 'no judge wired; grades evaluated by patterns only'),
        );
      } else if (jr === 'no') {
        verdicts.push(makeVerdict(STAGE, 'content.grades', 'allow'));
      }
      // jr === 'unknown' already emitted a flag in judgeBoundary; deterministic floor stands.
    }

    // --- Homework solutions (deterministic floor + optional judge) ---
    if (rules.refuseHomeworkSolutions) {
      const deterministic = matchAny(HOMEWORK_PATTERNS, answer);
      const jr: JudgeResult | 'no-judge' = this.judge
        ? await this.judgeBoundary('homework', answer, Q_HOMEWORK, verdicts)
        : 'no-judge';
      if (deterministic || jr === 'yes') {
        verdicts.push(
          makeVerdict(STAGE, 'content.homework', 'block', 'answer provides a full homework solution'),
        );
        return { status: 'refused', text: HOMEWORK_REFUSAL };
      }
      if (jr === 'no-judge') {
        verdicts.push(
          makeVerdict(STAGE, 'content.homework', 'flag', 'no judge wired; homework evaluated by patterns only'),
        );
      } else if (jr === 'no') {
        verdicts.push(makeVerdict(STAGE, 'content.homework', 'allow'));
      }
    }

    // --- Off-topic (NO deterministic floor — judge or nothing) ---
    if (rules.refuseOffTopic) {
      if (this.judge === undefined) {
        verdicts.push(
          makeVerdict(STAGE, 'content.offtopic', 'flag', 'no judge wired; off-topic not evaluated'),
        );
      } else {
        const jr = await this.judgeBoundary('offtopic', answer, Q_OFFTOPIC, verdicts);
        // FAIL-SAFE: with no deterministic backstop, a `yes` OR an inconclusive
        // (`unknown`: judge threw or returned garbage) both refuse.
        if (jr === 'yes' || jr === 'unknown') {
          verdicts.push(
            makeVerdict(
              STAGE,
              'content.offtopic',
              'block',
              jr === 'yes' ? 'answer is off-topic' : 'off-topic judge inconclusive; refusing (fail-safe)',
            ),
          );
          return { status: 'refused', text: rules.offTopicMessage };
        }
        verdicts.push(makeVerdict(STAGE, 'content.offtopic', 'allow'));
      }
    }

    return null;
  }

  /**
   * Ask the injected judge a single yes/no boundary question. The caller must
   * only call this when a judge is wired. Returns a tri-state:
   *   'yes'     — confident violation.
   *   'no'      — confident pass.
   *   'unknown' — judge threw OR returned an unparseable answer (emits a `flag`).
   *
   * The caller decides how to treat `unknown` per axis (deterministic floor for
   * grades/homework; refuse for off-topic).
   */
  private async judgeBoundary(
    axis: string,
    answer: string,
    question: string,
    verdicts: GovernanceVerdict[],
  ): Promise<JudgeResult> {
    const judge = this.judge;
    if (judge === undefined) return 'unknown';

    const system =
      'You are a strict content-safety judge for a university teaching assistant. ' +
      'Answer with exactly "yes" or "no" on the first line, optionally followed by a brief reason. ' +
      'When uncertain, answer "yes" (err toward refusing).';
    const user = `${question}\n\n--- ANSWER UNDER REVIEW ---\n${answer}`;

    try {
      const raw = await judge.judge(system, user);
      const parsed = parseJudge(raw);
      if (parsed === 'unknown') {
        verdicts.push(
          makeVerdict(STAGE, `content.${axis}.judge`, 'flag', 'judge response was unparseable (inconclusive)'),
        );
      }
      return parsed;
    } catch (err) {
      verdicts.push(
        makeVerdict(STAGE, `content.${axis}.judge`, 'flag', `judge error (inconclusive): ${toError(err).message}`),
      );
      return 'unknown';
    }
  }

  /**
   * Moderation seam. No-op default that always allows but leaves a `flag`-able
   * verdict point. Wire a real classifier here without touching the gate order.
   *
   * TODO(swap): Llama Guard or Azure AI Content Safety moderation; on a positive
   * hit, return a `block` verdict and have {@link inspect} refuse.
   */
  private moderationSeam(_text: string): GovernanceVerdict {
    return makeVerdict(STAGE, 'moderation', 'allow', 'no-op moderation seam (default)');
  }
}

/**
 * Parse a judge completion into a tri-state. Looks only at the first line:
 *   - leading affirmative token -> 'yes'
 *   - leading negative token    -> 'no'
 *   - anything else (empty, garbled, JSON, "I cannot determine") -> 'unknown'
 *
 * Crucially, 'unknown' is distinct from 'no': the caller fails SAFE on 'unknown'
 * for axes without a deterministic floor, instead of treating noise as a pass.
 */
function parseJudge(raw: string): JudgeResult {
  const firstLine = (typeof raw === 'string' ? raw : '').trim().split(/\r?\n/, 1)[0] ?? '';
  if (/^\s*(?:yes|y|true|1)\b/i.test(firstLine)) return 'yes';
  if (/^\s*(?:no|n|false|0)\b/i.test(firstLine)) return 'no';
  return 'unknown';
}
