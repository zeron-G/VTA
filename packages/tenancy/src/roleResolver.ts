/**
 * Role resolution within a course.
 *
 * A thin wrapper over `MembershipRepository.resolveRole`. Roles are strictly
 * per-(course, user): the same user may be a TA in one course and a student in
 * another, so a `courseId` is always required. An unknown (user, course) pair
 * resolves to the baseline `'standard'` role — the repository already applies
 * this default, but it is restated here so the contract is explicit at the
 * tenancy boundary.
 */

import { DEFAULT_COURSE_ROLE } from '@vta/shared';
import type { CourseId, CourseRole, UserId } from '@vta/shared';
import { MembershipRepository } from '@vta/data';
import type { Db } from '@vta/data';

/** Dependencies for role resolution. */
export interface RoleResolverDeps {
  readonly db: Db;
}

/** Resolves a user's membership tier within a single course. */
export class RoleResolver {
  private readonly memberships: MembershipRepository;

  constructor(deps: RoleResolverDeps) {
    this.memberships = new MembershipRepository(deps.db);
  }

  /**
   * Resolve `userId`'s role within `courseId`. Defaults to `'standard'` when no
   * membership row exists.
   */
  async resolveRole(courseId: CourseId, userId: UserId): Promise<CourseRole> {
    if (courseId.length === 0 || userId.length === 0) {
      return DEFAULT_COURSE_ROLE;
    }
    return this.memberships.resolveRole(courseId, userId);
  }
}
