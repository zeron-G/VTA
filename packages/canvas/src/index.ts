/**
 * `@vta/canvas` — a READ-ONLY Canvas LMS client plus HTML->Markdown
 * normalization. This is the ingestion SOURCE that `@vta/rag` consumes: it
 * fetches course materials from Canvas and emits `NormalizedMaterial` records
 * keyed by a stable content hash.
 *
 * Policy invariants (enforced in code, not just docs):
 *   - Canvas is read-only: any non-GET request throws `CanvasReadOnlyError`.
 *   - No method fetches quiz QUESTIONS.
 *   - Enrollments are sanitized to (userId, name, role); emails are never returned.
 */

export { CanvasClient } from './client.js';
export type { CanvasClientOptions } from './client.js';

export { CanvasApiError, CanvasReadOnlyError } from './errors.js';
export type { CanvasApiErrorContext } from './errors.js';

export {
  htmlToMarkdown,
  contentHash,
  toNormalizedPage,
  toNormalizedAssignment,
  toNormalizedAnnouncement,
  toNormalizedModule,
  toNormalizedSyllabus,
} from './content.js';

export type {
  CanvasId,
  CanvasCourse,
  CanvasPage,
  CanvasAssignment,
  CanvasDiscussionTopic,
  CanvasAnnouncement,
  CanvasModule,
  CanvasModuleItem,
  CanvasFile,
  CanvasEnrollment,
  CanvasRawEnrollment,
  NormalizedMaterial,
} from './types.js';
