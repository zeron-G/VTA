/**
 * Process-level configuration, validated once at startup.
 *
 * This is infrastructure config (where the database is, which secrets provider
 * to use, the active LLM profile). It is deliberately separate from the LLM
 * *role* mapping, which lives in the `@vta/llm` package.
 */

import { z } from 'zod';
import { ConfigError } from './errors.js';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Selects the LLM profile in `@vta/llm` (dev / prod = DeepSeek+OpenAI direct;
   * openrouter = all model calls via the OpenRouter gateway). */
  LLM_PROFILE: z.enum(['dev', 'prod', 'openrouter']).default('dev'),

  /** Postgres connection string (the pgvector-enabled instance). */
  DATABASE_URL: z.string().min(1),

  /** Redis connection string (queue + rate-limit state). */
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  SECRETS_PROVIDER: z.enum(['env', 'keyvault']).default('env'),
  AZURE_KEY_VAULT_URL: z.string().url().optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Parse and validate configuration. Throws `ConfigError` with a readable
 * summary if anything is missing or malformed — fail fast, never boot half-configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  const config = result.data;
  if (config.SECRETS_PROVIDER === 'keyvault' && !config.AZURE_KEY_VAULT_URL) {
    throw new ConfigError('SECRETS_PROVIDER=keyvault requires AZURE_KEY_VAULT_URL');
  }
  return config;
}
