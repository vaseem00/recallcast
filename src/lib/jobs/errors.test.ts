import { describe, expect, it } from "vitest";
import { AiInputError, AiOutputError, AiPermanentError, AiRefusalError, RetryableError } from "@/lib/ai/errors";
import { ConfigError } from "@/lib/env";
import { YouTubeError } from "@/lib/youtube/errors";
import { BUSY_MESSAGE, PipelineError, internalMessage, publicMessage } from "./errors";

const FALLBACK = "Something went wrong while preparing this episode. Please retry.";

describe("publicMessage", () => {
  // Before the fix every error with a boolean `retryable` (and ConfigError) was shown verbatim,
  // so end users saw the operator's billing, quota and configuration state.
  it("never shows operator-side provider or configuration details", () => {
    const leaks = [
      new ConfigError("Missing environment variable ANTHROPIC_API_KEY (required by AI_PROVIDER=anthropic). Set it in .env.local."),
      new AiPermanentError("Claude API request failed (HTTP 400): Your credit balance is too low to access the Anthropic API.", { status: 400 }),
      new AiPermanentError("Claude API request failed (HTTP 401): invalid x-api-key. Check ANTHROPIC_API_KEY.", { status: 401 }),
      new AiOutputError("clip pick", ["The output was not valid JSON."]),
      new YouTubeError("bad_key", "The YouTube API key is invalid or the API is not enabled."),
      new YouTubeError("quota", "The YouTube API daily quota is used up."),
    ];
    for (const err of leaks) {
      const msg = publicMessage(err, FALLBACK);
      expect(msg).toBe(FALLBACK);
      expect(internalMessage(err)).toContain(err.message.slice(0, 20)); // kept for operators
    }
  });

  it("maps transient errors that outlasted every retry to a generic busy message", () => {
    for (const err of [
      new RetryableError("Claude API rate limit reached; will retry.", { status: 429 }),
      new YouTubeError("upstream", "YouTube returned HTTP 503"),
    ]) {
      expect(publicMessage(err, FALLBACK)).toBe(BUSY_MESSAGE);
    }
  });

  it("keeps messages about the user's own content or link", () => {
    expect(publicMessage(new PipelineError("This playlist has no public videos we can process."), FALLBACK)).toBe(
      "This playlist has no public videos we can process.",
    );
    expect(publicMessage(new AiRefusalError("cyber"), FALLBACK)).toMatch(/^Claude declined to process this content/);
    expect(publicMessage(new AiInputError("This transcript is too long to process."), FALLBACK)).toBe(
      "This transcript is too long to process.",
    );
    expect(
      publicMessage(new YouTubeError("not_found", "YouTube playlist not found. It may be private or deleted."), FALLBACK),
    ).toBe("YouTube playlist not found. It may be private or deleted.");
  });

  it("uses the fallback for unknown errors and non-Error values", () => {
    expect(publicMessage(new TypeError("x is undefined"), FALLBACK)).toBe(FALLBACK);
    expect(publicMessage("boom", FALLBACK)).toBe(FALLBACK);
  });
});
