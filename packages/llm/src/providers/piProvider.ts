/**
 * Chat provider backed by the OpenAI SDK.
 *
 * This is the ONLY chat-transport file in the package. It speaks the OpenAI
 * Chat Completions wire format, which serves BOTH configured chat providers:
 *   - OpenAI       — natively (default base URL).
 *   - DeepSeek     — via its OpenAI-compatible endpoint (base URL injected by
 *                    the router from `DEEPSEEK_BASE_URL`, e.g. https://api.deepseek.com).
 *
 * The class/exports are still named `PiProvider`/`PiCredential` for historical
 * reasons (the LLM layer was originally sketched against an assumed `pi-ai`
 * surface that did not match the real package); the router and embedder import
 * these names. Only logical roles cross this boundary — the router resolves a
 * role to a concrete `model` + `endpoint` + credential and hands it here.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';
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
 * How this provider obtains credentials at call time. The router supplies one
 * of these so the adapter stays agnostic about how the key was resolved.
 */
export type PiCredential = { readonly kind: 'apiKey'; readonly apiKey: string };

export interface PiProviderOptions {
  /** Concrete model id (e.g. "gpt-5.4-mini", "deepseek-v4-flash"). */
  readonly model: string;
  /** Provider family label, used only for `id`/usage (e.g. "openai", "deepseek"). */
  readonly providerLabel: string;
  /** Optional base URL override (DeepSeek / Azure / OpenAI-compatible gateways). */
  readonly endpoint?: string;
  /** Credential strategy resolved by the router. */
  readonly credential: PiCredential;
}

/** Translate our message union into the OpenAI Chat Completions message shape. */
function toOpenAiMessages(messages: LlmMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case 'assistant': {
        // An assistant turn that requested tools must carry `tool_calls`; its
        // textual content may be empty (the model often emits no preamble).
        if (m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content === '' ? null : m.content,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments:
                  typeof tc.arguments === 'string'
                    ? tc.arguments
                    : JSON.stringify(tc.arguments ?? {}),
              },
            })),
          };
        }
        return { role: 'assistant', content: m.content };
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      default:
        // 'system' | 'user'
        return { role: m.role, content: m.content };
    }
  });
}

/** Translate our JSON-Schema tools into OpenAI function-tool definitions. */
function toOpenAiTools(tools: LlmTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Parse a tool call's JSON-string arguments; keep the raw string on failure. */
function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Map the OpenAI finish reason to our closed set. */
function toFinishReason(
  raw: string | null | undefined,
  hasToolCalls: boolean,
): LlmResult['finishReason'] {
  if (hasToolCalls) return 'tool_calls';
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case null:
    case undefined:
      return 'stop';
    default:
      return 'other';
  }
}

/**
 * A chat provider whose backend is the OpenAI SDK. Works for any
 * OpenAI-compatible model (OpenAI, DeepSeek, ...) — the difference is just
 * `model`, `endpoint`, and the credential the router injects.
 */
export class PiProvider implements LlmProvider {
  readonly id: string;

  constructor(private readonly options: PiProviderOptions) {
    this.id = `${options.providerLabel}:${options.model}`;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const { model, providerLabel, endpoint, credential } = this.options;

    // Build the client per call (cheap) so a refreshed credential is always used.
    const client = new OpenAI({
      apiKey: credential.apiKey,
      ...(endpoint !== undefined ? { baseURL: endpoint } : {}),
    });

    try {
      const completion = await client.chat.completions.create({
        model,
        messages: toOpenAiMessages(req.messages),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.tools !== undefined ? { tools: toOpenAiTools(req.tools) } : {}),
        ...(req.toolChoice !== undefined
          ? { tool_choice: req.toolChoice as ChatCompletionToolChoiceOption }
          : {}),
        // Structured-output hint: request strict JSON. (No live caller passes a
        // schema today; the egress judge wants free text. Kept for completeness.)
        ...(req.jsonSchema !== undefined ? { response_format: { type: 'json_object' as const } } : {}),
      });

      const choice = completion.choices[0];
      if (!choice) {
        throw new LlmUnavailableError(`completion returned no choices for ${this.id}`, {
          provider: providerLabel,
          model,
        });
      }

      const toolCalls: LlmToolCall[] = [];
      for (const c of choice.message.tool_calls ?? []) {
        if (c.type === 'function') {
          toolCalls.push({
            id: c.id,
            name: c.function.name,
            arguments: parseToolArguments(c.function.arguments),
          });
        }
      }

      const usage: Usage = {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      };

      return {
        text: choice.message.content ?? '',
        usage,
        model,
        provider: providerLabel,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: toFinishReason(choice.finish_reason, toolCalls.length > 0),
      };
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      // Surface all backend failures as a uniform availability error so the
      // router's failover logic can react. Never include the credential.
      throw new LlmUnavailableError(`chat completion failed for ${this.id}`, {
        provider: providerLabel,
        model,
        cause: toError(err).message,
      });
    }
  }
}
