/**
 * Canvas-specific errors.
 *
 * Both extend the shared `VtaError` so the audit log and adapters can classify
 * them by the stable `code` field rather than string-matching messages. We use
 * the `'INTERNAL'` code (Canvas failures are an internal integration concern,
 * not a user-facing policy outcome) and stash the HTTP status + URL in the
 * structured `context` for operational logging.
 *
 * NOTE: `context` must be pre-redacted of secrets. We never put the bearer
 * token or full Authorization header into context — only method, status, and a
 * sanitized URL (query string preserved, but the token never appears there).
 */

import { VtaError } from '@vta/shared';

/** Structured context attached to a failed Canvas API call. */
export interface CanvasApiErrorContext extends Record<string, unknown> {
  readonly method: string;
  readonly url: string;
  /** HTTP status code, when a response was received. */
  readonly status?: number;
  /** Whether the failure was retryable (429 / 5xx) before giving up. */
  readonly retryable?: boolean;
}

/**
 * A Canvas REST call failed: non-2xx response, or transport error after retries
 * were exhausted. Carries the HTTP status and request URL in `context`.
 */
export class CanvasApiError extends VtaError {
  constructor(message: string, context: CanvasApiErrorContext) {
    super('INTERNAL', message, context);
  }
}

/**
 * The hard write-guard tripped: a non-GET method was requested. Canvas is
 * read-only by policy, so any attempt to mutate is a programming error and is
 * surfaced as a thrown error rather than silently downgraded.
 */
export class CanvasReadOnlyError extends VtaError {
  constructor(method: string, url: string) {
    super(
      'INTERNAL',
      `Canvas is read-only: refusing non-GET request "${method} ${url}"`,
      { method, url },
    );
  }
}
