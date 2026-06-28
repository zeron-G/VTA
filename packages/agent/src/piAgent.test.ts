/**
 * Unit tests for the PiAgent bounded tool-calling loop.
 *
 * The router is faked (scripted LlmResults) and a REAL default-deny ToolGate is
 * wired, so these pin the load-bearing invariants without an LLM:
 *   - an allowlisted tool the model asks for is executed and its citations captured;
 *   - a NON-allowlisted tool is DENIED by the gate and never executed (the
 *     cardinal invariant), yet the loop still produces an answer;
 *   - the loop is hard-bounded and forces a final answer when it runs long.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { ToolGate } from '@vta/governance';
import type { LlmRequest, LlmResult, ModelRouter } from '@vta/llm';
import type { VtaTool } from '@vta/tools';

import { PiAgent } from './piAgent.js';
import type { AgentInput } from './types.js';

// The loop never reads `rules` (that's the egress gate's concern), so a minimal
// cast keeps this test free of a @vta/tenancy dependency.
function govContext(): AgentInput['govContext'] {
  return {
    courseId: 'course-1',
    role: 'standard',
    rules: {} as AgentInput['govContext']['rules'],
    requestId: 'req-1',
  };
}

function result(partial: Partial<LlmResult>): LlmResult {
  return {
    text: '',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'fake',
    provider: 'fake',
    ...partial,
  };
}

/** A router whose `completeWithFailover` returns scripted results by call index. */
function scriptedRouter(script: (call: number, req: LlmRequest) => LlmResult): {
  router: ModelRouter;
  calls: () => number;
} {
  let n = 0;
  const router = {
    completeWithFailover: (req: LlmRequest): Promise<LlmResult> => {
      const r = script(n, req);
      n += 1;
      return Promise.resolve(r);
    },
  } as unknown as ModelRouter;
  return { router, calls: () => n };
}

const retrieveTool: VtaTool = {
  name: 'retrieve',
  description: 'course material search',
  parameters: z.object({ query: z.string() }),
  execute: () =>
    Promise.resolve({
      content: 'A relevant excerpt.',
      data: { citations: [{ sourceId: 'm1', title: 'Module 1' }] },
    }),
};

describe('PiAgent loop', () => {
  it('executes an allowlisted tool, captures citations, and returns the final answer', async () => {
    const { router } = scriptedRouter((call) =>
      call === 0
        ? result({
            toolCalls: [{ id: 't1', name: 'retrieve', arguments: { query: 'q' } }],
            finishReason: 'tool_calls',
          })
        : result({ text: 'Here is the grounded answer.', finishReason: 'stop' }),
    );
    const agent = new PiAgent({ router, tools: [retrieveTool], toolgate: new ToolGate() });

    const out = await agent.answer({ govContext: govContext(), question: 'explain X' });

    expect(out.text).toBe('Here is the grounded answer.');
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]?.sourceId).toBe('m1');
    expect(out.toolInvocations).toContainEqual({ name: 'retrieve', allowed: true, ok: true });
  });

  it('DENIES a non-allowlisted tool at the gate and never executes it', async () => {
    let executed = false;
    const evilTool: VtaTool = {
      name: 'exfiltrate', // not on the default allowlist
      description: 'should never run',
      parameters: z.object({}),
      execute: () => {
        executed = true;
        return Promise.resolve({ content: 'leaked' });
      },
    };
    const { router } = scriptedRouter((call) =>
      call === 0
        ? result({
            toolCalls: [{ id: 't1', name: 'exfiltrate', arguments: {} }],
            finishReason: 'tool_calls',
          })
        : result({ text: 'safe answer', finishReason: 'stop' }),
    );
    const agent = new PiAgent({ router, tools: [evilTool], toolgate: new ToolGate() });

    const out = await agent.answer({ govContext: govContext(), question: 'do something bad' });

    expect(executed).toBe(false); // cardinal invariant: the gate blocked execution
    expect(out.toolInvocations).toContainEqual({ name: 'exfiltrate', allowed: false, ok: false });
    expect(out.text).toBe('safe answer');
    // A deny verdict was recorded for the audit log.
    expect(out.governanceVerdicts.some((v) => v.decision === 'block')).toBe(true);
  });

  it('is hard-bounded: forces a final answer when the model keeps calling tools', async () => {
    // Always request a tool; only the forced final call (toolChoice=none, no tools
    // advertised) returns text.
    const { router, calls } = scriptedRouter((_call, req) =>
      req.tools === undefined
        ? result({ text: 'forced final answer', finishReason: 'stop' })
        : result({
            toolCalls: [{ id: 't', name: 'retrieve', arguments: { query: 'again' } }],
            finishReason: 'tool_calls',
          }),
    );
    const agent = new PiAgent({ router, tools: [retrieveTool], toolgate: new ToolGate() });

    const out = await agent.answer({ govContext: govContext(), question: 'loop forever' });

    expect(out.text).toBe('forced final answer');
    // 6 bounded iterations + 1 forced final completion.
    expect(calls()).toBe(7);
  });
});
