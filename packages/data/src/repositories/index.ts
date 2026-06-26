/**
 * Repositories barrel. Every repository is course-scoped (the tenant unit is a
 * course); cross-course access throws `TenantMismatchError` via `guardCourse`.
 */

export { guardCourse } from "./guard.js";

export { CourseRepository } from "./CourseRepository.js";
export { UserRepository } from "./UserRepository.js";
export { MembershipRepository } from "./MembershipRepository.js";
export { CourseConfigRepository } from "./CourseConfigRepository.js";
export { MaterialRepository } from "./MaterialRepository.js";
export type { ChunkInput } from "./MaterialRepository.js";
export { ChunkRepository } from "./ChunkRepository.js";
export type { ChunkSearchHit } from "./ChunkRepository.js";
export { AuditRepository } from "./AuditRepository.js";
