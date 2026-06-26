/**
 * The per-request governance context.
 *
 * Every chokepoint (ingress, tool gate, egress) is evaluated against exactly
 * one course's policy and one acting user's role. Bundling these into a single
 * immutable value keeps the governor method signatures small and makes it
 * impossible to evaluate a request against the wrong tenant's rules.
 */

import type { CourseId, CourseRole } from '@vta/shared';
import type { ContentRules } from '@vta/tenancy';

export interface GovernanceContext {
  /** The tenant boundary: which course's policy applies. */
  readonly courseId: CourseId;
  /** The acting user's membership tier within {@link courseId}. */
  readonly role: CourseRole;
  /**
   * The resolved content policy for {@link courseId}. Sourced from
   * `@vta/tenancy` (`ResolvedCourseConfig.contentRules`); already has
   * `DEFAULT_CONTENT_RULES` applied for any missing fields.
   */
  readonly rules: ContentRules;
  /** Correlates every verdict from this request with the operational logs/traces. */
  readonly requestId: string;
}
