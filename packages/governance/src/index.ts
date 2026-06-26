/**
 * `@vta/governance` — the centerpiece policy engine.
 *
 * It enforces a DUAL requirement at THREE chokepoints, as code rather than
 * prompt text: never leak what must stay private, and correctly answer what it
 * should. The three gates are:
 *   - INGRESS  ({@link IngressGovernor}) — prompt-injection block + input PII
 *     redaction, before the model runs.
 *   - TOOLGATE ({@link ToolGate}) — a structural, DEFAULT-DENY allowlist for the
 *     agent's `beforeToolCall` hook.
 *   - EGRESS   ({@link EgressGovernor}) — grounding (no source, no claim),
 *     content boundaries (grades / homework / off-topic), output PII scan, and a
 *     moderation seam, before any answer is returned.
 *
 * The heavy ML guardrails are pluggable via `./ports.js`: ship the working
 * defaults from `./defaults.js` now, and swap in Prompt Guard 2 / Presidio /
 * Llama Guard / Azure Content Safety later by changing the injected
 * implementations — no edit to the governors required.
 *
 * This package depends on `@vta/tenancy` (for `ContentRules`) and `@vta/audit`
 * (for `GovernanceVerdict`/`makeVerdict`) but deliberately NOT on `@vta/llm`.
 */

// Ports — the swappable seams.
export type {
  InjectionDetector,
  InjectionResult,
  PiiRedactor,
  RedactionResult,
  LlmJudge,
} from './ports.js';

// Working default implementations of the ports.
export { HeuristicInjectionDetector, RegexPiiRedactor } from './defaults.js';

// Per-request context.
export type { GovernanceContext } from './context.js';

// Ingress chokepoint.
export { IngressGovernor, INGRESS_REFUSAL } from './ingress.js';
export type { IngressGovernorDeps, IngressDecision } from './ingress.js';

// Tool-gate chokepoint.
export { ToolGate, DEFAULT_ALLOWED_TOOLS } from './toolgate.js';
export type {
  ToolGateConfig,
  ToolGateDecision,
  ToolArgValidator,
} from './toolgate.js';

// Egress chokepoint.
export {
  EgressGovernor,
  HOMEWORK_REFUSAL,
  UNGROUNDED_REFUSAL,
} from './egress.js';
export type {
  EgressGovernorDeps,
  EgressRetrieval,
  EgressDecision,
} from './egress.js';
