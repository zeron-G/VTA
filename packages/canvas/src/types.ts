/**
 * Minimal typed shapes for the Canvas LMS resources this package reads.
 *
 * These are deliberately PARTIAL: Canvas returns large, loosely-specified JSON
 * objects whose exact shape varies by instance version and feature flags. We
 * model only the fields the ingestion pipeline consumes, mark everything that
 * may legitimately be absent as optional, and never assume the presence of a
 * field we did not request.
 *
 * FERPA-aware design choices baked into these types:
 *   - There is NO type for quiz questions. Quiz questions are never fetched or
 *     indexed (a deliberate policy choice mirrored from the production system),
 *     so no shape exists to tempt a caller into reading them.
 *   - `CanvasEnrollment` is SANITIZED: it carries a user id, a display name, and
 *     a role ONLY. Student emails (and any other PII Canvas would otherwise
 *     return) are stripped at the client boundary and never modelled here.
 *
 * Field-shape uncertainty is flagged with `TODO(verify)` against the Canvas
 * REST API docs (https://canvas.instructure.com/doc/api/). Where a field's
 * exact union of values is unknown we keep it as `string`.
 */

/** Canvas numeric ids are integers in JSON; we normalize them to `number`. */
export type CanvasId = number;

/**
 * A Canvas course.
 * Canvas REST: GET /api/v1/courses/:id
 * TODO(verify): `workflow_state` is a string enum
 * ('unpublished' | 'available' | 'completed' | 'deleted'); kept as `string`.
 */
export interface CanvasCourse {
  readonly id: CanvasId;
  readonly name: string;
  /** Short course code, e.g. "EN.601.226". May be absent on some instances. */
  readonly course_code?: string;
  readonly workflow_state?: string;
  /**
   * Syllabus HTML. Only present when the request includes `?include[]=syllabus_body`.
   * May be `null` when unset.
   */
  readonly syllabus_body?: string | null;
}

/**
 * A Canvas wiki page.
 * Canvas REST: GET /api/v1/courses/:id/pages and .../pages/:url
 * The list endpoint omits `body`; the single-page endpoint includes it.
 */
export interface CanvasPage {
  /** Stable slug used as the page locator in URLs (e.g. "week-1-overview"). */
  readonly url: string;
  readonly title: string;
  /** Rendered HTML body. Present on the single-page endpoint only. */
  readonly body?: string | null;
  /** ISO-8601 timestamp of the last edit, if reported. */
  readonly updated_at?: string;
  readonly published?: boolean;
  /** Canvas also exposes a numeric page id on some instances. */
  readonly page_id?: CanvasId;
}

/**
 * A Canvas assignment.
 * Canvas REST: GET /api/v1/courses/:id/assignments and .../assignments/:id
 * TODO(verify): `submission_types` is `string[]`; we keep it loosely typed.
 */
export interface CanvasAssignment {
  readonly id: CanvasId;
  readonly name: string;
  /** Rendered HTML description / prompt. May be `null`. */
  readonly description?: string | null;
  /** ISO-8601 due date, or `null` when undated. */
  readonly due_at?: string | null;
  readonly points_possible?: number | null;
  readonly published?: boolean;
  /** Canonical Canvas web URL for the assignment, if returned. */
  readonly html_url?: string;
  readonly submission_types?: readonly string[];
}

/**
 * A Canvas announcement. Announcements are discussion topics surfaced through
 * the announcements endpoint, so they share the DiscussionTopic shape.
 * Canvas REST: GET /api/v1/courses/:id/discussion_topics?only_announcements=true
 */
export interface CanvasDiscussionTopic {
  readonly id: CanvasId;
  readonly title: string;
  /** Rendered HTML message body. May be `null`. */
  readonly message?: string | null;
  /** ISO-8601 publish/post time, if reported. */
  readonly posted_at?: string | null;
  readonly html_url?: string;
  /** True when this topic is an announcement rather than a forum thread. */
  readonly is_announcement?: boolean;
}

/** Alias matching the domain vocabulary used by callers. */
export type CanvasAnnouncement = CanvasDiscussionTopic;

/**
 * An item inside a module (a link to a page, assignment, file, sub-header, etc.).
 * Canvas REST: items are returned inline when listing modules with
 * `?include[]=items`, or via .../modules/:id/items.
 * TODO(verify): `type` enum includes
 * 'File' | 'Page' | 'Discussion' | 'Assignment' | 'Quiz' | 'SubHeader' |
 * 'ExternalUrl' | 'ExternalTool'; kept as `string`.
 */
