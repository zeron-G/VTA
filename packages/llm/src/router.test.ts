/**
 * Unit tests for ModelRouter.completeWithFailover — the primary→fallback logic
 * that silently broke in production (every chat call threw). The concrete
 * PiProvider is mocked so behavior is scripted per model id, with no network.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConfigError, LlmUnavailableError } from '@vta/shared';
import type { SecretsProvider } from '@vta/shared';

// Behavior is keyed by model id; hoisted so the mock factory can see it.
const behaviors = vi.hoisted(() => ({ map: new Map<string, () => Promise<unknown>>() }));

vi.mock('./providers/piProvider.js', () => ({
  PiProvider: class {
    private readonly model: string;
    constructor(opts: { model: string }) {
      this.model = opts.model;
    }
    complete(): Promise<unknown> {
      const behavior = behaviors.map.get(this.model);
      if (behavior === undefined) return Promise.reject(new Error(`no behavior: ${this.model}`));
      return behavior();
    }
  },
}));

const { ModelRouter } = await import('./router.js');
import type { RoleMapping } from './roles.js';

const secrets = {
  get: () => Promise.resolve('k'),
  require: () => Promise.resolve('k'),
} as unknown as SecretsProvider;

function mapping(): RoleMapping {
  const base = { auth: 'apiKey' as const, apiKeyName: 'openai.api-key' };
  return {
    'agent.primary': { provider: 'deepseek', model: 'primary-model', ...base },
    'agent.fallback': { provider: 'openai', model: 'fallback-model', ...base },
    embed: { provider: 'openai', model: 'embed-model', ...base },
    rerank: { provider: 'openai', model: 'rerank-model', ...base },
    'guard.judge': { provider: 'openai', model: 'judge-model', ...base },
  } as RoleMapping;
}

function ok(text: string): () => Promise<unknown> {
  return () =>
    Promise.resolve({
      text,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
      provider: 'p',
      finishReason: 'stop',
    });
}

const req = { messages: [{ role: 'user' as const, content: 'q' }] };

describe('ModelRouter.completeWithFailover', () => {
  it('uses the primary when it succeeds (no fallback call)', async () => {
    behaviors.map.clear();
    behaviors.map.set('primary-model', ok('PRIMARY'));
    const fallback = vi.fn(ok('FALLBACK'));
    behaviors.map.set('fallback-model', fallback);

    const res = await new ModelRouter({ mapping: mapping(), secrets }).completeWithFailover(req);

    expect(res.text).toBe('PRIMARY');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('fails over to the fallback on a transient primary error', async () => {
    behaviors.map.clear();
    behaviors.map.set('primary-model', () => Promise.reject(new LlmUnavailableError('primary down')));
    behaviors.map.set('fallback-model', ok('FALLBACK'));

    const res = await new ModelRouter({ mapping: mapping(), secrets }).completeWithFailover(req);

    expect(res.text).toBe('FALLBACK');
  });

  it('does NOT fail over on a deterministic (non-availability) error', async () => {
    behaviors.map.clear();
    behaviors.map.set('primary-model', () => Promise.reject(new ConfigError('bad config')));
    const fallback = vi.fn(ok('FALLBACK'));
    behaviors.map.set('fallback-model', fallback);

    const router = new ModelRouter({ mapping: mapping(), secrets });
    await expect(router.completeWithFailover(req)).rejects.toBeInstanceOf(ConfigError);
    expect(fallback).not.toHaveBeenCalled(); // deterministic error → no wasted fallback
  });

  it('throws LlmUnavailableError carrying both causes when both fail', async () => {
    behaviors.map.clear();
    behaviors.map.set('primary-model', () => Promise.reject(new LlmUnavailableError('primary down')));
    behaviors.map.set('fallback-model', () => Promise.reject(new LlmUnavailableError('fallback down')));

    const router = new ModelRouter({ mapping: mapping(), secrets });
    await expect(router.completeWithFailover(req)).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
