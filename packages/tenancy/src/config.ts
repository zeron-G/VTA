/**
 * Resolution of a course's stored config blobs into a validated
 * `ResolvedCourseConfig`.
 *
 * The `course_config` row stores four `jsonb` blobs that the DB layer types only
 * loosely. Here we:
 *   1. read the row via `CourseConfigRepository.get`,
 *   2. normalize the stored (flat) `ChannelMap` into this package's richer shape,
 *   3. validate every blob with zod, applying `DEFAULT_*` for missing fields,
 *   4. return a fully-populated, type-safe `ResolvedCourseConfig`.
 *
 * If a course has NO config row, a config built entirely from defaults is
 * returned (an empty channel map + conservative content rules). This keeps the
 * front door functional for freshly-created courses.
 */

import type { z } from 'zod';
import { ConfigError } from '@vta/shared';
import type { CourseId } from '@vta/shared';
import { CourseConfigRepository } from '@vta/data';
import type { Db } from '@vta/data';
// The stored (flat) ChannelMap shape, distinct from this package's richer one.
import type { ChannelMap as StoredChannelMap } from '@vta/data';

import type { ChannelMap, ResolvedCourseConfig } from './types.js';
import {
  channelMapSchema,
  contentRulesSchema,
  localeConfigSchema,
  rateLimitConfigSchema,
  DEFAULT_LOCALE_CONFIG,
} from './types.js';

/** Dependencies for config loading. A `Db` is injected so callers control the pool. */
export interface ConfigLoaderDeps {
  readonly db: Db;
}

/**
 * Normalize the DB's flat `ChannelMap` (channel -> string[]) into the richer
 * tenancy `ChannelMap` (e.g. Discord ids nested under `channelIds`).
 *
 * The stored shape has no place for a Discord `guildId`; that information lives
 * only in the richer shape, so it is left undefined when reading legacy rows.
 *
 * TODO(verify): once the DB `ChannelMap` is tightened to carry `guildId`
 * directly, drop this normalization and parse the stored blob straight through
 * `channelMapSchema`.
 */
function normalizeStoredChannelMap(stored: StoredChannelMap | undefined): unknown {
  if (stored === undefined || stored === null) return {};

  const out: {
    discord?: { channelIds: readonly string[] };
    email?: { addresses: readonly string[] };
    web?: { roomIds: readonly string[] };
  } = {};

  if (Array.isArray(stored.discord)) {
    out.discord = { channelIds: [...stored.discord] };
  }
  if (Array.isArray(stored.email)) {
    out.email = { addresses: [...stored.email] };
  }
  if (Array.isArray(stored.web)) {
    out.web = { roomIds: [...stored.web] };
  }
  return out;
}

/**
 * Load and validate a course's configuration, applying defaults for anything
 * missing. Never returns `undefined`: a course with no stored row resolves to a
 * defaults-only config.
 *
 * @throws ConfigError if a stored blob is present but structurally invalid.
 */
export async function loadCourseConfig(
  deps: ConfigLoaderDeps,
  courseId: CourseId,
): Promise<ResolvedCourseConfig> {
  const repo = new CourseConfigRepository(deps.db);
  const row = await repo.get(courseId);

  // Parse each blob independently so an error names the offending section.
  const channelMap = parseSection(
    'channelMap',
    courseId,
    channelMapSchema,
    normalizeStoredChannelMap(row?.channelMap),
  ) as ChannelMap;

  const contentRules = parseSection(
    'contentRules',
    courseId,
    contentRulesSchema,
    // `contentRules` defaults to `{}` in the DB; an empty object yields all defaults.
    row?.contentRules ?? {},
  );

  const locales = parseSection(
    'locales',
    courseId,
    localeConfigSchema,
    // A `{}` (the DB default) is fine — but if `default` is missing the schema
    // fills it in. We still pass DEFAULT_LOCALE_CONFIG-equivalent via the schema.
    row?.locales ?? DEFAULT_LOCALE_CONFIG,
  );

  // `rate_limit` is nullable in the DB. Null/absent => disabled => resolved null.
  const rateLimit =
    row?.rateLimit == null
      ? null
      : parseSection('rateLimit', courseId, rateLimitConfigSchema, row.rateLimit);

  const welcomeText = row?.welcomeText ?? undefined;

  return {
    courseId,
    channelMap,
    contentRules,
    rateLimit,
    locales,
    ...(welcomeText !== undefined && welcomeText !== null
      ? { welcomeText }
      : {}),
  };
}

/**
 * Parse one config section with zod, wrapping any failure in a `ConfigError`
 * that identifies the course and the section. Keeps the external (zod) error
 * shape from leaking into callers. `T` is inferred from the schema's OUTPUT, so
 * defaulted/stripped fields are reflected in the return type.
 */
function parseSection<S extends z.ZodTypeAny>(
  section: string,
  courseId: CourseId,
  schema: S,
  data: unknown,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(`Invalid course config section "${section}"`, {
      courseId,
      section,
      issues: result.error.issues,
    });
  }
  return result.data;
}
