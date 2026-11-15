import "server-only";
import { getEnv, requireEnv } from "@/lib/env";
import { createAnthropicClient, createAnthropicProvider } from "./anthropic";
import { createMockAiProvider } from "./mock";
import type { AiProvider } from "./provider";

export type { AiProvider } from "./provider";
export {
  AiInputError,
  AiOutputError,
  AiPermanentError,
  AiRefusalError,
  RetryableError,
  classifyAnthropicError,
  isRetryableError,
} from "./errors";
export { formatTimestamp, formatTranscript } from "./transcript";
export { ClipPlanSchema } from "./schemas";
export { defaultClip, heuristicClip, isShortVideo, normalizeClip, wholeVideoClip } from "./clip";
export { heuristicMoments, momentCount, normalizeMoments, wholeMoment } from "./moments";

/**
 * Factory selected by AI_PROVIDER (anthropic|mock). Call it at job time: with
 * AI_PROVIDER=anthropic and no ANTHROPIC_API_KEY it throws a ConfigError.
 *
 * Server-side refusal fallbacks are on by default only for models that support them; set
 * CLAUDE_REFUSAL_FALLBACK=0 to turn them off everywhere.
 */
export function getAiProvider(): AiProvider {
  const env = getEnv();
  if (env.AI_PROVIDER === "anthropic") {
    const apiKey = requireEnv("ANTHROPIC_API_KEY", "AI_PROVIDER=anthropic");
    // undefined = provider default (on for supported models); false = explicitly off.
    const refusalFallback = env.CLAUDE_REFUSAL_FALLBACK ? undefined : false;
    return createAnthropicProvider({
      client: createAnthropicClient(apiKey),
      model: env.CLAUDE_MODEL,
      effort: env.CLAUDE_EFFORT,
      refusalFallback,
      onUsage: ({ task, model, usage }) => {
        const u = usage as { input_tokens?: number; output_tokens?: number } | undefined;
        console.info(`[ai] ${task} on ${model}: ${u?.input_tokens ?? "?"} in / ${u?.output_tokens ?? "?"} out tokens`);
      },
    });
  }
  return createMockAiProvider();
}
