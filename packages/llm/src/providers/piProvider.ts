/**
 * Pi-backed chat provider — the ONLY file in this package that imports pi-ai.
 *
 * All Pi specifics are quarantined here. The rest of `@vta/llm` depends on the
 * provider-agnostic {@link LlmProvider} interface, so if pi-ai's API differs
 * from what is assumed below, this is the only file that needs to change.
 *
 * TODO(verify-at-install): "@mariozechner/pi-ai" — the exact npm package name,
 * version, and especially its runtime API are UNVERIFIED. The import and the
 * `PiAiClient`/`PiCompletion` shapes below are a small ASSUMED surface. At
 * install time: (1) confirm the package resolves, (2) confirm the entry point
 * and method names, (3) adjust `toPiMessages` / `callPi` / `fromPiResult`
 * accordingly. Everything Pi-specific lives in those three helpers.
 */

// TODO(verify-at-install): confirm this import path/specifier exists.
// Imported as a namespace so a wrong/missing named export fails loudly here
// rather than silently producing `undefined`.
import * as PiAi from '@earendil-works/pi-ai';
import { LlmUnavailableError, toError } from '@vta/shared';
import type { LlmProvider } from '../provider.js';
import type {
  LlmMessage,
  LlmRequest,
  LlmResult,
  LlmTool,
  LlmToolCall,
  Usage,
} from '../types.js';

/**
 * Assumed minimal shape of a pi-ai message on the way *in*.
 * TODO(verify-at-install): confirm how pi-ai represents assistant tool-call
 * turns and tool-result turns. The optional `toolCalls`/`toolCallId` fields
 * below are an ASSUMED shape — pi-ai may name or nest these differently.
 */
interface PiMessageLike {
  role: string;
  content: string;
  toolCalls?: PiToolCallLike[];
  toolCallId?: string;
}

/**
 * Assumed shape of a tool advertised to pi-ai.
 * TODO(verify-at-install): pi-ai's tool/function-definition format is
 * UNVERIFIED. This guesses an OpenAI-ish `{ name, description, parameters }`
 * (JSON-Schema) shape. Adjust `toPiTools` if pi-ai differs (e.g. wraps in
 * `{ type: 'function', function: {...} }`).
 */
interface PiToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Assumed shape of a tool call pi-ai returns.
 * TODO(verify-at-install): UNVERIFIED. `arguments` is assumed to be either a
 * JSON string (OpenAI-style) or an already-parsed object; `fromPiToolCalls`
 * handles both defensively.
 */
interface PiToolCallLike {
  id?: string;
  name?: string;
  arguments?: unknown;
}

/**
 * Assumed minimal shape of pi-ai. Kept deliberately small and local.
 * TODO(verify-at-install): replace with the real pi-ai types/signature.
 */
interface PiAiClientLike {
  complete(input: {
    model: string;
    messages: PiMessageLike[];
    temperature?: number;
    maxTokens?: number;
    baseUrl?: string;
    apiKey?: string;
    bearerToken?: string;
    responseSchema?: unknown;
    // TODO(verify-at-install): confirm pi-ai's parameter names for tools and
    // tool-choice. Assumed `tools` + `toolChoice` here.
    tools?: PiToolLike[];
    toolChoice?: 'auto' | 'none';
  }): Promise<PiCompletionLike>;
}

/** Assumed pi-ai completion result shape. */
interface PiCompletionLike {
  text?: string;
  content?: string;
  usage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
  // TODO(verify-at-install): confirm how pi-ai surfaces tool calls and the
  // stop/finish reason. Assumed `toolCalls` array + `finishReason` string.
  toolCalls?: PiToolCallLike[];
  finishReason?: string;
}

/**
 * How this provider obtains credentials at call time. The router supplies one
 * of these so the Pi adapter stays agnostic about apiKey-vs-oauth resolution.
 */
export type PiCredential = { readonly kind: 'apiKey'; readonly apiKey: string };

export interface PiProviderOptions {
  /** Concrete model id (e.g. "gpt-5.4-mini", "deepseek-v4-flash"). */
  readonly model: string;
  /** Provider family label, used only for `id`/usage (e.g. "openai"). */
  readonly providerLabel: string;
  /** Optional base URL override (DeepSeek / Azure / OpenAI-compatible). */
  readonly endpoint?: string;
  /** Credential strategy resolved by the router. */
  readonly credential: PiCredential;
}

/** Build the assumed pi-ai client. Isolated so the construction call is swappable. */
function makePiClient(): PiAiClientLike {
  // TODO(verify-at-install): the real constructor/factory is unknown. We probe
  // a couple of plausible shapes and fail loudly if none match, instead of
  // crashing with an opaque "X is not a function".
  const mod = PiAi as unknown as {
    PiAi?: new () => PiAiClientLike;
    Client?: new () => PiAiClientLike;
    createClient?: () => PiAiClientLike;
    complete?: PiAiClientLike['complete'];
  };

  if (typeof mod.createClient === 'function') return mod.createClient();
  if (typeof mod.PiAi === 'function') return new mod.PiAi();
  if (typeof mod.Client === 'function') return new mod.Client();
  if (typeof mod.complete === 'function') {
    // Module exposes a bare `complete` function rather than a client object.
    return { complete: mod.complete.bind(mod) };
  }

  throw new LlmUnavailableError(
    'pi-ai client could not be constructed — its API does not match the assumed surface. ' +
      'TODO(verify-at-install): fix makePiClient() in piProvider.ts.',
  );
}

