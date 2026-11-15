import "server-only";
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  InternalServerError,
  NotImplementedError,
  RateLimitError,
  RequestTimeoutError,
} from "@anthropic-ai/sdk";
import { RetryableError } from "@/lib/errors";

/**
 * AI-layer error taxonomy.
 *
 *   RetryableError     transient (rate limit, network, 5xx). The job worker should back off and retry.
 *   AiPermanentError   retrying the same input will not help. Mark the job/video failed with `message`.
 *     AiRefusalError   Claude (and the server-side fallback chain) declined the request.
 *     AiOutputError    the model's output stayed invalid after the single repair retry.
 *     AiInputError     the input cannot be processed (e.g. empty transcript).
 *
 * Every class carries a boolean `retryable`, so callers that don't want to import these classes can
 * branch on `(err as { retryable?: boolean }).retryable === true`.
 *
 * Config problems (missing ANTHROPIC_API_KEY) surface as ConfigError from "@/lib/env" and are permanent.
 */

// RetryableError lives in the shared module so AI, TTS and jobs use one class.
export { RetryableError, isRetryableError } from "@/lib/errors";

export class AiPermanentError extends Error {
  readonly retryable = false as const;
  readonly status: number | null;

  constructor(message: string, opts: { cause?: unknown; status?: number | null } = {}) {
    super(message, { cause: opts.cause });
    this.name = "AiPermanentError";
    this.status = opts.status ?? null;
  }
}

export class AiRefusalError extends AiPermanentError {
  /** stop_details.category from the API (e.g. "cyber", "bio"), or null when not given. */
  readonly category: string | null;

  constructor(category: string | null, explanation?: string | null) {
    const cat = category ? ` (category: ${category})` : "";
    const why = explanation ? ` ${explanation}` : "";
    super(`Claude declined to process this content${cat}, so this step can't be completed.${why}`.trim());
    this.name = "AiRefusalError";
    this.category = category;
  }
}

export class AiOutputError extends AiPermanentError {
  readonly problems: string[];

  constructor(task: string, problems: string[]) {
    super(`The AI returned invalid output for ${task} after a repair attempt: ${problems.join("; ")}`);
    this.name = "AiOutputError";
    this.problems = problems;
  }
}

export class AiInputError extends AiPermanentError {
  constructor(message: string) {
    super(message);
    this.name = "AiInputError";
  }
}

/** Reads retry-after-ms / retry-after (seconds or HTTP date) from an SDK error's headers. */
export function retryAfterFromHeaders(headers: Headers | undefined | null, now = Date.now()): number | null {
  if (!headers || typeof headers.get !== "function") return null;
  const ms = headers.get("retry-after-ms");
  if (ms !== null) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  const ra = headers.get("retry-after");
  if (ra !== null) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return null;
}

/**
 * Maps an error thrown by the Anthropic SDK onto the AI error taxonomy.
 * Uses the SDK's typed classes (never message matching). Non-SDK errors are returned unchanged.
 *
 * Retryable: RateLimitError (429), APIConnectionError (incl. timeouts), InternalServerError (5xx,
 * incl. 529 overloaded, except 501), RequestTimeoutError (408).
 * Everything else (400 bad request, 401/403 auth, 404 model not found, 413, 422, user abort) is permanent.
 */
export function classifyAnthropicError(err: unknown): unknown {
  if (err instanceof RetryableError || err instanceof AiPermanentError) return err;
  if (!(err instanceof APIError)) return err;

  if (err instanceof APIUserAbortError) {
    return new AiPermanentError("The AI request was aborted.", { cause: err });
  }
  if (err instanceof RateLimitError) {
    return new RetryableError("Claude API rate limit reached; will retry.", {
      cause: err,
      status: 429,
      retryAfterMs: retryAfterFromHeaders(err.headers),
    });
  }
  if (err instanceof APIConnectionError) {
    return new RetryableError("Could not reach the Claude API (network error or timeout); will retry.", { cause: err });
  }
  if (err instanceof InternalServerError && !(err instanceof NotImplementedError)) {
    return new RetryableError(`Claude API is temporarily unavailable (HTTP ${err.status}); will retry.`, {
      cause: err,
      status: err.status,
      retryAfterMs: retryAfterFromHeaders(err.headers),
    });
  }
  if (err instanceof RequestTimeoutError) {
    return new RetryableError("Claude API request timed out (HTTP 408); will retry.", { cause: err, status: 408 });
  }

  const status = typeof err.status === "number" ? err.status : null;
  const detail = err.apiMessage ?? err.message;
  const hint =
    status === 401 || status === 403
      ? " Check ANTHROPIC_API_KEY."
      : status === 404
        ? " Check CLAUDE_MODEL."
        : "";
  return new AiPermanentError(`Claude API request failed${status ? ` (HTTP ${status})` : ""}: ${detail}.${hint}`, {
    cause: err,
    status,
  });
}
