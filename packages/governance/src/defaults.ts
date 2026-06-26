/**
 * Working default implementations of the governance ports.
 *
 * These are deliberately simple, dependency-free, in-process baselines: they
 * give the system a real, functioning guardrail TODAY without provisioning any
 * external ML service, and they are easy to reason about and test. Each carries
 * an explicit `TODO(swap)` pointing at the production-grade component that
 * should replace it. Because everything is expressed through the `./ports.js`
 * interfaces, swapping is a wiring change, not a rewrite.
 *
 * Limitations are intentional and documented inline: heuristics catch the
 * obvious, high-frequency cases and nothing more. They are a floor, not a
 * ceiling.
 */

import type {
  InjectionDetector,
  InjectionResult,
  PiiRedactor,
  RedactionResult,
} from './ports.js';

/* -------------------------------------------------------------------------- */
/* Injection detection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A single jailbreak/injection signature. `weight` lets a few strong phrases
 * trip the detector on their own while weaker, noisier signals must co-occur.
 */
interface InjectionSignature {
  readonly pattern: RegExp;
  readonly weight: number;
  readonly label: string;
}

/**
 * Common prompt-injection / jailbreak signatures. Case-insensitive. This list
 * is the well-known surface (instruction override, system-prompt exfiltration,
 * persona reset, delimiter escapes); it is NOT exhaustive and is NOT a
 * substitute for a trained classifier.
 *
 * TODO(swap): replace the whole signature set with Meta Prompt Guard 2 or Azure
 * AI Content Safety "Prompt Shields", surfaced through {@link InjectionDetector}.
 */
