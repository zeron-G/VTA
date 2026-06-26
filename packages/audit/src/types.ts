/**
 * The shared audit vocabulary: the governance-verdict record and the audit
 * entry that the rest of the system produces and this package persists.
 *
 * These types are intentionally provider-agnostic and free of any database
 * concern — `@vta/governance` emits {@link GovernanceVerdict}s, `@vta/core`
 * collects them into an {@link AuditEntry}, and {@link import('./auditService.js').AuditService}
 * maps that entry onto the durable `audit_log` row shape from `@vta/data`.
 */

import type { ChannelKind, ReplyStatus, CourseId, UserId } from "@vta/shared";

/**
 * The three governance checkpoints in a request's lifecycle:
 *  - `ingress`  — before the model runs (input policy, prompt-injection, scope).
 *  - `toolgate` — when the agent attempts a tool call (allow/deny per policy).
 *  - `egress`   — before the answer is returned (grounding, PII, safety).
 */
export type GovernanceStage = "ingress" | "toolgate" | "egress";

/** The outcome a single governance check reaches. */
export type GovernanceDecision = "allow" | "block" | "flag";

/**
 * One governance decision, as emitted by `@vta/governance` and collected by
 * `@vta/core`. This is the canonical shape stored (as JSON) in the audit log's
 * `verdicts` column.
 */
export interface GovernanceVerdict {
  /** Which checkpoint produced this verdict. */
  readonly stage: GovernanceStage;
  /** Stable identifier of the check, e.g. "grounding", "pii.egress", "tool.web_search". */
  readonly check: string;
  /** The decision the check reached. */
  readonly decision: GovernanceDecision;
  /** Optional human-readable reason (must already be free of raw PII). */
  readonly reason?: string;
  /** ISO-8601 timestamp of when the verdict was reached. */
  readonly at: string;
}

/**
 * A complete record of one handled interaction, ready to be written to the
 * durable disclosure log.
 *
 * IMPORTANT — REDACTION INVARIANT:
 * `question` and `answer` MUST already be redacted of PII by the caller
 * (`@vta/core`/`@vta/governance`). This package is a WRITER, not a redactor: it
 * persists exactly the text it is given (subject only to a defensive length
 * cap). Passing un-redacted text here is a contract violation and will store
 * PII in the system of record. Any `reason` strings inside `verdicts` are held
 * to the same standard.
 */
export interface AuditEntry {
  /** Tenant (course) this interaction belongs to. */
  readonly courseId: CourseId;
  /** Acting user, if known. Omit/undefined for system-originated entries. */
  readonly userId?: UserId;
  /** Channel the request arrived on. */
  readonly channel: ChannelKind;
  /** Correlates this entry with operational logs/traces for the same request. */
  readonly requestId: string;
  /** REDACTED question text. */
  readonly question: string;
  /** REDACTED answer text. */
  readonly answer: string;
  /** Final status of the interaction. */
  readonly status: ReplyStatus;
  /** All governance verdicts collected across the request lifecycle. */
  readonly verdicts: readonly GovernanceVerdict[];
}
