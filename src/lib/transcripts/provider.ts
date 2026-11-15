import type { TranscriptSegment, TranscriptSource } from "@/lib/types";

export interface TranscriptResult {
  /** Sorted by start, non-empty text, seconds. */
  segments: TranscriptSegment[];
  /** BCP-47-ish language code from YouTube ("en", "en-GB", "es"), or "und" when unknown. */
  lang: string;
  /** Matches the transcripts.source column ('youtubei' | 'mock'; 'manual' is written by the API route). */
  source: TranscriptSource;
}

export interface TranscriptProvider {
  /**
   * Returns null when no transcript is available (video becomes transcript_status='needs_manual').
   * Throws only an error with `retryable === true`, when the source is limiting requests and the
   * video should be tried again later; never anything else.
   */
  fetch(videoId: string): Promise<TranscriptResult | null>;
}
