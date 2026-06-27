/**
 * StaticFallbackAgent — the DEGRADED-BUT-SAFE fallback `CourseAgent`.
 *
 * When the primary (`PiAgent` + the LLM roles behind it) is unavailable, this
 * returns a fixed, safe "temporarily unavailable" reply. It performs NO I/O, has
 * NO tools, and runs NO subprocess — so it can never itself fail or leak.
 *
 * This replaces the earlier Codex-CLI fallback: the project authenticates with
 * API keys only (no Codex), so a fallback that shelled out to a `codex` binary
 * had nothing to run. A static reply is the correct permission-monotonic floor —
 * it has strictly less capability than the primary, and its output still flows
 * through the caller's egress governance like any other answer.
 */

import { createLogger } from '@vta/shared';
import type { Logger } from '@vta/shared';

import type { AgentInput, AgentOutput, CourseAgent } from './types.js';

/** Default reply when the primary agent path is unavailable. */
const DEFAULT_UNAVAILABLE_MESSAGE =
  "I'm temporarily unable to answer right now — the assistant's language model is " +
  'unavailable. Please try again in a few minutes, and let the teaching staff know ' +
  'if this keeps happening.';

/** Constructor dependencies for {@link StaticFallbackAgent}. */
export interface StaticFallbackAgentDeps {
  /** Override the user-facing message (defaults to a safe unavailable notice). */
  readonly message?: string;
  readonly logger?: Logger;
}

export class StaticFallbackAgent implements CourseAgent {
  private readonly message: string;
  private readonly log: Logger;

  constructor(deps: StaticFallbackAgentDeps = {}) {
    this.message = deps.message ?? DEFAULT_UNAVAILABLE_MESSAGE;
    this.log = deps.logger ?? createLogger({ name: 'static-fallback-agent' });
  }

  answer(input: AgentInput): Promise<AgentOutput> {
    this.log.warn(
      { requestId: input.govContext.requestId },
      'serving static degraded fallback reply (primary agent unavailable)',
    );
    return Promise.resolve({
      text: this.message,
      citations: [],
      toolInvocations: [],
      governanceVerdicts: [],
    });
  }
}
