/**
 * PiAgent — the governed, bounded tool-calling loop.
 *
 * This is the primary `CourseAgent`. It drives the LLM (via `@vta/llm`'s
 * `ModelRouter.completeWithFailover`) through OUR OWN loop, enforcing the
 * governance tool-gate INLINE before every tool execution. That inline check is
 * functionally identical to a `beforeToolCall` hook, but living in our code
 * makes it certain and unit-testable.
 *
 * Three invariants are load-bearing and must never be relaxed:
 *   1. NO tool executes unless `toolgate.check(...)` returned `allow: true`.
 *   2. The loop is HARD-bounded by `MAX_ITERATIONS`; it can never spin forever.
 *   3. Citations from retrieval are CAPTURED and surfaced so the caller's egress
 *      grounding gate can verify the answer is grounded.
 *
 * Tenant scope (`courseId`, `role`) for tool execution comes ONLY from
 * `input.govContext`, never from model-supplied tool arguments.
 */

import { createLogger } from '@vta/shared';
import type { Citation, Logger } from '@vta/shared';
import type { LlmMessage, LlmResult, ModelRouter } from '@vta/llm';
import type { ToolContext, ToolResult, VtaTool } from '@vta/tools';
import type { ToolGate } from '@vta/governance';
import type { RetrievalResult } from '@vta/rag';
import type { GovernanceVerdict } from '@vta/audit';

import type { AgentInput, AgentOutput, CourseAgent, ToolInvocation } from './types.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { findTool, toLlmTools } from './toolBridge.js';

/** Hard upper bound on tool-calling rounds. The loop can never exceed this. */
const MAX_ITERATIONS = 6;


/** Safe reply when the loop is bounded out before the model produced an answer. */
const STOP_MESSAGE =
  'I need to stop here. I was not able to finish gathering what I needed to answer reliably. Please try rephrasing your question.';

/** Constructor dependencies for {@link PiAgent}. */
export interface PiAgentDeps {
  readonly router: ModelRouter;
  /** The read-only tool set the agent may use (already assembled by the caller). */
  readonly tools: VtaTool[];
  /** The governance tool-gate; consulted inline before every tool execution. */
  readonly toolgate: ToolGate;
  readonly logger?: Logger;
}

export class PiAgent implements CourseAgent {
  private readonly router: ModelRouter;
  private readonly tools: VtaTool[];
  private readonly toolgate: ToolGate;
  private readonly log: Logger;

  constructor(deps: PiAgentDeps) {
    this.router = deps.router;
    this.tools = deps.tools;
    this.toolgate = deps.toolgate;
    this.log = deps.logger ?? createLogger({ name: 'pi-agent' });
  }

