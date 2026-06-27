/**
 * `@vta/agent` — the governed, bounded tool-calling agent for the Virtual
 * Teaching Assistant.
 *
 * This package is OUR OWN orchestration loop on top of `@vta/llm`, with the
 * `@vta/governance` tool-gate enforced INLINE before every
 * tool execution — functionally a `beforeToolCall` hook, but in our code so the
 * cardinal invariant ("no tool runs unless the gate allowed it") is certain and
 * unit-testable. Three guarantees hold:
 *   1. No tool executes unless the tool-gate returned allow.
 *   2. The loop is hard-bounded — it can never spin forever.
 *   3. Grounding citations are captured and surfaced for the egress gate.
 *
 * It also ships a degraded-but-safe static fallback (no tools, no I/O, a fixed
 * "temporarily unavailable" reply) composed behind a permission-monotonic
 * `FallbackAgent`.
 */

// Public contract.
export type { AgentInput, AgentOutput, ToolInvocation, CourseAgent } from './types.js';

// Soft prompt layer.
export { buildSystemPrompt } from './systemPrompt.js';

// Tool bridge (zod → JSON-Schema for the LLM layer).
export { toLlmTools, findTool } from './toolBridge.js';

// The primary governed loop.
export { PiAgent } from './piAgent.js';
export type { PiAgentDeps } from './piAgent.js';

// The degraded-but-safe static fallback.
export { StaticFallbackAgent } from './staticFallbackAgent.js';
export type { StaticFallbackAgentDeps } from './staticFallbackAgent.js';

// Permission-monotonic composition of primary + fallback.
export { FallbackAgent } from './fallbackAgent.js';
export type { FallbackAgentDeps } from './fallbackAgent.js';
