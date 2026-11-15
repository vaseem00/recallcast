/**
 * Shared error contract for every provider and the job worker.
 *
 *   RetryableError  transient failure (rate limit, network, 5xx). The worker backs off and retries,
 *                   never sooner than `retryAfterMs` when the upstream sent a hint.
 *
 * Every provider error carries a boolean `retryable`. The worker branches only on that flag
 * (see src/lib/jobs/errors.ts isRetryable), so provider-specific classes such as YouTubeError
 * (whose retryability depends on its code) do not need to extend this class.
 * Messages on these errors are written to be shown to end users.
 */
export class RetryableError extends Error {
  readonly retryable = true as const;
  /** Server-suggested delay before retrying, when the upstream sent one (retry-after headers). */
  readonly retryAfterMs: number | null;
  readonly status: number | null;

  constructor(message: string, opts: { cause?: unknown; retryAfterMs?: number | null; status?: number | null } = {}) {
    super(message, { cause: opts.cause });
    this.name = "RetryableError";
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.status = opts.status ?? null;
  }
}

export function isRetryableError(err: unknown): err is RetryableError {
  return err instanceof RetryableError;
}