  async answer(input: AgentInput): Promise<AgentOutput> {
    // Tenant scope is derived from govContext ONLY — never from model args.
    const toolCtx: ToolContext = {
      courseId: input.govContext.courseId,
      role: input.govContext.role,
    };

    // System prompt, then any prior conversation turns (already PII-redacted by
    // the caller), then the current question. History gives follow-ups context;
    // it never carries tool calls (plain user/assistant text only).
    const history: LlmMessage[] = (input.history ?? []).map((turn) =>
      turn.role === 'assistant'
        ? { role: 'assistant', content: turn.content }
        : { role: 'user', content: turn.content },
    );
    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemPrompt(input) },
      ...history,
      { role: 'user', content: input.question },
    ];

    const llmTools = toLlmTools(this.tools);
    const toolInvocations: ToolInvocation[] = [];
    const citationAccumulator: Citation[] = [];
    // Every tool-gate decision (allow or deny) is captured for the audit log;
    // only the agent sees the tool calls, so it must surface these itself.
    const gateVerdicts: GovernanceVerdict[] = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const result: LlmResult = await this.router.completeWithFailover({
        messages,
        tools: llmTools,
        toolChoice: 'auto',
      });

      const toolCalls = result.toolCalls;

      // No tool calls → the model produced its final answer. Done.
      if (toolCalls === undefined || toolCalls.length === 0) {
        if (result.finishReason === 'length') {
          // Truncated by the token limit — log it so a cut-off answer is
          // observable (egress still scans it) rather than passing as clean.
          this.log.warn(
            { requestId: input.govContext.requestId },
            'final answer truncated (finishReason=length)',
          );
        }
        return {
          text: result.text,
          citations: dedupeCitations(citationAccumulator),
          toolInvocations,
          governanceVerdicts: gateVerdicts,
        };
      }

      // Append the assistant's tool-calling turn so the subsequent tool result
      // messages are correlated by toolCallId on the next request.
      messages.push({ role: 'assistant', content: result.text, toolCalls });

      // Execute each requested tool call, gated.
      for (const tc of toolCalls) {
        // (1) GOVERNANCE GATE — the cardinal invariant. Nothing below executes
        // a tool unless this returned allow.
        const decision = this.toolgate.check(tc.name, tc.arguments, input.govContext);
        gateVerdicts.push(decision.verdict);
        if (!decision.allow) {
          const reason = decision.reason ?? 'denied by tool gate';
          this.log.warn({ tool: tc.name, requestId: input.govContext.requestId }, 'tool call denied by gate');
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: `Tool "${tc.name}" was denied by policy and was not executed: ${reason}`,
          });
          toolInvocations.push({ name: tc.name, allowed: false, ok: false });
          continue;
        }

        // (2) Resolve the concrete tool. A hallucinated name is reported back to
        // the model rather than throwing.
        const tool = findTool(this.tools, tc.name);
        if (tool === undefined) {
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: `Unknown tool "${tc.name}".`,
          });
          toolInvocations.push({ name: tc.name, allowed: true, ok: false });
          continue;
        }

        // (3) VALIDATE arguments against the tool's own zod schema. The model's
        // arguments are untrusted `unknown`; a bad shape is reported, not run.
        const parsed = tool.parameters.safeParse(tc.arguments);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: `Invalid arguments for tool "${tc.name}": ${issues}`,
          });
          toolInvocations.push({ name: tc.name, allowed: true, ok: false });
          continue;
        }

        // (4) EXECUTE with the validated args and the trusted tenant context.
        try {
          const toolResult: ToolResult = await tool.execute(parsed.data, toolCtx);
          messages.push({ role: 'tool', toolCallId: tc.id, content: toolResult.content });

          // Capture grounding citations from ANY tool that returns them: the
          // retrieve tool yields course-material citations, web_search yields web
          // source citations (title + URL). Capturing both lets web-sourced
          // answers be cited AND lets the citation verifier check the answer's
          // URLs against real sources — not just course material.
          for (const citation of extractCitations(toolResult.data)) {
            citationAccumulator.push(citation);
          }

          toolInvocations.push({ name: tc.name, allowed: true, ok: true });
        } catch (err) {
          this.log.error(
            { tool: tc.name, requestId: input.govContext.requestId, err },
            'tool execution failed',
          );
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: `Tool "${tc.name}" failed to execute.`,
          });
          toolInvocations.push({ name: tc.name, allowed: true, ok: false });
        }
      }
    }

    // Bounded out: the model kept calling tools through MAX_ITERATIONS. Force ONE
    // final answer with tools DISABLED, so we return a real reply synthesized from
    // the accumulated tool results — never a tool-calling turn's empty preamble.
    this.log.warn(
      { requestId: input.govContext.requestId, maxIterations: MAX_ITERATIONS },
      'agent loop hit max iterations; forcing a final answer (toolChoice=none)',
    );
    let finalText = STOP_MESSAGE;
    try {
      const forced: LlmResult = await this.router.completeWithFailover({
        messages,
        toolChoice: 'none',
      });
      if (forced.text.trim() !== '') finalText = forced.text;
    } catch (err) {
      this.log.error(
        { requestId: input.govContext.requestId, err },
        'forced final completion failed; returning safe stop message',
      );
    }
    return {
      text: finalText,
      citations: dedupeCitations(citationAccumulator),
      toolInvocations,
      governanceVerdicts: gateVerdicts,
    };
  }
}

/**
 * Extract `Citation[]` from a tool result's optional `data`, tolerating any
 * shape. The retrieve tool puts a `RetrievalResult` on `data`; we read its
 * `citations` defensively because `data` is typed `unknown`.
 */
function extractCitations(data: unknown): readonly Citation[] {
  if (typeof data !== 'object' || data === null) return [];
  const citations = (data as Partial<RetrievalResult>).citations;
  if (!Array.isArray(citations)) return [];
  return citations;
}

/**
 * Dedupe citations by `sourceId` + `locator`, preserving first-seen order, so a
 * source retrieved across multiple rounds is cited once.
 */
function dedupeCitations(citations: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const citation of citations) {
    const key = JSON.stringify([citation.sourceId, citation.locator ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}
