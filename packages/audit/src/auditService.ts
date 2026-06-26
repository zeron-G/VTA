/**
 * `AuditService` — the thin, durable writer for the FERPA §99.32-style
 * disclosure log. It maps an {@link AuditEntry} (the vocabulary `@vta/core`
 * builds) onto the real `audit_log` insert shape exposed by
 * `@vta/data`'s {@link AuditRepository} and persists exactly one append-only row
 * per handled request.
 *
 * Responsibilities (intentionally narrow):
 *  - translate `AuditEntry` → `NewAuditLogRow`;
 *  - apply a DEFENSIVE length cap to `question`/`answer` (NOT redaction);
 *  - serialize verdicts into the `verdicts` JSON column.
 *
 * NON-responsibilities: this service does NOT redact PII. Redaction is the job
 * of `@vta/governance`/`@vta/core` and must happen before `append` is called.
 * See the redaction invariant on {@link AuditEntry}.
 */

import { AuditRepository } from "@vta/data";
import type { Db } from "@vta/data";
import type { AuditVerdicts, NewAuditLogRow } from "@vta/data";
import { createLogger } from "@vta/shared";
import type { Logger } from "@vta/shared";
import type {
  AuditEntry,
  GovernanceDecision,
  GovernanceStage,
  GovernanceVerdict,
} from "./types.js";

/**
 * Defensive truncation caps, mirroring the current system's character limits.
 * These are a backstop against pathological lengths — they are NOT a privacy
 * control and do NOT substitute for upstream redaction.
 */
export interface AuditLimits {
  /** Max stored characters for the (already-redacted) question. */
  readonly maxQuestionChars: number;
  /** Max stored characters for the (already-redacted) answer. */
  readonly maxAnswerChars: number;
}

/** Defaults mirror the current system's 300/500-character caps. */
export const DEFAULT_AUDIT_LIMITS: AuditLimits = {
  maxQuestionChars: 300,
  maxAnswerChars: 500,
};

/** Marker appended when a field is truncated, so reviewers can tell. */
const TRUNCATION_MARKER = "…[truncated]";

export interface AuditServiceOptions {
  /** Override the defensive length caps. Defaults to {@link DEFAULT_AUDIT_LIMITS}. */
  readonly limits?: Partial<AuditLimits>;
  /** Optional logger; a named child logger is created if omitted. */
  readonly logger?: Logger;
}

/**
 * Truncate `value` to at most `max` characters. When truncation happens, a
 * short marker is appended and the result is clamped so the final string never
 * exceeds `max`. Returns the input unchanged when it already fits.
 */
function capLength(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (TRUNCATION_MARKER.length >= max) {
    // Degenerate cap smaller than the marker itself — just hard-cut.
    return value.slice(0, max);
  }
  return value.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

export class AuditService {
  private readonly repo: AuditRepository;
  private readonly limits: AuditLimits;
  private readonly log: Logger;

  /**
   * Construct from an existing {@link AuditRepository} (preferred when the app
   * already wires one) or from a {@link Db} handle (a repository is built for
   * you).
   */
  constructor(source: AuditRepository | Db, options: AuditServiceOptions = {}) {
    this.repo =
      source instanceof AuditRepository ? source : new AuditRepository(source);
    this.limits = {
      maxQuestionChars:
        options.limits?.maxQuestionChars ?? DEFAULT_AUDIT_LIMITS.maxQuestionChars,
      maxAnswerChars:
        options.limits?.maxAnswerChars ?? DEFAULT_AUDIT_LIMITS.maxAnswerChars,
    };
    this.log = options.logger ?? createLogger({ name: "audit" });
  }

  /**
   * Persist exactly one audit entry.
   *
   * PRECONDITION: `entry.question` and `entry.answer` are already redacted of
   * PII by the caller. This method does not redact; it only applies a defensive
   * length cap. Do not pass raw student text here.
   */
  async append(entry: AuditEntry): Promise<void> {
    const row: NewAuditLogRow = {
      courseId: entry.courseId,
      // The column is nullable; `undefined` userId becomes SQL NULL.
      userId: entry.userId ?? null,
      channel: entry.channel,
      requestId: entry.requestId,
      question: capLength(entry.question, this.limits.maxQuestionChars),
      answer: capLength(entry.answer, this.limits.maxAnswerChars),
      status: entry.status,
      verdicts: toAuditVerdicts(entry.verdicts),
    };

    const stored = await this.repo.append(row);

    // Operational breadcrumb only — never the redacted Q/A text itself, to keep
    // PII out of operational logs (the audit_log row is the system of record).
    this.log.info(
      {
        auditId: stored.id,
        courseId: stored.courseId,
        requestId: stored.requestId,
        channel: stored.channel,
        status: stored.status,
        verdictCount: entry.verdicts.length,
      },
      "audit entry appended",
    );
  }
}

/**
 * Convert the strongly-typed verdict array into the loose `AuditVerdicts` JSON
 * shape stored in the `verdicts` column. We persist under a `verdicts` key so
 * the column can grow additional governance metadata later without a schema
 * change.
 */
function toAuditVerdicts(verdicts: readonly GovernanceVerdict[]): AuditVerdicts {
  return {
    verdicts: verdicts.map((v) => ({
      stage: v.stage,
      check: v.check,
      decision: v.decision,
      ...(v.reason !== undefined ? { reason: v.reason } : {}),
      at: v.at,
    })),
  };
}

/**
 * Build a {@link GovernanceVerdict}, stamping `at` with the current time.
 *
 * Timestamping with `new Date()` is acceptable here: this is application-layer
 * code, not a pure library. Callers that need deterministic timestamps may
 * construct the verdict object literally instead.
 */
export function makeVerdict(
  stage: GovernanceStage,
  check: string,
  decision: GovernanceDecision,
  reason?: string,
): GovernanceVerdict {
  return {
    stage,
    check,
    decision,
    ...(reason !== undefined ? { reason } : {}),
    at: new Date().toISOString(),
  };
}
