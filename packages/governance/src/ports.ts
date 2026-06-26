/**
 * Ports — the swappable seams of the governance layer.
 *
 * The heavy machine-learning guardrails (prompt-injection classifiers, PII
 * detection/redaction, an LLM-as-judge for content boundaries and groundedness)
 * are intentionally NOT implemented inside this package. Instead they are
 * expressed here as small, fully async interfaces that the application injects.
 *
 * Why this matters:
 *   - `@vta/governance` MUST NOT depend on `@vta/llm`. Coupling the policy
 *     engine to a concrete model/provider would make the most security-critical
 *     package in the system the hardest to test and the slowest to evolve.
 *   - These ports are the "provider-swappable seams": ship the working defaults
 *     from `./defaults.js` today, and later drop in Meta Prompt Guard 2 / Azure
 *     Prompt Shields (injection), Microsoft Presidio (PII), or Llama Guard /
 *     Azure Content Safety (judge + moderation) purely by changing the wiring —
 *     no edit to `ingress.ts` / `egress.ts` / `toolgate.ts` is required.
 *   - Everything is `Promise`-returning so a network-backed ML service is a
 *     drop-in replacement for the in-process heuristic defaults.
 *
 * FAIL-SAFE CONTRACT (binding on every implementation AND every caller):
 *   A port that THROWS must never be interpreted as "safe". The governors in
 *   this package treat a thrown error as the most restrictive plausible
 *   outcome (default-deny for injection, "unredacted, do not pass" for PII,
 *   "fall back to deterministic checks" for the judge) and always emit a
 *   `flag` verdict so the failure is visible in the audit log. Implementations
 *   are therefore free to throw on transient failure rather than inventing a
 *   misleading "all clear" result.
 */

/** Outcome of a prompt-injection / jailbreak detection pass over one text. */
export interface InjectionResult {
  /** `true` when the text is judged to be an injection / jailbreak attempt. */
  readonly injection: boolean;
  /** Optional confidence in `[0, 1]` (model-backed detectors); absent for heuristics. */
  readonly score?: number;
  /** Optional human-readable reason. MUST be free of raw PII (it lands in the audit log). */
  readonly reason?: string;
}

/**
 * Detects prompt-injection / jailbreak attempts in untrusted text.
 *
 * Default impl: {@link import('./defaults.js').HeuristicInjectionDetector}.
 * TODO(swap): Meta Prompt Guard 2 or Azure AI Content Safety "Prompt Shields".
 */
export interface InjectionDetector {
  detect(text: string): Promise<InjectionResult>;
}

/** Outcome of a PII redaction pass over one text. */
export interface RedactionResult {
  /** The text with detected PII replaced by stable placeholder tokens. */
  readonly redacted: string;
  /** How many PII spans were found and replaced. `0` means "nothing detected". */
  readonly foundCount: number;
}

/**
 * Finds and redacts personally identifiable information from text, so PII never
 * reaches the model (ingress) and never leaves in an answer (egress).
 *
 * Default impl: {@link import('./defaults.js').RegexPiiRedactor}.
 * TODO(swap): Microsoft Presidio (analyzer + anonymizer).
 */
export interface PiiRedactor {
  redact(text: string): Promise<RedactionResult>;
}

/**
 * An LLM-as-judge used for the soft, semantic governance checks that pattern
 * matching cannot reliably make on its own: content-boundary classification
 * (grades / homework solutions / off-topic) and answer groundedness.
 *
 * The contract is deliberately minimal — a system prompt, a user prompt, and a
 * plain-string completion — so any chat model can satisfy it without this
 * package importing a provider SDK. Callers parse the returned string (the
 * default judging prompts ask for a leading `yes`/`no`).
 *
 * Default: no judge is wired (`undefined`); the governors run deterministic
 * checks only.
 * TODO(swap): Llama Guard, Azure AI Content Safety, or `guard.judge` routed
 * through `@vta/llm` at the application layer.
 */
export interface LlmJudge {
  judge(system: string, user: string): Promise<string>;
}
