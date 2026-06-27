/**
 * Named LLM profiles.
 *
 * A profile is a complete {@link RoleMapping} chosen by environment:
 *   - `dev`  — same provider/auth shape as prod (DeepSeek primary, OpenAI
 *              fallback), all via API keys; pointed at dev/test keys+endpoints.
 *   - `prod` — the agent's primary path is DeepSeek (cost), with an OpenAI
 *              fallback; embeddings/guard stay on OpenAI for stability.
 *
 * No other package references this file's concrete model names. Business code
 * asks the router for a role; the router consults the active profile.
 */

import { ConfigError } from '@vta/shared';
import type { ModelSpec, RoleMapping } from './roles.js';

export type LlmProfileName = 'dev' | 'prod';

/**
 * Optional base URL for the DeepSeek (OpenAI-compatible) endpoint, injected
 * from the environment so the concrete URL is never hard-coded in source.
 * `undefined` lets the provider fall back to its own default.
 */
const DEEPSEEK_ENDPOINT: string | undefined = process.env.DEEPSEEK_BASE_URL;

/**
 * Development profile: same providers/auth as prod (DeepSeek primary, OpenAI
 * fallback), all authenticated with API keys from the SecretsProvider. Point it
 * at dev/test keys (and optionally a dev DeepSeek endpoint) via the environment;
 * it differs from prod only in which keys/endpoints are supplied.
 */
const DEV_PROFILE: RoleMapping = {
  'agent.primary': {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    auth: 'apiKey',
    apiKeyName: 'deepseek.api-key',
    endpoint: DEEPSEEK_ENDPOINT,
  },
  'agent.fallback': {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
  embed: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
  // TODO(phase-1): OpenAI has no first-class rerank endpoint. We reuse the chat
  // model as a listwise reranker via a scoring prompt; a dedicated rerank
  // provider (e.g. Cohere / a cross-encoder) should be wired in Phase 1.
  rerank: {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
  'guard.judge': {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
};

/**
 * Production profile: DeepSeek primary, OpenAI fallback, OpenAI for
 * embeddings/guard. All auth is via API keys resolved from the SecretsProvider.
 */
const PROD_PROFILE: RoleMapping = {
  'agent.primary': {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    auth: 'apiKey',
    apiKeyName: 'deepseek.api-key',
    endpoint: DEEPSEEK_ENDPOINT,
  },
  'agent.fallback': {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
  embed: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
  // TODO(phase-1): replace with a dedicated rerank provider in production.
  // Reusing the OpenAI chat model as a stand-in keeps the role wired.
  rerank: {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
  'guard.judge': {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    auth: 'apiKey',
    apiKeyName: 'openai.api-key',
  },
};

export const PROFILES: Record<LlmProfileName, RoleMapping> = {
  dev: DEV_PROFILE,
  prod: PROD_PROFILE,
};

/** Load a profile by name, throwing `ConfigError` for an unknown name. */
export function loadProfile(name: LlmProfileName): RoleMapping {
  const profile = PROFILES[name];
  if (!profile) {
    throw new ConfigError(`Unknown LLM profile "${String(name)}"`, {
      known: Object.keys(PROFILES),
    });
  }
  return profile;
}

/** Re-export for callers that resolve a single role spec directly. */
export type { ModelSpec };
