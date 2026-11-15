import "server-only";
import { getEnv, requireEnv } from "@/lib/env";
import { createYouTubeApiProvider } from "./api";
import { createMockYouTubeProvider } from "./mock";
import type { YouTubeProvider } from "./provider";

export type { YouTubeProvider } from "./provider";
export { YouTubeError, isYouTubeError, type YouTubeErrorCode } from "./errors";
export { parseIsoDuration } from "./duration";
export { parseYouTubeUrl, type ParsedYouTubeUrl } from "./parse";

/**
 * Factory selected by YOUTUBE_PROVIDER (api|mock). Call it at job time: with
 * YOUTUBE_PROVIDER=api and no YOUTUBE_API_KEY it throws a ConfigError.
 */
export function getYouTubeProvider(): YouTubeProvider {
  const env = getEnv();
  if (env.YOUTUBE_PROVIDER === "api") {
    return createYouTubeApiProvider({
      apiKey: requireEnv("YOUTUBE_API_KEY", "YOUTUBE_PROVIDER=api"),
      maxVideos: env.MAX_VIDEOS_PER_PLAYLIST,
    });
  }
  return createMockYouTubeProvider({ maxVideos: env.MAX_VIDEOS_PER_PLAYLIST });
}
