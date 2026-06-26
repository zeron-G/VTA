/**
 * A READ-ONLY Canvas LMS REST client.
 *
 * Hard guarantees:
 *   - WRITE GUARD: `request()` throws `CanvasReadOnlyError` for any method other
 *     than GET. There is no code path that issues a mutating request. This is a
 *     policy boundary, not a convenience — Canvas is treated as an immutable
 *     source of truth.
 *   - FERPA: enrollments are sanitized to (userId, name, role) before leaving
 *     the client; emails are never returned. There is NO method that fetches
 *     quiz questions.
 *
 * Operational behavior:
 *   - Bearer auth via the supplied token.
 *   - Link-header pagination (rel="next") is followed transparently for `list*`.
 *   - `X-Rate-Limit-Remaining` is honored: when the bucket runs low we pause
 *     briefly before the next request.
 *   - 429 and 5xx responses are retried with bounded exponential backoff.
 */

import { createLogger, toError } from '@vta/shared';
import type { Logger } from '@vta/shared';

import { CanvasApiError, CanvasReadOnlyError } from './errors.js';
import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCourse,
  CanvasEnrollment,
  CanvasFile,
  CanvasId,
  CanvasModule,
  CanvasPage,
  CanvasRawEnrollment,
} from './types.js';

/** Construction options for {@link CanvasClient}. */
export interface CanvasClientOptions {
  /** Instance base URL, e.g. "https://jhu.instructure.com". */
  readonly baseUrl: string;
  /** Canvas API access token (Bearer). Never logged. */
  readonly token: string;
  /** Injectable fetch for testing; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Optional logger; a named child logger is created if omitted. */
  readonly logger?: Logger;
  /** Max retry attempts for 429/5xx before giving up. Default 4. */
  readonly maxRetries?: number;
  /** Safety cap on pagination to avoid unbounded loops. Default 100 pages. */
  readonly maxPages?: number;
}

/** A query value; arrays expand to repeated `key[]=v` params (Canvas style). */
type QueryValue = string | number | boolean | ReadonlyArray<string | number | boolean>;
type Query = Readonly<Record<string, QueryValue | undefined>>;

/** Default JHU Canvas instance. */
const DEFAULT_BASE_URL = 'https://jhu.instructure.com';
/** Below this many remaining rate-limit tokens, slow down before the next call. */
const RATE_LIMIT_LOW_WATERMARK = 50;
/** Base backoff in ms; multiplied by 2^attempt with jitter. */
const BACKOFF_BASE_MS = 500;
/** Upper bound for any single backoff sleep. */
const BACKOFF_MAX_MS = 10_000;

