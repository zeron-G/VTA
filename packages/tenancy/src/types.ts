/**
 * Canonical TypeScript shapes for the per-course configuration blobs.
 *
 * `@vta/data` stores these as opaque `jsonb` columns (see
 * `course_config.channel_map / content_rules / locales / rate_limit`) with only
 * permissive, index-signature placeholder types. THIS package owns the real,
 * tightened shapes and the zod schemas that validate them at the edge. Later
 * waves import from here — notably `@vta/governance`, which enforces
 * `ContentRules`.
 *
 * Design notes:
 *   - The stored DB `ChannelMap` keeps channel ids as flat `readonly string[]`
 *     (e.g. `discord: ["123", "456"]`). The tenancy `ChannelMap` below is richer
 *     (it can carry a Discord `guildId`), so `loadCourseConfig` normalizes the
 *     stored row into this shape. The mapping is isolated in `config.ts`.
 *   - All shapes are `readonly` to make a `ResolvedCourseConfig` safe to share
 *     across the request pipeline without defensive copying.
 */

import { z } from 'zod';
import type { CourseId } from '@vta/shared';

/* -------------------------------------------------------------------------- */
/* ChannelMap                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How channel-native identifiers route to this course.
 *
 * A course may be reachable on several channels at once. Each channel block is
 * optional; an absent block means "this course is not reachable on that
 * channel".
 */
export interface DiscordChannelBinding {
  /** Optional Discord guild (server) id this course lives in. */
  readonly guildId?: string;
  /** Discord channel ids that route to this course. At least one in practice. */
  readonly channelIds: readonly string[];
}

export interface EmailChannelBinding {
  /** Inbound addresses (or aliases) that route to this course. */
  readonly addresses: readonly string[];
}

export interface WebChannelBinding {
  /** Opaque web widget / room keys that route to this course. */
  readonly roomIds: readonly string[];
}

export interface ChannelMap {
  readonly discord?: DiscordChannelBinding;
  readonly email?: EmailChannelBinding;
  readonly web?: WebChannelBinding;
}

export const discordChannelBindingSchema = z
  .object({
    guildId: z.string().min(1).optional(),
    channelIds: z.array(z.string().min(1)).readonly().default([]),
  })
  .strict();

export const emailChannelBindingSchema = z
  .object({
    addresses: z.array(z.string().min(1)).readonly().default([]),
  })
  .strict();

export const webChannelBindingSchema = z
  .object({
    roomIds: z.array(z.string().min(1)).readonly().default([]),
  })
  .strict();

export const channelMapSchema = z
  .object({
    discord: discordChannelBindingSchema.optional(),
    email: emailChannelBindingSchema.optional(),
    web: webChannelBindingSchema.optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* ContentRules                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Governance policy configuration for a course. `@vta/governance` reads these
 * flags to decide whether to refuse, redirect, or answer a request, and whether
 * to require citations on grounded answers.
 *
 * `allowUnreleasedMaterial` is intentionally typed as the literal `false`: a
 * Phase-1 course may NOT opt into surfacing unreleased material. The field
 * exists so the shape is explicit, but it cannot be flipped on via config yet.
 */
export interface ContentRules {
  /** Refuse to reveal/discuss individual grades. */
  readonly refuseGrades: boolean;
  /** Refuse to produce solutions to graded homework. */
  readonly refuseHomeworkSolutions: boolean;
  /** Refuse questions unrelated to the course. */
  readonly refuseOffTopic: boolean;
  /** Hard-locked off in Phase 1: never surface not-yet-released material. */
  readonly allowUnreleasedMaterial: false;
  /** Require at least one citation on any substantive answer. */
  readonly requireCitations: boolean;
  /** Message shown when a grade question is refused/redirected. */
  readonly gradeRedirectMessage: string;
  /** Message shown when an off-topic question is refused. */
  readonly offTopicMessage: string;
}

/**
 * Safe, conservative defaults applied whenever a course's stored
 * `content_rules` blob is missing fields. These err on the side of refusing.
 */
export const DEFAULT_CONTENT_RULES: ContentRules = {
  refuseGrades: true,
  refuseHomeworkSolutions: true,
  refuseOffTopic: true,
  allowUnreleasedMaterial: false,
  requireCitations: true,
  gradeRedirectMessage:
    'I can’t share or discuss individual grades. Please contact your instructor or check the course gradebook.',
  offTopicMessage:
    'I can only help with questions about this course. Please rephrase your question so it relates to the course material.',
};

/**
 * Zod schema for `ContentRules`. Every field has a default sourced from
 * `DEFAULT_CONTENT_RULES`, so parsing a partial (or empty) blob yields a fully
 * populated, valid `ContentRules`. `allowUnreleasedMaterial` is pinned to the
 * literal `false`.
 */
export const contentRulesSchema = z
  .object({
    refuseGrades: z.boolean().default(DEFAULT_CONTENT_RULES.refuseGrades),
    refuseHomeworkSolutions: z
      .boolean()
      .default(DEFAULT_CONTENT_RULES.refuseHomeworkSolutions),
    refuseOffTopic: z.boolean().default(DEFAULT_CONTENT_RULES.refuseOffTopic),
    // Coerce any stored truthy value back to the locked-off literal `false`.
    allowUnreleasedMaterial: z.literal(false).default(false),
    requireCitations: z.boolean().default(DEFAULT_CONTENT_RULES.requireCitations),
    gradeRedirectMessage: z
      .string()
      .min(1)
      .default(DEFAULT_CONTENT_RULES.gradeRedirectMessage),
    offTopicMessage: z
      .string()
      .min(1)
      .default(DEFAULT_CONTENT_RULES.offTopicMessage),
  })
  .strip();

/* -------------------------------------------------------------------------- */
/* RateLimitConfig                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-course rate limiting. Disabled in Phase 1 (`enabled: false`); the
 * `perHour` / `perDay` knobs are carried so a later wave can switch it on
 * without a schema change. The column is nullable in the DB, so the resolved
 * value may be `null`.
 */
export interface RateLimitConfig {
  readonly enabled: boolean;
  readonly perHour?: number;
  readonly perDay?: number;
}

export const rateLimitConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    perHour: z.number().int().positive().optional(),
    perDay: z.number().int().positive().optional(),
  })
  .strict();

/** Applied when a course has no `rate_limit` blob (column is null). */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = { enabled: false };

/* -------------------------------------------------------------------------- */
/* LocaleConfig                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Locale policy. `default` is the BCP-47 tag used when the student's language
 * cannot be inferred; `mirrorStudentLanguage` lets the assistant answer in the
 * detected language of the student's message.
 */
export interface LocaleConfig {
  readonly default: string;
  readonly mirrorStudentLanguage: boolean;
}

export const localeConfigSchema = z
  .object({
    default: z.string().min(2).default('en'),
    mirrorStudentLanguage: z.boolean().default(true),
  })
  .strict();

/** Applied when a course has no usable `locales` blob. */
export const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  default: 'en',
  mirrorStudentLanguage: true,
};

/* -------------------------------------------------------------------------- */
/* ResolvedCourseConfig                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The fully-resolved, validated configuration for one course. This is what the
 * rest of the pipeline consumes: every field is present and type-safe, with
 * defaults already applied. `rateLimit` is `null` when disabled/absent.
 */
export interface ResolvedCourseConfig {
  readonly courseId: CourseId;
  readonly channelMap: ChannelMap;
  readonly contentRules: ContentRules;
  readonly rateLimit: RateLimitConfig | null;
  readonly locales: LocaleConfig;
  readonly welcomeText?: string;
}
