/**
 * Role -> concrete-model mapping types.
 *
 * A {@link RoleMapping} is the single source of truth that turns a logical
 * {@link LlmRole} (from `@vta/shared`) into a concrete provider + model + auth
 * strategy. Profiles in `config.ts` are just named instances of this map.
 */

import type { LlmRole } from '@vta/shared';

/** Which concrete backend family a role resolves to. */
export type ProviderKind = 'deepseek' | 'openai' | 'azure-openai' | 'openai-compatible';

/** How a provider authenticates. API keys only (Codex/ChatGPT OAuth was removed). */
export type AuthKind = 'apiKey';

/**
 * A fully-resolved description of how to serve one role.
 *
 *  - `provider`    backend family (selects the concrete adapter)
 *  - `model`       concrete model id passed to that backend
 *  - `endpoint`    base URL override (DeepSeek / Azure / OpenAI-compatible);
 *                  may be supplied at load time from an env var
 *  - `auth`        always 'apiKey' -> resolve `apiKeyName` from the SecretsProvider
 *  - `apiKeyName`  secrets-provider name to look up for this role's key
 */
export interface ModelSpec {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly endpoint?: string;
  readonly auth: AuthKind;
  readonly apiKeyName?: string;
}

/** A complete mapping covering every logical LLM role. */
export type RoleMapping = Record<LlmRole, ModelSpec>;