/**
 * Map our messages to pi-ai's. Handles the full {@link LlmMessage} union:
 * assistant tool-call turns and tool-result turns are translated alongside
 * plain system/user/assistant text.
 *
 * TODO(verify-at-install): the wire shape for tool-call/tool-result turns is
 * ASSUMED (see {@link PiMessageLike}). Adjust the per-branch mapping if pi-ai
 * expects different field names/nesting.
 */
function toPiMessages(messages: LlmMessage[]): PiMessageLike[] {
  return messages.map((m): PiMessageLike => {
    switch (m.role) {
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls !== undefined
            ? {
                toolCalls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', content: m.content, toolCallId: m.toolCallId };
      default:
        // 'system' | 'user'
        return { role: m.role, content: m.content };
    }
  });
}

/**
 * Map our JSON-Schema {@link LlmTool}s to pi-ai's tool-definition shape.
 *
 * TODO(verify-at-install): pi-ai's tool format is UNVERIFIED. This passes
 * `{ name, description, parameters }` straight through. If pi-ai expects an
 * OpenAI-style `{ type: 'function', function: { name, description, parameters } }`
 * wrapper (or anything else), remap here — this is the only place tools cross
 * into pi-ai.
 */
function toPiTools(tools: LlmTool[]): PiToolLike[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Defensively parse a single pi-ai tool-call's arguments into the parsed JSON
 * the caller expects. Strategy:
 *  - object (already parsed) → pass through;
 *  - string → attempt `JSON.parse`; on failure, keep the raw string so the
 *    caller can validate/repair it;
 *  - anything else (number/bool/null/undefined) → pass through as-is.
 */
function parseToolArguments(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      // Keep the raw string; the caller validates. (TODO(verify-at-install):
      // confirm whether pi-ai ever emits non-JSON argument strings.)
      return raw;
    }
  }
  return raw;
}

/**
 * Normalise pi-ai's tool calls into our {@link LlmToolCall}s. Returns
 * `undefined` when there are none, so callers can treat the field as absent.
 *
 * TODO(verify-at-install): id/name/arguments field names are ASSUMED.
 */
function fromPiToolCalls(raw: PiCompletionLike): LlmToolCall[] | undefined {
  const calls = raw.toolCalls;
  if (!calls || calls.length === 0) return undefined;
  return calls.map((c, i) => ({
    // Fall back to a synthetic id if pi-ai omits one — the caller needs a
    // stable handle to correlate the eventual tool-result turn.
    id: c.id ?? `tool_call_${i}`,
    name: c.name ?? '',
    arguments: parseToolArguments(c.arguments),
  }));
}

/**
 * Map pi-ai's stop/finish reason to our closed set. Unknown values collapse to
 * `'other'`. When tool calls are present we report `'tool_calls'` regardless,
 * since that is what the caller must act on.
 *
 * TODO(verify-at-install): pi-ai's finishReason vocabulary is ASSUMED.
 */
function toFinishReason(
  raw: string | undefined,
  hasToolCalls: boolean,
): LlmResult['finishReason'] {
  if (hasToolCalls) return 'tool_calls';
  switch (raw) {
    case 'stop':
    case 'end_turn':
    case 'eos':
      return 'stop';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls';
    case 'length':
    case 'max_tokens':
      return 'length';
    case undefined:
      // No reason reported but no tool calls either — treat as a normal stop.
      return 'stop';
    default:
      return 'other';
  }
}

/** Normalise a pi-ai result into our {@link LlmResult}. */
function fromPiResult(
  raw: PiCompletionLike,
  model: string,
  provider: string,
): LlmResult {
  const text = raw.text ?? raw.content ?? '';
  const usage: Usage = {
    inputTokens: raw.usage?.inputTokens ?? raw.usage?.promptTokens ?? 0,
    outputTokens: raw.usage?.outputTokens ?? raw.usage?.completionTokens ?? 0,
  };
  const toolCalls = fromPiToolCalls(raw);
  const finishReason = toFinishReason(raw.finishReason, toolCalls !== undefined);
  return {
    text,
    usage,
    model,
    provider,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    finishReason,
  };
}

/**
 * A chat provider whose backend is pi-ai. Works for any pi-ai-supported model
 * (OpenAI, DeepSeek, OpenAI-compatible) — the difference is just `model`,
 * `endpoint`, and the credential the router injects.
 */
export class PiProvider implements LlmProvider {
  readonly id: string;
  private readonly client: PiAiClientLike;

  constructor(private readonly options: PiProviderOptions) {
    this.id = `${options.providerLabel}:${options.model}`;
    this.client = makePiClient();
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const { model, providerLabel, endpoint, credential } = this.options;

    // Resolve credentials immediately before the call (tokens may refresh).
    const auth = { apiKey: credential.apiKey };

    try {
      const raw = await this.client.complete({
        model,
        messages: toPiMessages(req.messages),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(endpoint !== undefined ? { baseUrl: endpoint } : {}),
        ...(req.jsonSchema !== undefined ? { responseSchema: req.jsonSchema } : {}),
        // TODO(verify-at-install): confirm pi-ai accepts `tools`/`toolChoice`
        // (and these names). When no tools are supplied this stays absent, so
        // non-tool calls behave exactly as before.
        ...(req.tools !== undefined ? { tools: toPiTools(req.tools) } : {}),
        ...(req.toolChoice !== undefined ? { toolChoice: req.toolChoice } : {}),
        ...auth,
      });
      return fromPiResult(raw, model, providerLabel);
    } catch (err) {
      // Surface all backend failures as a uniform availability error so the
      // router's failover logic can react. Never include the credential.
      throw new LlmUnavailableError(`pi-ai completion failed for ${this.id}`, {
        provider: providerLabel,
        model,
        cause: toError(err).message,
      });
    }
  }
}
