/**
 * `@vta/admin` — the operator CLI for onboarding a course and ingesting its
 * Canvas materials. This is the ADMIN entrypoint the system was missing: a
 * fresh database is empty, so it cannot answer anything until a course exists,
 * its channels are mapped, its staff have roles, and its Canvas content has
 * been ingested into retrievable chunks. This CLI drives exactly that path.
 *
 * It deliberately uses NO argument-parsing framework — just a hand-rolled argv
 * dispatcher — so the operational surface stays dependency-free and obvious.
 *
 * Boundaries it respects:
 *   - Tenancy: every write is scoped to a single course resolved by its slug.
 *     Channel/role/ingest commands all key off that one resolved course id.
 *   - Secrets: Canvas tokens and LLM keys are NEVER read or printed here. They
 *     are resolved inside `CourseIngestionService` via the `SecretsProvider`.
 *
 * The Db pool and SecretsProvider are built ONCE at startup and shared by every
 * subcommand.
 */

import { config as loadDotenv } from 'dotenv';
import { CourseIngestionService } from '@vta/core';
import {
  createDb,
  CourseRepository,
  CourseConfigRepository,
  MembershipRepository,
  UserRepository,
} from '@vta/data';
import type { Db } from '@vta/data';
import type { ChannelMap as StoredChannelMap, ContentRules as StoredContentRules } from '@vta/data';
import { DEFAULT_CONTENT_RULES } from '@vta/tenancy';
import {
  loadConfig,
  createSecretsProvider,
  createLogger,
  COURSE_ROLES,
  NotFoundError,
} from '@vta/shared';
import type { SecretsProvider, CourseRole } from '@vta/shared';
import { loadProfile } from '@vta/llm';
import type { LlmProfileName } from '@vta/llm';

// Load a local `.env` (if present) before reading process config. No-op when
// the file is absent, so production deployments that inject real env still work.
loadDotenv();

/* -------------------------------------------------------------------------- */
/* Tiny argv flag parser (no framework)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parse `--flag value` / `--flag=value` pairs out of an argv tail. Bare flags
 * (a `--flag` with no following value) map to the empty string. Returns a plain
 * record; callers validate required flags themselves.
 */
function parseFlags(args: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = '';
    }
  }
  return flags;
}

/** Read a flag that must be present and non-empty, else throw a usage error. */
function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined || value === '') {
    throw new UsageError(`missing required flag --${name}`);
  }
  return value;
}

/** An operator-facing error: a bad/missing flag or unknown command. */
class UsageError extends Error {}

/** Narrow an arbitrary string to a known `CourseRole`, or throw a usage error. */
function asCourseRole(value: string): CourseRole {
  if ((COURSE_ROLES as readonly string[]).includes(value)) {
    return value as CourseRole;
  }
  throw new UsageError(
    `invalid --role "${value}" (expected one of: ${COURSE_ROLES.join(', ')})`,
  );
}

/* -------------------------------------------------------------------------- */
/* Shared context                                                             */
/* -------------------------------------------------------------------------- */

interface Ctx {
  readonly db: Db;
  readonly secrets: SecretsProvider;
  /** Active LLM profile name (drives the `embed` role used during ingest). */
  readonly llmProfile: LlmProfileName;
}

/**
 * Resolve a course by slug or throw a `NotFoundError`. Centralized so every
 * course-scoped command shares the same tenant resolution and error message.
 */
async function resolveCourseId(
  courseRepo: CourseRepository,
  slug: string,
): Promise<string> {
  const course = await courseRepo.getBySlug(slug);
  if (course === undefined) {
    throw new NotFoundError('course', slug);
  }
  return course.id;
}

/* -------------------------------------------------------------------------- */
/* Subcommands                                                                */
/* -------------------------------------------------------------------------- */

