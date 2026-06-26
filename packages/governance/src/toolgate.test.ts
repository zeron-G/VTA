/**
 * Unit tests for the {@link ToolGate} default-deny chokepoint.
 *
 * Pure logic only: no DB, no LLM, no network. The gate is synchronous and
 * deterministic by design, so these assert its allow/deny matrix directly.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTENT_RULES } from '@vta/tenancy';

import { ToolGate } from './toolgate.js';
import type { ToolArgValidator } from './toolgate.js';
import type { GovernanceContext } from './context.js';

/** A minimal, valid per-request context. ToolGate only reads `ctx.role`. */
const CTX: GovernanceContext = {
  courseId: 'course-1',
  role: 'standard',
  rules: DEFAULT_CONTENT_RULES,
  requestId: 'req-1',
};

describe('ToolGate', () => {
  it('default-denies an unknown tool name', () => {
    const gate = new ToolGate();
    const decision = gate.check('definitely_not_a_tool', {}, CTX);

    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('not on the allowlist');
    // Every decision carries a verdict.
    expect(decision.verdict.stage).toBe('toolgate');
    expect(decision.verdict.decision).toBe('block');
    expect(decision.verdict.check).toBe('tool.definitely_not_a_tool');
  });

  it('allows the default Phase-1 read-only tools', () => {
    const gate = new ToolGate();

    for (const name of ['retrieve', 'catalog_lookup']) {
      const decision = gate.check(name, {}, CTX);
      expect(decision.allow).toBe(true);
      expect(decision.verdict.stage).toBe('toolgate');
      expect(decision.verdict.decision).toBe('allow');
      expect(decision.verdict.check).toBe(`tool.${name}`);
    }
  });

  it('turns an allowed call into a deny when an arg-validator returns a reason', () => {
    const rejectQuery: ToolArgValidator = (args) =>
      typeof (args as { query?: unknown }).query === 'string'
        ? null
        : 'query must be a string';

    const gate = new ToolGate({ argValidators: { retrieve: rejectQuery } });

    // Bad args -> the registered validator flips an allowlisted tool to deny.
    const denied = gate.check('retrieve', { query: 42 }, CTX);
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain('invalid arguments');
    expect(denied.verdict.decision).toBe('block');

    // Valid args -> still allowed.
    const allowed = gate.check('retrieve', { query: 'photosynthesis' }, CTX);
    expect(allowed.allow).toBe(true);
    expect(allowed.verdict.decision).toBe('allow');
  });

  it('every decision (allow or deny) carries a toolgate verdict with a timestamp', () => {
    const gate = new ToolGate();
    const decisions = [
      gate.check('retrieve', {}, CTX),
      gate.check('unknown_tool', {}, CTX),
    ];
    for (const d of decisions) {
      expect(d.verdict).toBeDefined();
      expect(d.verdict.stage).toBe('toolgate');
      // ISO-8601 timestamp present.
      expect(typeof d.verdict.at).toBe('string');
      expect(Number.isNaN(Date.parse(d.verdict.at))).toBe(false);
    }
  });
});
