/**
 * The Discord message handler — the adapter's entire job.
 *
 * THE WORKER STAYS DUMB. For every inbound Discord message it does exactly five
 * things and nothing else:
 *   1. Filter out messages it must never process (bots, empty text, DMs).
 *   2. RESOLVE which course + role the message belongs to via `@vta/tenancy`.
 *   3. BUILD a channel-agnostic {@link InboundRequest}.
 *   4. CALL `TeachingService.handle()` — the governed pipeline.
 *   5. POST the returned {@link OutboundReply} VERBATIM back to Discord.
 *
 * It contains NO answering, governance, or RAG logic. The reply text is already
 * egress-governed by core; the worker must never post raw model output, add
 * content of its own, or otherwise reshape `reply.text`. A bug here cannot
 * bypass governance because the worker never sees the model.
 */

import type { Message, ThreadChannel } from 'discord.js';

import type { InboundRequest } from '@vta/shared';
import { toError } from '@vta/shared';

import type { WorkerServices } from './services.js';

/** Discord hard-caps a single message at 2000 characters. */
const DISCORD_MESSAGE_LIMIT = 2000;

/** Max length of the auto-generated thread title (Discord caps thread names at 100). */
const THREAD_TITLE_MAX = 90;

/** The dependencies the handler closes over. (`discordToken` is login-only, unused here.) */
export type MessageHandlerDeps = Pick<WorkerServices, 'teaching' | 'tenancy' | 'log'>;

/**
 * Build the `messageCreate` handler. Returns an async function suitable for
 * `client.on(Events.MessageCreate, handler)`.
 *
 * The ENTIRE body is wrapped in try/catch: a single malformed message must never
 * be able to crash the gateway, and internal error details are never posted to
 * the channel (core already returns a neutral, governed error reply for failures
 * inside the pipeline).
 */
export function makeMessageHandler(
  deps: MessageHandlerDeps,
): (message: Message) => Promise<void> {
  const { teaching, tenancy, log } = deps;

  return async function handleMessage(message: Message): Promise<void> {
    try {
      // (1a) Never react to other bots or to our own messages — this is the
      // primary guard against feedback loops where the bot answers itself.
      if (message.author.bot) return;

      // (1b) Skip messages with no textual content (e.g. an image-only post or
      // a system message). There is nothing to answer.
      const text = message.content;
      if (text.trim() === '') return;

      // (1c) Phase 1 is guild-only: DMs have no course routing, so drop them.
      if (message.guild === null) return;

      // Per-student threading mirrors the conversation model: if the message is
      // already inside a thread, that thread IS the conversation key; otherwise
      // we will start one on the message below. We compute this BEFORE tenant
      // resolution because course routing must key on the MAPPED (parent)
      // channel, not the thread's own id.
      const inThread = message.channel.isThread();

      // Course routing uses the parent text channel when the message lives in a
      // thread (a thread's own id is never in the channel map, so a follow-up
      // posted inside the bot's reply thread would otherwise resolve to no
      // course and be dropped — that was the "only answers once" bug).
      const routingChannelId =
        inThread && message.channel.parentId !== null
          ? message.channel.parentId
          : message.channelId;

      // (2) Resolve the owning course + the caller's role. A `null` result means
      // this channel maps to no course — ignore SILENTLY (never reply, so we
      // don't leak that any course exists).
      // Pass the EXTERNAL Discord identity (snowflake + username). Tenancy maps
      // it to an internal users.id uuid server-side; we never key role/audit on
      // the snowflake. Tenant scope still comes only from server-side channel
      // resolution, never from anything the author controls.
      const tenant = await tenancy.resolveInbound({
        channel: 'discord',
        channelId: routingChannelId,
        guildId: message.guildId ?? undefined,
        externalUserId: message.author.id,
        displayName: message.author.username,
      });
      if (tenant === null) return;

      // (3) Build the channel-agnostic request. `threadId` is set only when the
      // message already lives in a thread; for a top-level message it is left
      // undefined (a fresh thread is created at post time).
      const request: InboundRequest = {
        id: message.id,
        channel: 'discord',
        courseId: tenant.courseId,
        // The INTERNAL users.id uuid resolved server-side — NOT the raw Discord
        // snowflake. The audit trail and any downstream role check key on this.
        userId: tenant.userId,
        role: tenant.role,
        text,
        ...(inThread ? { threadId: message.channelId } : {}),
        receivedAt: new Date().toISOString(),
      };

      // (4) Run the governed pipeline. Everything policy-related happens in here.
      const reply = await teaching.handle(request);

      // (5) Post the governed reply VERBATIM on EVERY status (answered / refused
      // / escalated / rate_limited / error) so the student always receives the
      // governed response. We post `reply.text` and nothing else.
      await deliverReply(message, inThread, reply.text, log);
    } catch (err) {
      // ERROR ISOLATION: log and swallow. One failing message can never crash
      // the gateway, and we never surface internal error details to the channel.
      log.error(
        { err: toError(err).message, messageId: message.id, channelId: message.channelId },
        'discord message handler failed; message dropped',
      );
    }
  };
}

