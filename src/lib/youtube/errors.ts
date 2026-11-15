export type YouTubeErrorCode =
  | "quota" // daily quota or rate limit exhausted
  | "not_found" // playlist/video does not exist or was deleted
  | "private" // exists but cannot be read with an API key
  | "bad_key" // API key invalid / API not enabled / key restricted
  | "bad_request" // malformed id or request
  | "unsupported" // e.g. live or upcoming broadcasts, empty playlists
  | "upstream" // 5xx or unexpected payload from YouTube
  | "network"; // fetch failed / timed out

/**
 * Error raised by YouTube providers. `message` is safe to show to end users
 * (it never contains the API key or request URL). `retryable` hints the job runner.
 */
export class YouTubeError extends Error {
  readonly code: YouTubeErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: YouTubeErrorCode, message: string, opts: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "YouTubeError";
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? (code === "upstream" || code === "network");
  }
}

export function isYouTubeError(err: unknown): err is YouTubeError {
  return err instanceof YouTubeError;
}