export class CanvasClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly maxRetries: number;
  private readonly maxPages: number;

  constructor(options: CanvasClientOptions) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = options.token;
    // Bind to avoid `Illegal invocation` when fetch is the global.
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.log = options.logger ?? createLogger({ name: 'canvas-client' });
    this.maxRetries = options.maxRetries ?? 4;
    this.maxPages = options.maxPages ?? 100;
  }

  // ---------------------------------------------------------------------------
  // Read-only public API. Every method below issues GET requests only.
  // ---------------------------------------------------------------------------

  /** Fetch a single course. */
  async getCourse(courseId: CanvasId): Promise<CanvasCourse> {
    return this.requestJson<CanvasCourse>('GET', `/api/v1/courses/${courseId}`);
  }

  /**
   * Fetch the course syllabus HTML. Returns `null` when no syllabus is set.
   * Requests the course with `include[]=syllabus_body`, since the field is
   * otherwise omitted.
   */
  async getSyllabus(courseId: CanvasId): Promise<string | null> {
    const course = await this.requestJson<CanvasCourse>(
      'GET',
      `/api/v1/courses/${courseId}`,
      { 'include[]': 'syllabus_body' },
    );
    return course.syllabus_body ?? null;
  }

  /** List all wiki pages (metadata; bodies are NOT included by Canvas here). */
  async listPages(courseId: CanvasId): Promise<CanvasPage[]> {
    return this.requestPaged<CanvasPage>('GET', `/api/v1/courses/${courseId}/pages`, {
      per_page: 100,
    });
  }

  /** Fetch a single page (including its rendered HTML `body`) by slug. */
  async getPage(courseId: CanvasId, pageUrl: string): Promise<CanvasPage> {
    const slug = encodeURIComponent(pageUrl);
    return this.requestJson<CanvasPage>(
      'GET',
      `/api/v1/courses/${courseId}/pages/${slug}`,
    );
  }

  /** List all assignments (descriptions are included on this endpoint). */
  async listAssignments(courseId: CanvasId): Promise<CanvasAssignment[]> {
    return this.requestPaged<CanvasAssignment>(
      'GET',
      `/api/v1/courses/${courseId}/assignments`,
      { per_page: 100 },
    );
  }

  /** Fetch a single assignment. */
  async getAssignment(
    courseId: CanvasId,
    assignmentId: CanvasId,
  ): Promise<CanvasAssignment> {
    return this.requestJson<CanvasAssignment>(
      'GET',
      `/api/v1/courses/${courseId}/assignments/${assignmentId}`,
    );
  }

  /**
   * List announcements (discussion topics filtered to announcements). Canvas
   * exposes these via the discussion_topics endpoint with the
   * `only_announcements` flag.
   */
  async listAnnouncements(courseId: CanvasId): Promise<CanvasAnnouncement[]> {
    return this.requestPaged<CanvasAnnouncement>(
      'GET',
      `/api/v1/courses/${courseId}/discussion_topics`,
      { only_announcements: true, per_page: 100 },
    );
  }

  /**
   * List modules with their items inlined (`include[]=items`).
   * NOTE: for very large modules Canvas may truncate inlined items and require
   * a follow-up to .../modules/:id/items. We request a high `per_page`; if an
   * instance truncates, a future enhancement can backfill per module.
   * TODO(verify): item-inlining truncation threshold varies by instance.
   */
  async listModules(courseId: CanvasId): Promise<CanvasModule[]> {
    return this.requestPaged<CanvasModule>(
      'GET',
      `/api/v1/courses/${courseId}/modules`,
      { 'include[]': 'items', per_page: 100 },
    );
  }

  /** List file metadata for a course. Binary content is NOT downloaded here. */
  async listFiles(courseId: CanvasId): Promise<CanvasFile[]> {
    return this.requestPaged<CanvasFile>('GET', `/api/v1/courses/${courseId}/files`, {
      per_page: 100,
    });
  }

  /**
   * List course enrollments, SANITIZED to (userId, name, role) only.
   *
   * The raw Canvas payload carries `user.email` and other PII; we strip it here
   * so no email ever leaves this method. This is the only enrollment surface
   * the package exposes.
   */
  async listEnrollments(courseId: CanvasId): Promise<CanvasEnrollment[]> {
    const raw = await this.requestPaged<CanvasRawEnrollment>(
      'GET',
      `/api/v1/courses/${courseId}/enrollments`,
      { per_page: 100 },
    );
    return raw.map((e) => sanitizeEnrollment(e)).filter((e): e is CanvasEnrollment => e !== null);
  }

  // ---------------------------------------------------------------------------
  // Internal request machinery.
  // ---------------------------------------------------------------------------

  /**
   * Issue a single GET and parse JSON. Throws on non-2xx (after retries).
   * NOTE: deliberately not generic over method — only GET is reachable, and the
   * write guard in {@link request} enforces it.
   */
  private async requestJson<T>(method: string, path: string, query?: Query): Promise<T> {
    const { body } = await this.request(method, path, query);
    return JSON.parse(body) as T;
  }

  /**
   * Issue a GET and follow `Link: rel="next"` pagination, concatenating the
   * JSON arrays from each page. Canvas list endpoints always return a top-level
   * array, so we type the page as `T[]`.
   */
  private async requestPaged<T>(method: string, path: string, query?: Query): Promise<T[]> {
    const out: T[] = [];
    let nextUrl: string | undefined = this.buildUrl(path, query);
    let pages = 0;

    while (nextUrl !== undefined) {
      if (pages >= this.maxPages) {
        this.log.warn(
          { path, maxPages: this.maxPages },
          'canvas pagination cap reached; truncating results',
        );
        break;
      }
      const { body, linkNext } = await this.requestAbsolute(method, nextUrl);
      const parsed = JSON.parse(body) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) out.push(item as T);
      } else {
        // Some endpoints wrap results; we only paginate arrays. Surface clearly.
        throw new CanvasApiError('Expected a JSON array from a list endpoint', {
          method,
          url: nextUrl,
        });
      }
      nextUrl = linkNext;
      pages += 1;
    }
    return out;
  }

  /**
   * Core request: builds the URL from a relative path then delegates to
   * {@link requestAbsolute}. The WRITE GUARD lives in `requestAbsolute`.
   */
  private async request(
    method: string,
    path: string,
    query?: Query,
  ): Promise<{ body: string; linkNext: string | undefined }> {
    return this.requestAbsolute(method, this.buildUrl(path, query));
  }

  /**
   * Perform the HTTP request against an already-built absolute URL, with the
   * write guard, rate-limit backoff, and bounded retry. Returns the response
   * body text and the parsed `rel="next"` link (if any).
   */
  private async requestAbsolute(
    method: string,
    url: string,
  ): Promise<{ body: string; linkNext: string | undefined }> {
    // ---- HARD WRITE GUARD --------------------------------------------------
    // Canvas is read-only by policy. Refuse anything that is not a GET, before
    // any network call is made.
    if (method.toUpperCase() !== 'GET') {
      throw new CanvasReadOnlyError(method.toUpperCase(), url);
    }

    const headers = new Headers({
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    });

    let attempt = 0;
    // Retry loop: bounded by maxRetries for retryable (429/5xx/transport) errors.
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers });
      } catch (cause) {
        // Transport-level failure (DNS, connection reset, etc.).
        if (attempt < this.maxRetries) {
          await this.backoff(attempt, undefined);
          attempt += 1;
          continue;
        }
        throw new CanvasApiError(`Canvas request failed: ${toError(cause).message}`, {
          method: 'GET',
          url,
          retryable: true,
        });
      }

      // Respect rate-limit headers BEFORE deciding success/failure so we slow
      // down even on successful responses when the bucket is nearly empty.
      await this.maybeThrottle(response);

      if (response.ok) {
        const body = await response.text();
        return { body, linkNext: parseNextLink(response.headers.get('link')) };
      }

      const status = response.status;
      const retryable = status === 429 || (status >= 500 && status <= 599);
      if (retryable && attempt < this.maxRetries) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        await this.backoff(attempt, retryAfterMs);
        attempt += 1;
        continue;
      }

      // Drain the body for context but never include it wholesale (may be large
      // or contain incidental data); we record only a short prefix.
      const errBody = await safeText(response);
      throw new CanvasApiError(
        `Canvas API error ${status}: ${errBody.slice(0, 200)}`,
        { method: 'GET', url, status, retryable },
      );
    }
  }

  /**
   * If the response signals the rate-limit bucket is nearly exhausted, sleep
   * briefly to let it refill. Canvas exposes `X-Rate-Limit-Remaining` as a
   * float "cost remaining" value.
   * TODO(verify): header name casing and units across instances.
   */
  private async maybeThrottle(response: Response): Promise<void> {
    const remainingRaw = response.headers.get('x-rate-limit-remaining');
    if (remainingRaw === null) return;
    const remaining = Number.parseFloat(remainingRaw);
    if (Number.isFinite(remaining) && remaining < RATE_LIMIT_LOW_WATERMARK) {
      this.log.debug({ remaining }, 'canvas rate limit low; throttling');
      await sleep(BACKOFF_BASE_MS);
    }
  }

  /** Sleep for an exponentially backed-off, jittered, capped interval. */
  private async backoff(attempt: number, retryAfterMs: number | undefined): Promise<void> {
    const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    // Honor a server-provided Retry-After if it is larger than our computed delay.
    const base = retryAfterMs !== undefined ? Math.max(retryAfterMs, exponential) : exponential;
    const jitter = Math.floor(Math.random() * (BACKOFF_BASE_MS / 2));
    const delay = Math.min(BACKOFF_MAX_MS, base + jitter);
    this.log.debug({ attempt, delay }, 'canvas backoff before retry');
    await sleep(delay);
  }

  /** Build an absolute URL from a relative path + query params (Canvas style). */
  private buildUrl(path: string, query?: Query): string {
    const url = new URL(path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }
}

// -----------------------------------------------------------------------------
// Pure helpers (module-private).
// -----------------------------------------------------------------------------

/**
 * Strip a raw Canvas enrollment down to (userId, name, role). Returns `null`
 * when the payload lacks the minimum identifying fields. The email is
 * intentionally never read into the result.
 */
function sanitizeEnrollment(raw: CanvasRawEnrollment): CanvasEnrollment | null {
  const userId = raw.user?.id ?? raw.user_id;
  if (userId === undefined) return null;
  const name = raw.user?.name ?? raw.user?.short_name ?? `User ${userId}`;
  const role = raw.role ?? raw.type ?? 'unknown';
  return { userId, name, role };
}

/**
 * Parse an HTTP `Link` header and return the URL whose rel is "next", or
 * `undefined`. Format: `<url>; rel="next", <url>; rel="last"`.
 */
function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?([^"]+)"?/);
    if (match && match[2] === 'next' && match[1]) {
      return match[1];
    }
  }
  return undefined;
}

/** Parse a `Retry-After` header (seconds, or an HTTP date) into milliseconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && String(seconds) === value.trim()) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/** Read a response body as text without throwing (used on error paths). */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
