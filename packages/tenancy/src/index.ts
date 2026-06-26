/**
 * `@vta/tenancy` — the multi-tenant front door.
 *
 * Given a normalized inbound message, this package resolves the owning course
 * (tenant), the user's role within that course, and the course's resolved,
 * validated configuration. It also OWNS the canonical TypeScript shapes for the
 * per-course config blobs that `@vta/data` stores as `jsonb` — later waves
 * (notably `@vta/governance`) import `ContentRules` and friends from here.
 *
 * Public surface:
 *   - types:   the config shapes + zod schemas + DEFAULT_* constants.
 *   - service: `TenancyService` (the aggregating entry point) and its types.
 *   - resolvers / loaders: `CourseResolver`, `RoleResolver`, `loadCourseConfig`.
 */

// Config shapes, schemas, and defaults (owned here; imported by later waves).
export type {
  ChannelMap,
  DiscordChannelBinding,
  EmailChannelBinding,
  WebChannelBinding,
  ContentRules,
  RateLimitConfig,
  LocaleConfig,
  ResolvedCourseConfig,
} from './types.js';
export {
  channelMapSchema,
  discordChannelBindingSchema,
  emailChannelBindingSchema,
  webChannelBindingSchema,
  contentRulesSchema,
  rateLimitConfigSchema,
  localeConfigSchema,
  DEFAULT_CONTENT_RULES,
  DEFAULT_RATE_LIMIT,
  DEFAULT_LOCALE_CONFIG,
} from './types.js';

// Config loading.
export { loadCourseConfig } from './config.js';
export type { ConfigLoaderDeps } from './config.js';

// Course (tenant) resolution.
export { CourseResolver } from './courseResolver.js';
export type { CourseResolverDeps } from './courseResolver.js';

// Role resolution.
export { RoleResolver } from './roleResolver.js';
export type { RoleResolverDeps } from './roleResolver.js';

// The aggregating front door.
export { TenancyService } from './tenancyService.js';
export type {
  TenancyServiceDeps,
  InboundRouting,
  ResolvedTenantContext,
} from './tenancyService.js';
