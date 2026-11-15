/**
 * Client-safe YouTube link helpers (no server imports).
 */

const YT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** https://www.youtube.com/watch?v=ID&t=SECONDSs (seconds floored, never negative). */
export function youtubeTimestampUrl(youtubeVideoId: string, seconds: number): string {
  const id = YT_ID_RE.test(youtubeVideoId) ? youtubeVideoId : encodeURIComponent(youtubeVideoId);
  const t = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `https://www.youtube.com/watch?v=${id}&t=${t}s`;
}