const INJECTION_SIGNATURES: readonly InjectionSignature[] = [
  // Instruction-override family.
  { pattern: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|messages?|rules?)\b/i, weight: 1, label: 'ignore-previous-instructions' },
  { pattern: /\bdisregard\s+(?:all\s+|the\s+|your\s+)?(?:previous|prior|above)?\s*(?:instructions?|rules?|guidelines?)\b/i, weight: 1, label: 'disregard-instructions' },
  { pattern: /\bforget\s+(?:everything|all|your)\b.*\b(?:instructions?|rules?|told)\b/i, weight: 1, label: 'forget-instructions' },
  { pattern: /\boverride\s+(?:your\s+|the\s+)?(?:system\s+)?(?:instructions?|prompt|rules?|safety)\b/i, weight: 1, label: 'override-rules' },

  // System-prompt / configuration exfiltration.
  { pattern: /\b(?:reveal|show|print|repeat|expose|leak|tell\s+me)\b[^.?!]{0,40}\b(?:your\s+)?(?:system\s+prompt|instructions?|configuration|config|guidelines?|rules?)\b/i, weight: 1, label: 'exfiltrate-system-prompt' },
  { pattern: /\bwhat\s+(?:is|are|were)\b[^.?!]{0,30}\b(?:your\s+)?(?:system\s+prompt|initial\s+instructions?|original\s+instructions?)\b/i, weight: 1, label: 'ask-system-prompt' },
  { pattern: /\bsystem\s+prompt\b/i, weight: 0.5, label: 'mentions-system-prompt' },

  // Persona / role override ("you are now ...", DAN-style, developer mode).
  { pattern: /\byou\s+are\s+now\b/i, weight: 0.6, label: 'persona-reset' },
  { pattern: /\b(?:act|behave|pretend|roleplay)\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a\s+|an\s+|the\s+)?(?:different|unrestricted|jailbroken|developer|dan|do\s+anything)\b/i, weight: 0.8, label: 'role-override' },
  { pattern: /\b(?:developer|debug|god|admin|sudo)\s+mode\b/i, weight: 0.7, label: 'privileged-mode' },
  { pattern: /\bfrom\s+now\s+on\b[^.?!]{0,40}\b(?:you|respond|answer|ignore)\b/i, weight: 0.6, label: 'from-now-on' },

  // Guardrail nullification.
  { pattern: /\b(?:no|without|bypass|disable|turn\s+off)\b[^.?!]{0,20}\b(?:restrictions?|filters?|rules?|guardrails?|safety|limits?)\b/i, weight: 0.7, label: 'disable-guardrails' },

  // Delimiter / role-tag escape attempts.
  { pattern: /(?:<\|(?:im_start|im_end|system|endoftext|assistant|user)\|>|```\s*system|\[\/?(?:system|inst)\]|<\/?(?:system|s)>)/i, weight: 0.8, label: 'delimiter-escape' },
];

/** Signatures whose combined weight at/above this threshold flips `injection` to true. */
const INJECTION_THRESHOLD = 1;

/**
 * Heuristic, pattern-based prompt-injection detector. Stateless and synchronous
 * internally, but conforms to the async {@link InjectionDetector} port so a
 * network-backed classifier is a drop-in replacement.
 *
 * Scoring: each matched signature adds its weight; the result `score` is the
 * total clamped to `[0, 1]`. `injection` is `true` once the total reaches
 * {@link INJECTION_THRESHOLD}.
 *
 * TODO(swap): Meta Prompt Guard 2 / Azure AI Content Safety Prompt Shields.
 */
export class HeuristicInjectionDetector implements InjectionDetector {
   
  async detect(text: string): Promise<InjectionResult> {
    if (typeof text !== 'string' || text.trim() === '') {
      return { injection: false, score: 0 };
    }

    let total = 0;
    const labels: string[] = [];
    for (const sig of INJECTION_SIGNATURES) {
      if (sig.pattern.test(text)) {
        total += sig.weight;
        labels.push(sig.label);
      }
    }

    const score = Math.min(1, total);
    const injection = total >= INJECTION_THRESHOLD;
    if (!injection) {
      return { injection: false, score };
    }
    return {
      injection: true,
      score,
      // Labels only — never echo the offending user text into the audit log.
      reason: `heuristic injection signals: ${labels.join(', ')}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* PII redaction                                                              */
/* -------------------------------------------------------------------------- */

/** One PII rule: a global, case-insensitive matcher and its placeholder token. */
interface PiiRule {
  readonly pattern: RegExp;
  readonly placeholder: string;
  /**
   * Optional predicate: when present, a regex match is only redacted if this
   * returns true. Lets a broad pattern (JHED-style) skip obvious false-positives
   * (common course words like "chapter12").
   */
  readonly shouldRedact?: (match: string) => boolean;
}

/**
 * Common "letters + number" tokens that LOOK like a JHED login but are ordinary
 * course vocabulary ("chapter12", "figure3", "week5"). The JHED rule skips these
 * so it doesn't corrupt legitimate answer text. (Presidio's NER would not need
 * this heuristic.)
 */
const JHED_FALSE_POSITIVE_PREFIXES: ReadonlySet<string> = new Set([
  'chapter', 'chap', 'ch', 'figure', 'fig', 'section', 'sec', 'lab', 'problem',
  'exercise', 'ex', 'module', 'mod', 'week', 'page', 'pg', 'slide', 'table',
  'tbl', 'part', 'step', 'unit', 'eq', 'question', 'q', 'answer', 'version', 'v',
  'vol', 'appendix', 'quiz', 'lecture', 'lec', 'note', 'notes', 'assignment',
  'hw', 'pset', 'day', 'room', 'fall', 'spring', 'summer', 'winter',
]);

/** True when a JHED-shaped token is really a common course word, e.g. "chapter12". */
function isJhedFalsePositive(token: string): boolean {
  const match = /^([a-z]+)\d+$/i.exec(token);
  const prefix = match?.[1];
  if (prefix === undefined) return false;
  return JHED_FALSE_POSITIVE_PREFIXES.has(prefix.toLowerCase());
}

/**
 * Regex PII rules covering the formats this deployment handles: email addresses,
 * North-American phone numbers, US-SSN-shaped numbers (separated AND compact),
 * and JHED-style institutional ids. All patterns are `g`-flagged.
 *
 * Order matters: more specific / higher-risk patterns (SSN, email) run before
 * looser ones (phone, JHED). Compact (separator-less) SSN/phone variants are
 * included because at egress an un-separated digit run is still a leak —
 * over-redacting a rare bare 9/10-digit number is the safe direction.
 *
 * TODO(swap): Microsoft Presidio (presidio-analyzer + presidio-anonymizer) for
 * context-aware NER-based detection (names, locations, etc.) far beyond regex.
 */
const PII_RULES: readonly PiiRule[] = [
  // US SSN, separated: 123-45-6789 or 123 45 6789.
  { pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, placeholder: '[REDACTED_SSN]' },
  // US SSN, compact: a standalone 9-digit run.
  { pattern: /\b\d{9}\b/g, placeholder: '[REDACTED_SSN]' },
  // Email addresses.
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '[REDACTED_EMAIL]',
  },
  // North-American phone, separated: +1 (123) 456-7890, 123-456-7890, 123.456.7890.
  {
    pattern: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    placeholder: '[REDACTED_PHONE]',
  },
  // North-American phone, compact: 10 digits, or 11 starting with 1.
  { pattern: /\b1?\d{10}\b/g, placeholder: '[REDACTED_PHONE]' },
  // JHED-style login id: letters + digits (jsmith42), skipping common course words.
  {
    pattern: /\b[a-z]{2,8}\d{1,4}\b/gi,
    placeholder: '[REDACTED_JHED]',
    shouldRedact: (m) => !isJhedFalsePositive(m),
  },
];

/**
 * Regex-based PII redactor conforming to the {@link PiiRedactor} port. Replaces
 * each detected span with a stable placeholder token and reports how many spans
 * were redacted across all rules.
 *
 * The fresh `RegExp` per rule per call avoids the lastIndex statefulness bug of
 * reusing a shared `g`-flagged regex across `.replace`/`.test` calls.
 *
 * TODO(swap): Microsoft Presidio for NER-based, context-aware detection.
 */
export class RegexPiiRedactor implements PiiRedactor {
   
  async redact(text: string): Promise<RedactionResult> {
    if (typeof text !== 'string' || text === '') {
      return { redacted: text ?? '', foundCount: 0 };
    }

    let redacted = text;
    let foundCount = 0;
    for (const rule of PII_RULES) {
      // Re-instantiate to reset lastIndex and keep this method reentrant.
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      redacted = redacted.replace(re, (match) => {
        if (rule.shouldRedact !== undefined && !rule.shouldRedact(match)) {
          return match;
        }
        foundCount += 1;
        return rule.placeholder;
      });
    }

    return { redacted, foundCount };
  }
}