/** `course:add` — register/refresh a course and seed its default config. */
async function cmdCourseAdd(ctx: Ctx, flags: Record<string, string>): Promise<void> {
  const slug = requireFlag(flags, 'slug');
  const name = requireFlag(flags, 'name');
  const canvasCourseId = requireFlag(flags, 'canvas-id');
  const orgId = flags['org'];

  const courseRepo = new CourseRepository(ctx.db);
  const configRepo = new CourseConfigRepository(ctx.db);

  const course = await courseRepo.upsert({
    slug,
    name,
    canvasCourseId,
    ...(orgId !== undefined && orgId !== '' ? { orgId } : {}),
  });

  // Seed config with safe governance defaults and an empty channel map. The
  // tenancy `DEFAULT_CONTENT_RULES` is structurally assignable to the stored
  // (permissive) content-rules column.
  await configRepo.upsert(course.id, {
    courseId: course.id,
    channelMap: {},
    // The stored column is intentionally permissive (jsonb / index-signature);
    // the tenancy DEFAULT_CONTENT_RULES is the authoritative shape we persist.
    contentRules: DEFAULT_CONTENT_RULES as unknown as StoredContentRules,
  });

  process.stdout.write(
    `added course "${course.slug}" (${course.name}) id=${course.id} canvas=${String(
      course.canvasCourseId,
    )}\n`,
  );
}

/** `course:map-channel` — bind a Discord channel id to a course. */
async function cmdCourseMapChannel(
  ctx: Ctx,
  flags: Record<string, string>,
): Promise<void> {
  const slug = requireFlag(flags, 'slug');
  const channel = requireFlag(flags, 'channel');
  const guild = flags['guild'];

  const courseRepo = new CourseRepository(ctx.db);
  const configRepo = new CourseConfigRepository(ctx.db);

  const courseId = await resolveCourseId(courseRepo, slug);
  const existing = await configRepo.get(courseId);

  // The STORED channel map (the `@vta/data` shape) keeps channel ids as a flat
  // `readonly string[]` under `discord`. The richer tenancy `ChannelMap` (with
  // a Discord guildId) is reconstructed at read time by `loadCourseConfig`; the
  // column itself cannot persist a guildId, so `--guild` is informational only.
  const current: StoredChannelMap = existing?.channelMap ?? {};
  const discordIds = new Set<string>(current.discord ?? []);
  discordIds.add(channel);
  const nextChannelMap: StoredChannelMap = {
    ...current,
    discord: [...discordIds],
  };

  await configRepo.upsert(courseId, {
    courseId,
    channelMap: nextChannelMap,
    // Re-supply the remaining columns so the upsert does not blank them. When a
    // config row already exists we carry its values forward; otherwise we seed
    // the same defaults `course:add` would have written.
    contentRules: (existing?.contentRules ?? DEFAULT_CONTENT_RULES) as unknown as StoredContentRules,
    ...(existing?.locales !== undefined ? { locales: existing.locales } : {}),
    ...(existing?.rateLimit != null ? { rateLimit: existing.rateLimit } : {}),
    ...(existing?.welcomeText != null ? { welcomeText: existing.welcomeText } : {}),
  });

  const guildNote = guild !== undefined && guild !== '' ? ` (guild ${guild} noted, not persisted)` : '';
  process.stdout.write(
    `mapped discord channel ${channel} -> course "${slug}"${guildNote}\n`,
  );
}

/** `course:set-role` — set a user's role within a course by their Discord id. */
async function cmdCourseSetRole(
  ctx: Ctx,
  flags: Record<string, string>,
): Promise<void> {
  const slug = requireFlag(flags, 'slug');
  const discordId = requireFlag(flags, 'discord-id');
  const role = asCourseRole(requireFlag(flags, 'role'));
  const displayName = flags['name'];

  const courseRepo = new CourseRepository(ctx.db);
  const userRepo = new UserRepository(ctx.db);
  const membershipRepo = new MembershipRepository(ctx.db);

  const courseId = await resolveCourseId(courseRepo, slug);
  const user = await userRepo.upsertByDiscordId(
    discordId,
    displayName !== undefined && displayName !== '' ? displayName : undefined,
  );
  await membershipRepo.setRole(courseId, user.id, role);

  process.stdout.write(
    `set role "${role}" for user ${user.displayName} (discord ${discordId}, id ${user.id}) in course "${slug}"\n`,
  );
}