export interface CanvasModuleItem {
  readonly id: CanvasId;
  readonly title: string;
  readonly type: string;
  /** Position within the module (1-based in Canvas). */
  readonly position?: number;
  /** Indentation level for nested presentation. */
  readonly indent?: number;
  /** Web URL for the item in Canvas, if any. */
  readonly html_url?: string;
  /** For ExternalUrl items, the external target. */
  readonly external_url?: string;
  /** Id of the linked content (page url / assignment id / file id), when present. */
  readonly content_id?: CanvasId;
  /** For Page items, the page slug. */
  readonly page_url?: string;
}

/**
 * A Canvas module (an ordered grouping of items).
 * Canvas REST: GET /api/v1/courses/:id/modules
 */
export interface CanvasModule {
  readonly id: CanvasId;
  readonly name: string;
  readonly position?: number;
  readonly published?: boolean;
  /** Present when listed with `?include[]=items`. */
  readonly items?: readonly CanvasModuleItem[];
}

/**
 * A Canvas file.
 * Canvas REST: GET /api/v1/courses/:id/files
 * We index file METADATA only; binary content extraction (PDF/PPTX text) is the
 * job of a later stage, not this client.
 * TODO(verify): `display_name` is the user-facing name; `filename` is the raw
 * upload name. Both can be present.
 */
export interface CanvasFile {
  readonly id: CanvasId;
  readonly display_name?: string;
  readonly filename?: string;
  /** MIME type, e.g. "application/pdf". */
  readonly ['content-type']?: string;
  readonly size?: number;
  /** Time-limited download URL. NOTE: short-lived; do not persist as canonical. */
  readonly url?: string;
  readonly updated_at?: string;
  /** `true` when the file is unpublished / locked from students. */
  readonly locked?: boolean;
  /** `true` when the file is hidden from students (not shown in Files). */
  readonly hidden?: boolean;
}

/**
 * A SANITIZED course enrollment.
 *
 * This is NOT the raw Canvas enrollment object. The client strips the nested
 * `user` object down to id + display name + role before any enrollment leaves
 * the package. Emails and other PII are intentionally absent from this type so
 * they cannot be logged, indexed, or forwarded to the RAG layer.
 */
export interface CanvasEnrollment {
  readonly userId: CanvasId;
  readonly name: string;
  /**
   * Canvas role string, e.g. 'StudentEnrollment' | 'TaEnrollment' |
   * 'TeacherEnrollment' | 'DesignerEnrollment' | 'ObserverEnrollment'.
   */
  readonly role: string;
}

/**
 * The RAW Canvas enrollment shape, used ONLY internally while sanitizing. It is
 * not exported as part of the public surface. The `user` sub-object is where
 * Canvas would expose PII (email, sis ids); we read only id + name from it.
 * TODO(verify): on some instances the display name lives at `user.name`, on
 * others at top-level `user.short_name`; we prefer `name` and fall back.
 */
export interface CanvasRawEnrollment {
  readonly id?: CanvasId;
  readonly user_id?: CanvasId;
  readonly type?: string;
  readonly role?: string;
  readonly user?: {
    readonly id?: CanvasId;
    readonly name?: string;
    readonly short_name?: string;
    /** Present in raw payloads; DELIBERATELY never copied into CanvasEnrollment. */
    readonly email?: string;
  };
}

/**
 * The bridge type the `@vta/rag` package consumes.
 *
 * It maps 1:1 onto the persistable columns of the `materials` table in
 * `@vta/data` (`sourceType`, `externalId`, `title`, `kind`, `contentHash`,
 * `uri`) plus the `markdown` body that RAG will chunk and embed. Producing this
 * shape is the entire externally-visible point of the Canvas package.
 */
export interface NormalizedMaterial {
  /** Always 'canvas' for material produced by this package. */
  readonly sourceType: 'canvas';
  /**
   * Stable, source-system identifier for change detection and upsert. Encodes
   * both the kind and the Canvas id/slug, e.g. "page:week-1-overview" or
   * "assignment:12345", so ids never collide across resource kinds.
   */
  readonly externalId: string;
  readonly title: string;
  /** Free-form kind label, e.g. 'page' | 'assignment' | 'announcement' | 'module' | 'syllabus'. */
  readonly kind: string;
  /** Clean Markdown body (HTML normalized via turndown). */
  readonly markdown: string;
  /** SHA-256 hex of the markdown body, for idempotent ingestion. */
  readonly contentHash: string;
  /** Canonical Canvas web URL for the source, when known. */
  readonly uri?: string;
}
