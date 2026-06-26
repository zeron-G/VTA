/**
 * Ingress chokepoint (governance stage `ingress`).
 *
 * This is the first of three gates. It runs over the UNTRUSTED inbound text
 * BEFORE the model ever sees it, and enforces both halves of the dual
 * requirement at the input boundary:
 *   1. Never let an attacker steer the assistant — detect prompt injection /
 *      jailbreak attempts and block them.
 *   2. Never let PII reach the model — redact it out of whatever text is
 *      allowed through.
 *
 * FAIL-SAFE: if the injection detector THROWS, we treat the request as blocked
 * (default-deny) and emit a `flag` verdict; we never let a detector failure
 * become an implicit "allow". A PII redactor failure likewise blocks rather
 * than forwarding un-redacted text to the model.
 */

import { makeVerdict } from '@vta/audit';
import type { GovernanceVerdict } from '@vta/audit';
import { toError } from '@vta/shared';

import type { GovernanceContext } from './context.js';
import type { InjectionDetector, PiiRedactor } from './ports.js';

/** Neutral, non-leaky refusal shown when input is blocked at ingress. */
export const INGRESS_REFUSAL =
  'I can only help with genuine questions about this course. Please rephrase your request.';

/** Dependencies injected into {@link IngressGovernor}. */
export interface IngressGovernorDeps {
  readonly injection: InjectionDetector;
  readonly pii: PiiRedactor;
}

/** Outcome of an ingress inspection. */
export interface IngressDecision {
  /** `true` when the (now-redacted) text may proceed to the model. */
  readonly allow: boolean;
  /**
   * The text to forward to the model. PII-redacted when allowed; the original
   * text is NEVER returned here when `allow` is false (callers must not forward
   * a blocked request anyway).
   */
  readonly redactedText: string;
  /** Present when `allow` is false: the neutral message to return to the user. */
  readonly refusal?: string;
  /** Verdicts to append to the audit log. Always at least one. */
  readonly verdicts: GovernanceVerdict[];
}

const STAGE = 'ingress';

export class IngressGovernor {
  private readonly injection: InjectionDetector;
  private readonly pii: PiiRedactor;

  constructor(deps: IngressGovernorDeps) {
    this.injection = deps.injection;
    this.pii = deps.pii;
  }

  /**
   * Inspect untrusted inbound text.
   *
   * Order:
   *   1. Injection detection. On a positive detection -> block. On a THROWN
   *      error -> block (default-deny) + `flag` verdict.
   *   2. PII redaction of the allowed text. On a THROWN error -> block +
   *      `flag` verdict (we refuse rather than risk forwarding raw PII).
   */
  // `_ctx` is reserved for future per-course injection sensitivity / rules.
  async inspect(text: string, _ctx: GovernanceContext): Promise<IngressDecision> {
    const verdicts: GovernanceVerdict[] = [];

    // (1) Prompt-injection / jailbreak detection (fail-safe).
    try {
      const result = await this.injection.detect(text);
      if (result.injection) {
        // A swapped detector's `reason` could echo user text; redact it before it
        // lands in the FERPA audit log (the audit redaction invariant extends to
        // verdict reason strings).
        const reason = await this.safeReason(result.reason);
        verdicts.push(makeVerdict(STAGE, 'injection', 'block', reason));
        return {
          allow: false,
          redactedText: '',
          refusal: INGRESS_REFUSAL,
          verdicts,
        };
      }
      // Clean input: record an explicit allow so the audit trail is complete.
      verdicts.push(makeVerdict(STAGE, 'injection', 'allow'));
    } catch (err) {
      // FAIL-SAFE: a detector failure must default-deny, not silently pass.
      const reason = `injection detector error (default-deny): ${toError(err).message}`;
      verdicts.push(makeVerdict(STAGE, 'injection', 'flag', reason));
      return {
        allow: false,
        redactedText: '',
        refusal: INGRESS_REFUSAL,
        verdicts,
      };
    }

    // (2) Redact PII from the allowed text before it reaches the model (fail-safe).
    try {
      const { redacted, foundCount } = await this.pii.redact(text);
      verdicts.push(
        makeVerdict(
          STAGE,
          'pii.ingress',
          foundCount > 0 ? 'flag' : 'allow',
          foundCount > 0 ? `redacted ${foundCount} PII span(s) from input` : undefined,
        ),
      );
      return { allow: true, redactedText: redacted, verdicts };
    } catch (err) {
      // FAIL-SAFE: cannot guarantee redaction -> do not forward raw text.
      const reason = `PII redactor error (blocking to avoid leaking raw input): ${toError(err).message}`;
      verdicts.push(makeVerdict(STAGE, 'pii.ingress', 'flag', reason));
      return {
        allow: false,
        redactedText: '',
        refusal: INGRESS_REFUSAL,
        verdicts,
      };
    }
  }

  /**
   * Redact a detector's reason string before it enters the audit log, capped to
   * a sane length. Best-effort: on any redactor error, fall back to a fixed,
   * PII-free label rather than risk logging raw text.
   */
  private async safeReason(reason: string | undefined): Promise<string> {
    if (reason === undefined || reason === '') return 'prompt-injection detected';
    try {
      const { redacted } = await this.pii.redact(reason);
      return redacted.slice(0, 200);
    } catch {
      return 'prompt-injection detected';
    }
  }
}
