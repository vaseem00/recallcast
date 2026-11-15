import { MOCK_TRANSCRIPT_SEGMENTS } from "./fixture";
import type { TranscriptProvider, TranscriptResult } from "./provider";

/**
 * Offline transcript provider (TRANSCRIPT_PROVIDER=mock): returns the same ~2-minute
 * English fixture for every video id.
 *
 * Test hook: a video id containing "NOCAP" resolves to null, which exercises the
 * transcript_status='needs_manual' path without any network.
 */
export function createMockTranscriptProvider(): TranscriptProvider {
  return {
    async fetch(videoId: string): Promise<TranscriptResult | null> {
      if (typeof videoId !== "string" || !videoId || videoId.includes("NOCAP")) return null;
      return {
        segments: MOCK_TRANSCRIPT_SEGMENTS.map((s) => ({ ...s })),
        lang: "en",
        source: "mock",
      };
    },
  };
}
