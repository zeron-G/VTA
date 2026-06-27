/**
 * Tool-gate chokepoint (governance stage `toolgate`).
 *
 * The single structural gate the Pi agent wires into its `beforeToolCall`
 * hook. Its job is narrow and absolute: decide whether the agent is permitted
 * to invoke a given tool at all. It is DEFAULT-DENY — any tool not on the
 * explicit allowlist is blocked, so a newly added or model-hallucinated tool
 * name can never be called until policy is updated to allow it.
 *
 * Pure and synchronous on purpose: a `beforeToolCall` hook runs in the hot path
 * of the agent loop, the decision must be deterministic and auditable, and a
 * structural allow/deny needs no I/O. Semantic checks belong at egress.
 */

import { makeVerdict } from '@vta/audit';
import type { GovernanceVerdict } from '@vta/audit';
import { ToolDeniedError } from '@vta/shared';

import type { GovernanceContext } from './context.js';

/**
 * The read-only tool set the assistant may use in Phase 1: retrieval over
 * course materials, the course catalog lookup, and a public web search. All are
 * side-effect-free reads; `retrieve`/`catalog_lookup` are tenant-scoped to the
 * course and `web_search` reads only the public web (no course/tenant data).
 * Nothing here can mutate state or emit to a channel.
 */
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  'retrieve',
  'catalog_lookup',
  'web_search',
];

/** Optional per-tool argument validator. Return `null` when valid, else a reason. */
export type ToolArgValidator = (args: unknown) => string | null;

/** Configuration for {@link ToolGate}. */
export interface ToolGateConfig {
  /** Tool names explicitly permitted. Defaults to {@link DEFAULT_ALLOWED_TOOLS}. */
  readonly allowedTools?: readonly string[];
  /**
   * Optional argument-shape validators keyed by tool name. A tool with no entry
   * is allowed through on name alone; an entry that returns a non-null reason
   * turns an otherwise-allowed call into a denial.
   */
  readonly argValidators?: Readonly<Record<string, ToolArgValidator>>;
}

/** The decision a tool-gate check reaches. */
export interface ToolGateDecision {
  /** `true` only when the tool is allowlisted AND its args (if validated) pass. */
  readonly allow: boolean;
  /** Present when `allow` is false: why the call was denied. */
  readonly reason?: string;
  /** The verdict to append to the audit log. */
  readonly verdict: GovernanceVerdict;
}

const STAGE = 'toolgate';

export class ToolGate {
  private readonly allowed: ReadonlySet<string>;
  private readonly argValidators: Readonly<Record<string, ToolArgValidator>>;

  constructor(config: ToolGateConfig = {}) {
    this.allowed = new Set(config.allowedTools ?? DEFAULT_ALLOWED_TOOLS);
    this.argValidators = config.argValidators ?? {};
  }

  /**
   * Decide whether `toolName` may be invoked with `args`.
   *
   * DEFAULT-DENY: unknown / non-allowlisted tools are blocked. When the tool is
   * allowlisted and an argument validator is registered for it, the args are
   * checked too. Every outcome (allow or deny) produces a `toolgate` verdict so
   * the audit log records what the agent tried to do.
   */
  check(toolName: string, args: unknown, ctx: GovernanceContext): ToolGateDecision {
    // The check label embeds the tool name so the audit log shows exactly which
    // tool was gated (e.g. "tool.retrieve"), matching the audit `check` convention.
    const check = `tool.${toolName}`;

    if (!this.allowed.has(toolName)) {
      const reason = `tool "${toolName}" is not on the allowlist`;
      return {
        allow: false,
        reason,
        verdict: makeVerdict(STAGE, check, 'block', reason),
      };
    }

    const validator = this.argValidators[toolName];
    if (validator !== undefined) {
      const argError = validator(args);
      if (argError !== null) {
        const reason = `invalid arguments for "${toolName}": ${argError}`;
        return {
          allow: false,
          reason,
          verdict: makeVerdict(STAGE, check, 'block', reason),
        };
      }
    }

    // `ctx` is accepted for future role-scoped tool policies (e.g. a tool only
    // a `privileged` TA may call). Referenced here so the parameter is not
    // flagged as unused under strict settings.
    void ctx.role;

    return {
      allow: true,
      verdict: makeVerdict(STAGE, check, 'allow'),
    };
  }

  /**
   * Enforcing variant: like {@link check}, but THROWS {@link ToolDeniedError}
   * (the typed `TOOL_DENIED` error from `@vta/shared`) on denial instead of
   * returning a decision. Convenient inside a `beforeToolCall` hook that wants
   * to abort the tool call by throwing. Returns the allow verdict on success so
   * the caller can still record it.
   */
  enforce(toolName: string, args: unknown, ctx: GovernanceContext): GovernanceVerdict {
    const decision = this.check(toolName, args, ctx);
    if (!decision.allow) {
      throw new ToolDeniedError(toolName, decision.reason ?? 'denied by tool gate');
    }
    return decision.verdict;
  }
}