/** `course:ingest` — sync a course's Canvas content into retrievable chunks. */
async function cmdCourseIngest(
  ctx: Ctx,
  flags: Record<string, string>,
): Promise<void> {
  const slug = requireFlag(flags, 'slug');

  const courseRepo = new CourseRepository(ctx.db);
  const course = await courseRepo.getBySlug(slug);
  if (course === undefined) {
    throw new NotFoundError('course', slug);
  }
  if (course.canvasCourseId === null || course.canvasCourseId === '') {
    throw new UsageError(
      `course "${slug}" has no canvasCourseId; set one with course:add --canvas-id <id>`,
    );
  }

  const ingestion = new CourseIngestionService({
    db: ctx.db,
    secrets: ctx.secrets,
    mapping: loadProfile(ctx.llmProfile),
    logger: createLogger({ name: 'admin-ingest' }),
  });

  process.stdout.write(
    `ingesting course "${slug}" (canvas ${course.canvasCourseId})...\n`,
  );
  const stats = await ingestion.ingestCourse(course.id, course.canvasCourseId);
  process.stdout.write(
    `ingest complete: materialsProcessed=${stats.materialsProcessed} ` +
      `materialsChanged=${stats.materialsChanged} chunksWritten=${stats.chunksWritten} ` +
      `materialsRemoved=${stats.materialsRemoved ?? 0}\n`,
  );
}

/** `course:list` — list every registered course. */
async function cmdCourseList(ctx: Ctx): Promise<void> {
  const courseRepo = new CourseRepository(ctx.db);
  const all = await courseRepo.list();
  if (all.length === 0) {
    process.stdout.write('no courses registered\n');
    return;
  }
  for (const c of all) {
    process.stdout.write(
      `${c.slug}\t${c.name}\tcanvas=${c.canvasCourseId === null ? '-' : c.canvasCourseId}\n`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Usage                                                                      */
/* -------------------------------------------------------------------------- */

const USAGE = `@vta/admin — course onboarding & Canvas ingestion CLI

Usage: vta-admin <command> [--flags]

Commands:
  course:add          --slug <s> --name <n> --canvas-id <id> [--org <uuid>]
                      Register/refresh a course and seed default config.

  course:map-channel  --slug <s> --channel <discordChannelId> [--guild <id>]
                      Bind a Discord channel to a course (adds to channelMap.discord).

  course:set-role     --slug <s> --discord-id <id> --role <admin|privileged|standard> [--name <displayName>]
                      Resolve/create the user and set their role in the course.

  course:ingest       --slug <s>
                      Sync the course's Canvas content into retrievable chunks.

  course:list
                      List all registered courses (slug, name, canvasCourseId).

Required environment:
  DATABASE_URL          Postgres (pgvector) connection string.
  LLM_PROFILE           dev | prod (default dev). Drives the embed model on ingest.
  SECRETS_PROVIDER      env | keyvault (default env).
  CANVAS_TOKEN_<SLUG>   Per-course Canvas API token (e.g. CANVAS_TOKEN_CS101).
  CANVAS_BASEURL_<SLUG> Optional per-course Canvas base URL override.
  OPENAI_API_KEY        Resolved as openai.api-key for embeddings during ingest.
`;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    // Treat a bare invocation as an error so scripts notice a missing command,
    // but an explicit `help` request exits cleanly.
    process.exitCode = command === undefined ? 2 : 0;
    return;
  }

  // Build shared infrastructure ONCE. `loadConfig` fails fast on a bad env.
  const appConfig = loadConfig();
  const db = createDb(appConfig.DATABASE_URL);
  const secrets = createSecretsProvider({
    provider: appConfig.SECRETS_PROVIDER,
    ...(appConfig.AZURE_KEY_VAULT_URL !== undefined
      ? { vaultUrl: appConfig.AZURE_KEY_VAULT_URL }
      : {}),
    env: process.env,
  });
  const ctx: Ctx = { db, secrets, llmProfile: appConfig.LLM_PROFILE };

  const flags = parseFlags(rest);

  switch (command) {
    case 'course:add':
      await cmdCourseAdd(ctx, flags);
      break;
    case 'course:map-channel':
      await cmdCourseMapChannel(ctx, flags);
      break;
    case 'course:set-role':
      await cmdCourseSetRole(ctx, flags);
      break;
    case 'course:ingest':
      await cmdCourseIngest(ctx, flags);
      break;
    case 'course:list':
      await cmdCourseList(ctx);
      break;
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`error: ${err.message}\n\n`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  // Never print secrets: surface only the error's message, not its full object.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
