import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { getTranscriptProvider, parseManualTranscript } from "./index";
import { MOCK_TRANSCRIPT_SEGMENTS } from "./fixture";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
  vi.unstubAllGlobals();
});

describe("mock transcript provider", () => {
  it("returns a realistic ~2 minute English transcript without network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await getTranscriptProvider().fetch("mockVid0001");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.lang).toBe("en");
    expect(result!.source).toBe("mock");

    const segs = result!.segments;
    expect(segs.length).toBeGreaterThanOrEqual(20);
    const end = segs[segs.length - 1].start + segs[segs.length - 1].dur;
    expect(end).toBeGreaterThanOrEqual(100);
    expect(end).toBeLessThanOrEqual(140);
    for (let i = 0; i < segs.length; i++) {
      expect(segs[i].text.length).toBeGreaterThan(0);
      expect(segs[i].dur).toBeGreaterThan(0);
      if (i > 0) expect(segs[i].start).toBeCloseTo(segs[i - 1].start + segs[i - 1].dur, 5);
    }
    const words = segs.map((s) => s.text).join(" ").split(/\s+/).length;
    expect(words).toBeGreaterThan(200);
  });

  it("is deterministic and returns copies", async () => {
    const a = await getTranscriptProvider().fetch("abcdefghijk");
    const b = await getTranscriptProvider().fetch("zyxwvutsrqp");
    expect(a).toEqual(b);
    a!.segments[0].text = "mutated";
    expect(MOCK_TRANSCRIPT_SEGMENTS[0].text).not.toBe("mutated");
  });

  it("returns null for ids containing NOCAP (needs_manual test hook)", async () => {
    await expect(getTranscriptProvider().fetch("xxNOCAPxxxx")).resolves.toBeNull();
  });
});

describe("getTranscriptProvider factory", () => {
  it("builds the youtubei provider without needing any key", () => {
    process.env.TRANSCRIPT_PROVIDER = "youtubei";
    resetEnvCache();
    const p = getTranscriptProvider();
    expect(typeof p.fetch).toBe("function");
  });

  it("youtubei provider resolves null for an invalid id without loading youtubei.js", async () => {
    process.env.TRANSCRIPT_PROVIDER = "youtubei";
    resetEnvCache();
    await expect(getTranscriptProvider().fetch("not-an-id")).resolves.toBeNull();
  });
});

describe("parseManualTranscript re-export", () => {
  it("is exported from the module index", () => {
    expect(parseManualTranscript("0:01 hi\n0:02 there")).toHaveLength(2);
  });
});
