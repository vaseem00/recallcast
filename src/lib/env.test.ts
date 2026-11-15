import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, getEnv, requireEnv, resetEnvCache } from "@/lib/env";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe("env", () => {
  it("applies spec defaults", () => {
    delete process.env.MAX_VIDEOS_PER_PLAYLIST;
    delete process.env.CLAUDE_MODEL;
    process.env.CLAUDE_EFFORT = "";
    resetEnvCache();
    const env = getEnv();
    expect(env.MAX_VIDEOS_PER_PLAYLIST).toBe(25);
    expect(env.MAX_VIDEO_SECONDS).toBe(10800);
    expect(env.MAX_PLAYLISTS_PER_USER_PER_DAY).toBe(5);
    expect(env.CLAUDE_MODEL).toBe("claude-haiku-5-5");
    expect(env.CLAUDE_EFFORT).toBe("medium");
    expect(env.AI_PROVIDER).toBe("mock");
  });

  it("coerces numbers and booleans", () => {
    process.env.MAX_VIDEOS_PER_PLAYLIST = "7";
    process.env.WORKER_ENABLED = "false";
    resetEnvCache();
    expect(getEnv().MAX_VIDEOS_PER_PLAYLIST).toBe(7);
    expect(getEnv().WORKER_ENABLED).toBe(false);
  });

  it("throws ConfigError lazily for malformed values", () => {
    process.env.AI_PROVIDER = "openai";
    resetEnvCache();
    expect(() => getEnv()).toThrow(ConfigError);
  });

  it("SAMPLE_FEED takes the copied share link or its id, and refuses anything else", () => {
    const slug = "Ab3_dE-6gH9jKl2mNo5pQr";
    for (const value of [slug, `https://recallcast.example.com/r/${slug}`, `http://localhost:3000/r/${slug}/`, `/r/${slug}?utm=x#top`]) {
      process.env.SAMPLE_FEED = value;
      resetEnvCache();
      expect(getEnv().SAMPLE_FEED).toBe(slug);
    }
    process.env.SAMPLE_FEED = "";
    resetEnvCache();
    expect(getEnv().SAMPLE_FEED).toBeUndefined();
    for (const bad of ["https://recallcast.example.com/app/reels", "too-short", `${slug}x`]) {
      process.env.SAMPLE_FEED = bad;
      resetEnvCache();
      expect(() => getEnv()).toThrow(/SAMPLE_FEED: must be a share link/);
    }
  });

  it("requireEnv names the missing variable", () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetEnvCache();
    expect(() => requireEnv("ANTHROPIC_API_KEY", "AI_PROVIDER=anthropic")).toThrow(
      /ANTHROPIC_API_KEY.*AI_PROVIDER=anthropic/,
    );
  });
});
