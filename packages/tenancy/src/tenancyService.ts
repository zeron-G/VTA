/**
 * `TenancyService` — the multi-tenant front door.
 *
 * This is the FIRST thing ingress governance calls on a normalized inbound
 * message. It answers, in one step:
 *   1. WHICH course (tenant) the message belongs to (by channel routing),
 *   2. the user's ROLE within that course,
 *   3. the course's resolved, validated CONFIG.
 *
 * When the inbound channel maps to no course, `resolveInbound` returns `null`
 * so ingress can drop the message without leaking that any course exists.
 *
 * Tenant isolation: role and config are only ever resolved for the SAME
 * `courseId` produced by channel resolution, so a message can never be answered
 * with another course's policy or another course's role assignment.
 */

import { createLogger } from '@vta/shared';
import type { Logger } from '@vta/shared';
import type {
  CourseId,
  ChannelKind,
  CourseRole,
  UserId,
} from '@vta/shared';
import { UserRepository } from '@vta/data';
import type { Db } from '@vta/data';

import { CourseResolver } from './courseResolver.js';
import { RoleResolver } from './roleResolver.js';
import { loadCourseConfig } from './config.js';
import type { ResolvedCourseConfig } from './types.js';

/** Dependencies for the tenancy service. A `Db` is injected; the pool is owned by the caller. */
export interface TenancyServiceDeps {
  readonly db: Db;
  /** Optional logger; a named child of the shared logger is created by default. */
  readonly logger?: Logger;
}

/** The routing key extracted from a normalized inbound message. */
export interface InboundRouting {
  readonly channel: ChannelKind;
  /** Channel-native id: Discord channel id, inbound email address, or web room id. */
  readonly channelId: string;
  /** Optional Discord guild id, used to disambiguate channel ids across guilds. */
  readonly guildId?: string;
  /**
   * The EXTERNAL channel-native user id (Phase-1: a Discord snowflake). It is
   * resolved to an internal `users.id` uuid HERE before any role/audit lookup —
   * membership queries never receive the raw snowflake.
   */
  readonly externalUserId: string;
  /** Optional display name from the channel, used to seed/refresh the user row. */
  readonly displayName?: string;
}

/** The fully-resolved tenant context for an inbound message. */
export interface ResolvedTenantContext {
  readonly courseId: CourseId;
  /** The INTERNAL `users.id` uuid the external identity resolved to. */
  readonly userId: UserId;
  readonly role: CourseRole;
  readonly config: ResolvedCourseConfig;
}

/** Aggregates course, role, and config resolution behind a single entry point. */
export class TenancyService {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly courseResolver: CourseResolver;
  private readonly roleResolver: RoleResolver;
  private readonly users: UserRepository;

  constructor(deps: TenancyServiceDeps) {
    this.db = deps.db;
    this.log = deps.logger ?? createLogger({ name: 'tenancy' });
    this.courseResolver = new CourseResolver({ db: deps.db });
    this.roleResolver = new RoleResolver({ db: deps.db });
    this.users = new UserRepository(deps.db);
  }

  /**
   * Resolve the full tenant context for an inbound message.
   *
   * The supplied `externalUserId` is the channel-native identity (Phase-1: a
   * Discord snowflake). It is mapped to a stable internal `users.id` uuid via
   * {@link UserRepository.upsertByDiscordId} BEFORE any role lookup, so role and
   * audit only ever see the internal uuid — never the raw snowflake.
   *
   * @returns the `{ courseId, userId, role, config }` context, or `null` when
   *          the channel maps to no course (resolved before any user upsert, so
   *          unrouted traffic never creates an identity row).
   */
  async resolveInbound(
    routing: InboundRouting,
  ): Promise<ResolvedTenantContext | null> {
    const courseId = await this.courseResolver.resolveByChannel(
      routing.channel,
      routing.channelId,
      routing.guildId,
    );

    if (courseId === null) {
      this.log.debug(
        { channel: routing.channel },
        'inbound message did not map to any course; dropping',
      );
      return null;
    }

    // Resolve the external channel identity to the internal user uuid first;
    // every downstream lookup keys on this uuid, not the snowflake.
    const user = await this.users.upsertByDiscordId(
      routing.externalUserId,
      routing.displayName,
    );
    const userId: UserId = user.id;

    // Role and config are resolved strictly for the SAME courseId — never the
    // caller-supplied routing id — preserving tenant isolation. Role is keyed on
    // the internal uuid.
    const [role, config] = await Promise.all([
      this.roleResolver.resolveRole(courseId, userId),
      loadCourseConfig({ db: this.db }, courseId),
    ]);

    this.log.debug({ courseId, role, channel: routing.channel }, 'resolved tenant context');

    return { courseId, userId, role, config };
  }

  /**
   * Resolve a tenant context by course slug (admin tooling / web entry). Returns
   * `null` if no course has that slug. The user's role still defaults to
   * `'standard'` when no membership exists.
   *
   * `userId` here is ALREADY the internal `users.id` uuid (admin tooling resolves
   * identity out-of-band); it is passed through to role resolution and the
   * returned context unchanged.
   */
  async resolveBySlug(
    slug: string,
    userId: UserId,
  ): Promise<ResolvedTenantContext | null> {
    const courseId = await this.courseResolver.resolveBySlug(slug);
    if (courseId === null) return null;

    const [role, config] = await Promise.all([
      this.roleResolver.resolveRole(courseId, userId),
      loadCourseConfig({ db: this.db }, courseId),
    ]);

    return { courseId, userId, role, config };
  }
}
