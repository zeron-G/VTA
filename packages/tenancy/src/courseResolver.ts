/**
 * Course (tenant) resolution from inbound routing identifiers.
 *
 * Given a channel-native identifier (a Discord channel id, an inbound email
 * address, a web room id) the resolver answers: WHICH course does this belong
 * to? Resolution is by scanning each course's `channelMap`. A second entry point
 * resolves a course directly by its unique slug (used by admin tooling and the
 * web channel).
 *
 * Tenant isolation: the resolver only ever RETURNS a `CourseId`; it never leaks
 * one course's config to another. A non-match returns `null` (no course owns
 * this channel) rather than throwing, so ingress can drop unrouted traffic
 * quietly.
 */

import type { CourseId, ChannelKind } from '@vta/shared';
import { CourseRepository, CourseConfigRepository } from '@vta/data';
import type { Db } from '@vta/data';
import type { ChannelMap } from './types.js';
import { channelMapSchema } from './types.js';

/** Dependencies for course resolution. */
export interface CourseResolverDeps {
  readonly db: Db;
}

/**
 * Resolves the owning course for an inbound routing key.
 *
 * NOTE on scaling: `resolveByChannel` currently scans all course configs in
 * memory. For Phase 1 (tens of courses) this is fine and keeps the data layer
 * untouched. A later wave should back this with a `channel_bindings` index table
 * + a direct lookup — the public method signature here is designed to stay
 * stable across that change.
 */
export class CourseResolver {
  private readonly courses: CourseRepository;
  private readonly configs: CourseConfigRepository;

  constructor(deps: CourseResolverDeps) {
    this.courses = new CourseRepository(deps.db);
    this.configs = new CourseConfigRepository(deps.db);
  }

  /**
   * Resolve the course that owns `channelId` on the given `channel`.
   *
   * @param channel   the channel kind ('discord' | 'email' | 'web').
   * @param channelId the channel-native id (Discord channel id, email address,
   *                  or web room id).
   * @param guildId   optional Discord guild id. When supplied AND a course's
   *                  Discord binding pins a `guildId`, the guild must match;
   *                  this disambiguates the same channel id across guilds.
   * @returns the owning `CourseId`, or `null` if no course claims it.
   */
  async resolveByChannel(
    channel: ChannelKind,
    channelId: string,
    guildId?: string,
  ): Promise<CourseId | null> {
    if (channelId.length === 0) return null;

    const allCourses = await this.courses.list();

    for (const course of allCourses) {
      const row = await this.configs.get(course.id);
      if (row === undefined) continue;

      // Validate/normalize the stored map into the richer tenancy shape. A
      // malformed map for one course must not abort resolution for others.
      const parsed = channelMapSchema.safeParse(toRichChannelMap(row.channelMap));
      if (!parsed.success) continue;

      if (matchesChannel(parsed.data as ChannelMap, channel, channelId, guildId)) {
        return course.id;
      }
    }

    return null;
  }

  /** Resolve a course by its unique slug, or `null` if none exists. */
  async resolveBySlug(slug: string): Promise<CourseId | null> {
    if (slug.length === 0) return null;
    const course = await this.courses.getBySlug(slug);
    return course?.id ?? null;
  }
}

/**
 * Bridge the DB's flat `ChannelMap` (channel -> string[]) into the richer
 * tenancy shape understood by `channelMapSchema`.
 *
 * TODO(verify): unify with `normalizeStoredChannelMap` in config.ts once the DB
 * `ChannelMap` shape is tightened; both adapt the same legacy storage shape.
 */
function toRichChannelMap(stored: {
  readonly discord?: readonly string[];
  readonly email?: readonly string[];
  readonly web?: readonly string[];
}): unknown {
  const out: {
    discord?: { channelIds: readonly string[] };
    email?: { addresses: readonly string[] };
    web?: { roomIds: readonly string[] };
  } = {};
  if (Array.isArray(stored.discord)) out.discord = { channelIds: [...stored.discord] };
  if (Array.isArray(stored.email)) out.email = { addresses: [...stored.email] };
  if (Array.isArray(stored.web)) out.web = { roomIds: [...stored.web] };
  return out;
}

/** Does this (already-validated) channel map claim the given id on `channel`? */
function matchesChannel(
  map: ChannelMap,
  channel: ChannelKind,
  channelId: string,
  guildId: string | undefined,
): boolean {
  switch (channel) {
    case 'discord': {
      const binding = map.discord;
      if (binding === undefined) return false;
      // If the binding pins a guild and the caller provided one, they must match.
      if (
        binding.guildId !== undefined &&
        guildId !== undefined &&
        binding.guildId !== guildId
      ) {
        return false;
      }
      return binding.channelIds.includes(channelId);
    }
    case 'email': {
      const binding = map.email;
      if (binding === undefined) return false;
      // Email addresses are matched case-insensitively.
      const needle = channelId.toLowerCase();
      return binding.addresses.some((addr) => addr.toLowerCase() === needle);
    }
    case 'web': {
      const binding = map.web;
      if (binding === undefined) return false;
      return binding.roomIds.includes(channelId);
    }
    default: {
      // Exhaustiveness: every ChannelKind is handled above.
      const _exhaustive: never = channel;
      return _exhaustive;
    }
  }
}