/**
 * Derive a short, human-readable thread title from the author and their
 * question, e.g. `ada — How do I submit assignment 3?`. Trimmed to Discord's
 * thread-name budget.
 */
function buildThreadTitle(message: Message): string {
  const author = message.author.username;
  const question = message.content.replace(/\s+/g, ' ').trim();
  const raw = question === '' ? author : `${author} — ${question}`;
  return raw.length > THREAD_TITLE_MAX ? `${raw.slice(0, THREAD_TITLE_MAX - 1)}…` : raw;
}

/**
 * Deliver the governed reply to Discord. Splitting into <=2000-char chunks is a
 * pure transport concern (Discord's per-message cap) — it never alters content.
 *
 * Posting strategy:
 *   - empty/whitespace reply → post nothing (and create NO dangling thread).
 *   - already in a thread → send there.
 *   - top-level message → open a per-student thread; if that fails (a thread
 *     already exists, missing CreatePublicThreads / SendMessagesInThreads perms,
 *     or a non-thread-capable channel), FALL BACK to an in-channel reply so a
 *     successful governed answer is never silently dropped.
 */
async function deliverReply(
  message: Message,
  inThread: boolean,
  text: string,
  log: MessageHandlerDeps['log'],
): Promise<void> {
  if (text.trim() === '') return; // nothing to send — never create a dangling thread
  const chunks = chunk2000(text);

  if (inThread) {
    const thread = message.channel as ThreadChannel;
    for (const chunk of chunks) await thread.send(chunk);
    return;
  }

  let thread: ThreadChannel | undefined;
  try {
    thread = await message.startThread({ name: buildThreadTitle(message) });
  } catch (err) {
    log.warn(
      { err: toError(err).message, messageId: message.id },
      'could not start a thread; falling back to an in-channel reply',
    );
  }

  if (thread !== undefined) {
    for (const chunk of chunks) await thread.send(chunk);
    return;
  }
  // Fallback: reply in-channel so the governed answer still reaches the student.
  for (const chunk of chunks) await message.reply(chunk);
}

/**
 * Split a string into pieces no longer than {@link DISCORD_MESSAGE_LIMIT}. A
 * plain fixed-width slice: simple and lossless. Returns at least one chunk for
 * any non-empty input.
 */
function chunk2000(text: string): string[] {
  // Split on code-point boundaries (not UTF-16 units) so a 2000-char seam can
  // never bisect a surrogate pair and corrupt an emoji / CJK / astral character.
  const points = Array.from(text);
  if (points.length <= DISCORD_MESSAGE_LIMIT) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < points.length; i += DISCORD_MESSAGE_LIMIT) {
    chunks.push(points.slice(i, i + DISCORD_MESSAGE_LIMIT).join(''));
  }
  return chunks;
}
