import "server-only";
import type { AiProvider } from "@/lib/ai/provider";
import type { TranscriptProvider } from "@/lib/transcripts/provider";
import type { YouTubeProvider } from "@/lib/youtube/provider";

/**
 * Provider wiring for the job handlers.
 *
 * Pipeline steps take concrete providers as arguments (dependency injection). The worker gets
 * them through a ProviderResolver, which is asked only for the providers a job actually needs,
 * at job time. The default resolver loads each factory module lazily, so:
 *   - a missing key for one real provider (e.g. ANTHROPIC_API_KEY) fails only the jobs that
 *     need it, with the factory's ConfigError, never server start or unrelated jobs;
 *   - the heavy SDKs (Anthropic, youtubei.js) are not loaded by instrumentation at boot.
 */

export interface Providers {
  youtube: YouTubeProvider;
  transcripts: TranscriptProvider;
  ai: AiProvider;
}

export type ProviderKey = keyof Providers;
export type ProviderResolver = <K extends ProviderKey>(key: K) => Promise<Providers[K]>;

/** Resolver backed by the env-selected factories (getYouTubeProvider() etc.), called per job. */
export const defaultProviderResolver: ProviderResolver = async (key) => {
  switch (key) {
    case "youtube":
      return (await import("@/lib/youtube")).getYouTubeProvider() as Providers[typeof key];
    case "transcripts":
      return (await import("@/lib/transcripts")).getTranscriptProvider() as Providers[typeof key];
    case "ai":
      return (await import("@/lib/ai")).getAiProvider() as Providers[typeof key];
    default:
      throw new Error(`Unknown provider: ${String(key)}`);
  }
};

/** Resolver over fixed instances (tests). Asking for a provider that was not given throws. */
export function staticProviders(p: Partial<Providers>): ProviderResolver {
  return async (key) => {
    const v = p[key];
    if (!v) throw new Error(`Provider "${key}" was not supplied`);
    return v as Providers[typeof key];
  };
}
