/**
 * ModelRouter — the single entry point business code uses to reach an LLM.
 *
 * Callers pass a logical {@link LlmRole}; the router resolves it (via the active
 * {@link RoleMapping}) to a concrete provider, calls it, records usage, and —
 * for the agent path — fails over from primary to fallback. No caller ever
 * names a concrete model.
 *
 * Providers are built lazily and cached per role, so each role's API key is
 * resolved once on first use rather than per request.
 */

import { ConfigError, LlmUnavailableError, VtaError, toError } from '@vta/shared';
import type { SecretsProvider, LlmRole } from '@vta/shared';
import type { Embedder, LlmProvider } from './provider.js';
import type { ModelSpec, RoleMapping } from './roles.js';
import type { LlmRequest, LlmResult } from './types.js';
import { resolveApiKey } from './auth/apiKey.js';
import { PiProvider } from './providers/piProvider.js';
import type { PiCredential } from './providers/piProvider.js';
import { OpenAiEmbedder } from './providers/openaiEmbedder.js';
import { LoggingUsageSink } from './usage.js';
import type { UsageSink } from './usage.js';

/** Map a `ModelSpec.provider` to the label we surface in `id`/usage. */
function providerLabel(spec: ModelSpec): string {
  switch (spec.provider) {
    case 'deepseek':
      return 'deepseek';
    case 'openai':
      return 'openai';
    case 'azure-openai':
      return 'azure-openai';
    case 'openai-compatible':
      return 'openai-compatible';
  }
}

/** Heuristic: should this error trigger failover to the fallback role? */
function isTransient(err: unknown): boolean {
  // Our own availability errors are always retryable on the fallback.
  if (err instanceof LlmUnavailableError) return true;
  // Other VtaErrors (config, secret missing, tenant) are deterministic — do
  // not waste a fallback call on them.
  if (err instanceof VtaError) return false;
  // Unknown/native errors (network, timeouts) are treated as transient.
  return true;
}

export interface ModelRouterOptions {
  readonly mapping: RoleMapping;
  readonly secrets: SecretsProvider;
  /** Defaults to a {@link LoggingUsageSink}. */
  readonly usage?: UsageSink;
}

export class ModelRouter {
  private readonly mapping: RoleMapping;
  private readonly secrets: SecretsProvider;
  private readonly usage: UsageSink;

  /** Lazily-built chat providers, cached by role. */
  private readonly providerCache = new Map<LlmRole, Promise<LlmProvider>>();
  /** Lazily-built embedders, cached by role. */
  private readonly embedderCache = new Map<LlmRole, Promise<Embedder>>();

  constructor(options: ModelRouterOptions) {
    this.mapping = options.mapping;
    this.secrets = options.secrets;
    this.usage = options.usage ?? new LoggingUsageSink();
  }

  /** Resolve the concrete spec for a role. */
  private specFor(role: LlmRole): ModelSpec {
    // `noUncheckedIndexedAccess` widens Record lookups to `T | undefined`.
    const spec = this.mapping[role];
    if (!spec) {
      throw new ConfigError(`Active LLM profile has no mapping for role "${role}"`, { role });
    }
    return spec;
  }

  /** Build the credential strategy for a spec. All roles authenticate with an API key. */
  private async credentialFor(spec: ModelSpec): Promise<PiCredential> {
    const apiKey = await resolveApiKey(spec, this.secrets);
    return { kind: 'apiKey', apiKey };
  }

  /**
   * Resolve a role to a cached chat provider, building it on first use.
   * Throws `ConfigError`/`SecretMissingError` during construction if the spec
   * or its secret is misconfigured.
   */
  async resolve(role: LlmRole): Promise<LlmProvider> {
    const existing = this.providerCache.get(role);
    if (existing) return existing;

    const built = this.buildProvider(role);
    this.providerCache.set(role, built);
    // If construction fails, evict so a later call can retry (e.g. after a
    // secret is added) instead of caching a rejected promise forever.
    built.catch(() => this.providerCache.delete(role));
    return built;
  }

  private async buildProvider(role: LlmRole): Promise<LlmProvider> {
    const spec = this.specFor(role);
    const credential = await this.credentialFor(spec);
    return new PiProvider({
      model: spec.model,
      providerLabel: providerLabel(spec),
      ...(spec.endpoint !== undefined ? { endpoint: spec.endpoint } : {}),
      credential,
    });
  }

  /** Resolve a role to a cached embedder, building it on first use. */
  private async resolveEmbedder(role: LlmRole): Promise<Embedder> {
    const existing = this.embedderCache.get(role);
    if (existing) return existing;

    const built = (async (): Promise<Embedder> => {
      const spec = this.specFor(role);
      const credential = await this.credentialFor(spec);
      // TODO(phase-1): only OpenAI/OpenAI-compatible embeddings are wired here.
      // A DeepSeek/other embedder would branch on spec.provider.
      return new OpenAiEmbedder({
        model: spec.model,
        ...(spec.endpoint !== undefined ? { endpoint: spec.endpoint } : {}),
        credential,
      });
    })();

    this.embedderCache.set(role, built);
    built.catch(() => this.embedderCache.delete(role));
    return built;
  }

  /** Resolve a role, call it, and record usage. */
  async complete(role: LlmRole, req: LlmRequest): Promise<LlmResult> {
    const provider = await this.resolve(role);
    const startedAt = Date.now();
    const result = await provider.complete(req);
    this.usage.record({
      role,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      latencyMs: Date.now() - startedAt,
      ts: new Date().toISOString(),
    });
    return result;
  }

  /**
   * Run the agent completion with failover. Tries `primary`; on a transient /
   * availability failure, tries `fallback`. If both fail, throws a single
   * `LlmUnavailableError` carrying both causes.
   */
  async completeWithFailover(
    req: LlmRequest,
    primary: LlmRole = 'agent.primary',
    fallback: LlmRole = 'agent.fallback',
  ): Promise<LlmResult> {
    try {
      return await this.complete(primary, req);
    } catch (primaryErr) {
      if (!isTransient(primaryErr)) {
        // Deterministic failure (bad config/secret) — failing over won't help.
        throw primaryErr;
      }
      try {
        return await this.complete(fallback, req);
      } catch (fallbackErr) {
        throw new LlmUnavailableError('Both primary and fallback LLM roles failed', {
          primaryRole: primary,
          fallbackRole: fallback,
          primaryCause: toError(primaryErr).message,
          fallbackCause: toError(fallbackErr).message,
        });
      }
    }
  }

  /** Embed texts using the `embed` role. */
  async embed(texts: string[]): Promise<number[][]> {
    const embedder = await this.resolveEmbedder('embed');
    return embedder.embed(texts);
  }
}
