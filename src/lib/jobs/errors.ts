/**
 * Job-layer error helpers.
 *
 * Provider modules (youtube, transcripts, ai, tts) each have their own error classes, but they
 * all agree on one duck-typed contract: an error with `retryable === true` is transient and the
 * job should back off and retry; anything else is permanent. Their messages are written to be
 * shown to end users. The worker relies only on that contract, so this module does not import
 * any provider code. The one shared class, RetryableError, lives in src/lib/errors.ts.
 */
import { RetryableError } from "@/lib/errors";

/** A permanent, user-readable pipeline failure raised by the job steps themselves. */
export class PipelineError extends Error {
  readonly retryable = false as const;
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

/** A transient failure raised by the job steps themselves (worker backs off and retries). */
export class JobRetryableError extends RetryableError {
  constructor(message: string, opts: { retryAfterMs?: number | null; cause?: unknown } = {}) {
    super(message, opts);
    this.name = "JobRetryableError";
  }
}

const MAX_MESSAGE = 500;

function errorLike(err: unknown): { name?: unknown; message?: unknown; retryable?: unknown; code?: unknown } | null {
  return typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
}

/** True when the error says it is transient (`retryable === true`), or SQLite reported a busy/locked DB. */
export function isRetryable(err: unknown): boolean {
  const e = errorLike(err);
  if (!e) return false;
  if (e.retryable === true) return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

/** Server-suggested retry delay (RetryableError.retryAfterMs), when present. */
export function retryAfterOf(err: unknown): number | null {
  const v = (errorLike(err) as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_MESSAGE ? `${t.slice(0, MAX_MESSAGE - 3)}...` : t;
}

/** Shown when a transient error (rate limit, 5xx, network) outlasted every retry. */
export const BUSY_MESSAGE = "This step is busy right now. Please retry in a few minutes.";

/** Errors whose message is about the user's own content or link, written for end users. */
const USER_FACING_ERRORS = new Set(["PipelineError", "AiRefusalError", "AiInputError"]);
/** YouTube error codes that describe the user's link, not the operator's API key or quota. */
const USER_FACING_YOUTUBE_CODES = new Set(["not_found", "private", "unsupported", "bad_request"]);

/**
 * A message that is safe to store on a video/episode/playlist and show to the user.
 *
 * Only errors about the user's own input keep their message (PipelineError, a refusal or
 * unprocessable input from the AI layer, a YouTube link that is missing/private/unsupported).
 * Operator-side failures never reach users: ConfigError (missing keys), provider auth, billing,
 * quota, model and validation errors (Anthropic `apiMessage`, details such as "out of
 * credits") get `fallback`, and exhausted transient errors get BUSY_MESSAGE. The full text stays
 * in jobs.last_error and the server log (internalMessage).
 */
export function publicMessage(err: unknown, fallback: string): string {
  const e = errorLike(err);
  if (e && err instanceof Error && typeof e.message === "string" && e.message.trim()) {
    const name = typeof e.name === "string" ? e.name : "";
    if (USER_FACING_ERRORS.has(name)) return clip(e.message);
    if (name === "YouTubeError" && USER_FACING_YOUTUBE_CODES.has(String(e.code))) return clip(e.message);
    if (e.retryable === true) return clip(BUSY_MESSAGE);
  }
  return clip(fallback);
}

/** A short internal description for logs and jobs.last_error (never shown to users). */
export function internalMessage(err: unknown): string {
  if (err instanceof Error) return clip(`${err.name}: ${err.message}`);
  return clip(String(err));
}
