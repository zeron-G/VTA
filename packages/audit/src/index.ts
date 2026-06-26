/**
 * `@vta/audit` — the durable, append-only audit / FERPA §99.32-style disclosure
 * log writer. Every handled interaction and every governance verdict is
 * recorded here, with text that has ALREADY been redacted by the caller.
 *
 * Public surface:
 *   - vocabulary: `GovernanceStage`, `GovernanceDecision`, `GovernanceVerdict`,
 *     `AuditEntry` — the shapes governance emits and core collects.
 *   - writer:     `AuditService` (+ `AuditLimits`, `AuditServiceOptions`,
 *     `DEFAULT_AUDIT_LIMITS`) and the `makeVerdict` helper.
 */

export type {
  GovernanceStage,
  GovernanceDecision,
  GovernanceVerdict,
  AuditEntry,
} from "./types.js";

export {
  AuditService,
  makeVerdict,
  DEFAULT_AUDIT_LIMITS,
} from "./auditService.js";
export type {
  AuditLimits,
  AuditServiceOptions,
} from "./auditService.js";
