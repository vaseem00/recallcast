import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, resetEnvCache } from "@/lib/env";
import type { TranscriptSegment, VideoMeta } from "@/lib/types";
import { getAiProvider } from "./index";

const saved = { ...process.env };

const video: VideoMeta = {
  youtubeVideoId: "vidINDEX001",
  title: "How memory works",
  channel: "Brain Lab",
  durationS: 900,
  thumbnail: "",
  position: 0,
};

const segments: TranscriptSegment[] = Array.from({ length: 180 }, (_, i) => ({
  start: i * 5,
  dur: 5,
  text: `Sentence ${i} explains retrieval practice, spacing and consolidation in memory number ${i}.`,
}));

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe("getAiProvider", () => {
  it("defaults to the mock (heuristic) provider in tests", async () => {
    resetEnvCache();
    const ai = getAiProvider();
    const clip = await ai.pickClip({ video, segments });
    expect(clip.picked).toBe("heuristic");
    expect(clip.end).toBeGreaterThan(clip.start);
  });

  it("throws a ConfigError at call time when the anthropic key is missing", () => {
    process.env.AI_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    resetEnvCache();
    expect(() => getAiProvider()).toThrow(ConfigError);
    expect(() => getAiProvider()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("builds the anthropic provider without any network call", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
    process.env.CLAUDE_REFUSAL_FALLBACK = "0";
    resetEnvCache();
    const ai = getAiProvider();
    expect(typeof ai.pickClip).toBe("function");
  });
});
