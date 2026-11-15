import "server-only";
import { getEnv } from "@/lib/env";
import { createMockTranscriptProvider } from "./mock";
import type { TranscriptProvider } from "./provider";
import { CAPTION_GAP_MS, createYoutubeiTranscriptProvider } from "./youtubei";

export type { TranscriptProvider, TranscriptResult } from "./provider";
export { parseManualTranscript, parseTimestamp } from "./manual";

export { captionLimitRemainingMs } from "./youtubei";

/**
 * Factory selected by TRANSCRIPT_PROVIDER (youtubei|mock). Neither mode needs an API key.
 * The returned provider never throws for missing captions: it resolves to null and the
 * pipeline marks the video transcript_status='needs_manual'. The youtubei provider throws a
 * retryable error while YouTube is rate-limiting caption downloads; it is paced to one video
 * per CAPTION_GAP_MS so a playlist is not asked for in one burst.
 */
export function getTranscriptProvider(): TranscriptProvider {
  return getEnv().TRANSCRIPT_PROVIDER === "youtubei"
    ? createYoutubeiTranscriptProvider({ minGapMs: CAPTION_GAP_MS })
    : createMockTranscriptProvider();
}
