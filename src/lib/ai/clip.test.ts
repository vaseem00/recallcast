import { describe, expect, it } from "vitest";
import type { TranscriptSegment, VideoMeta } from "@/lib/types";
import {
  CLIP_MAX_S,
  CLIP_MIN_S,
  CLIP_TARGET_S,
  WHOLE_VIDEO_MAX_S,
  clipExcerpt,
  defaultClip,
  heuristicClip,
  isShortVideo,
  normalizeClip,
  videoLength,
  wholeVideoClip,
  type ClipContext,
} from "./clip";

function video(durationS: number, title = "How memory works"): VideoMeta {
  return { youtubeVideoId: "vidCLIP0001", title, channel: "Brain Lab", durationS, thumbnail: "", position: 0 };
}

/** Captions every `step` seconds, each `dur` long, covering [0, length). */
function captions(length: number, step = 5, dur = step, text = (i: number) => `Caption ${i} about spaced retrieval practice.`) {
  return Array.from({ length: Math.floor(length / step) }, (_, i): TranscriptSegment => ({ start: i * step, dur, text: text(i) }));
}

const LONG: ClipContext = { video: video(1200), segments: captions(1200) };
const labels = { title: "The forgetting curve", summary: "Why memories fade.", reason: "It is the core idea." };

describe("constants", () => {
  it("keep the clip bounds consistent", () => {
    expect(CLIP_MIN_S).toBeLessThan(CLIP_TARGET_S);
    expect(CLIP_TARGET_S).toBeLessThan(CLIP_MAX_S);
    expect(CLIP_MAX_S).toBeLessThan(WHOLE_VIDEO_MAX_S);
  });
});

describe("videoLength / isShortVideo", () => {
  it("is the larger of the stated duration and the transcript end", () => {
    expect(videoLength({ video: video(600), segments: captions(100) })).toBe(600);
    expect(videoLength({ video: video(100), segments: [{ start: 118.2, dur: 3.3, text: "x" }] })).toBe(122);
    expect(videoLength({ video: video(0), segments: [] })).toBe(0);
  });
  it("short means known and at most WHOLE_VIDEO_MAX_S", () => {
    expect(isShortVideo({ video: video(WHOLE_VIDEO_MAX_S), segments: [] })).toBe(true);
    expect(isShortVideo({ video: video(WHOLE_VIDEO_MAX_S + 1), segments: [] })).toBe(false);
    expect(isShortVideo({ video: video(0), segments: [] })).toBe(false);
  });
});

describe("normalizeClip", () => {
  it("accepts a valid window without notes, snapping to caption boundaries", () => {
    // 100.7 is inside the caption at 100; 310 is inside the caption 310-315.
    const { clip, notes } = normalizeClip({ start: 100.7, end: 310, ...labels }, LONG, "ai");
    expect(notes).toEqual([]);
    expect(clip).toEqual({ start: 100, end: 315, ...labels, picked: "ai" });
  });

  it("snaps start back to the caption that contains it", () => {
    expect(normalizeClip({ start: 104.4, end: 300, ...labels }, LONG, "ai").clip.start).toBe(100);
    // within half a second of the next caption counts as that caption
    expect(normalizeClip({ start: 104.6, end: 300, ...labels }, LONG, "ai").clip.start).toBe(105);
  });

  it("never extends the end past CLIP_MAX_S to finish a caption", () => {
    const ctx: ClipContext = { video: video(1200), segments: captions(1200, 10) }; // 10-second captions
    const { clip, notes } = normalizeClip({ start: 0, end: 254, ...labels }, ctx, "ai");
    expect(notes).toEqual([]);
    expect(clip.end).toBe(254); // the caption 250-260 would make it 260 s long
    const ok = normalizeClip({ start: 0, end: 244, ...labels }, ctx, "ai").clip;
    expect(ok.end).toBe(250); // 240-250 fits, so the end moves to the caption end
  });

  it("replaces a too-short window with CLIP_TARGET_S and notes it", () => {
    const { clip, notes } = normalizeClip({ start: 100, end: 150, ...labels }, LONG, "ai");
    expect(notes).toEqual([`the window was 50 seconds, shorter than ${CLIP_MIN_S}`]);
    expect(clip.start).toBe(100);
    expect(clip.end - clip.start).toBeGreaterThanOrEqual(CLIP_TARGET_S);
    expect(clip.end - clip.start).toBeLessThanOrEqual(CLIP_MAX_S);
  });

  it("replaces a too-long window with CLIP_TARGET_S and notes it", () => {
    const { clip, notes } = normalizeClip({ start: 100, end: 700, ...labels }, LONG, "ai");
    expect(notes).toEqual([`the window was 600 seconds, longer than ${CLIP_MAX_S}`]);
    expect(clip).toMatchObject({ start: 100, end: 315 });
  });

  it("swaps a reversed window", () => {
    const { clip, notes } = normalizeClip({ start: 400, end: 190, ...labels }, LONG, "ai");
    expect(notes).toContain("end was before start");
    expect(clip).toMatchObject({ start: 190, end: 405 });
  });

  it("handles non-numeric and negative times", () => {
    const a = normalizeClip({ start: Number.NaN, end: Number.NaN, ...labels }, LONG, "ai");
    expect(a.notes).toEqual(expect.arrayContaining(["start was not a number", "end was not a number"]));
    expect(a.clip.start).toBe(0);
    expect(a.clip.end - a.clip.start).toBeGreaterThanOrEqual(CLIP_MIN_S);
    const b = normalizeClip({ start: -30, end: 180, ...labels }, LONG, "ai");
    expect(b.clip.start).toBe(0);
    expect(b.clip.end).toBe(185);
  });

  it("moves a start too close to the end back and never ends past the video", () => {
    const late = normalizeClip({ start: 1150, end: 1300, ...labels }, LONG, "ai");
    expect(late.notes).toContain("start was too close to the end of the video");
    expect(late.clip).toMatchObject({ start: 1200 - CLIP_TARGET_S, end: 1200 });

    const over = normalizeClip({ start: 1000, end: 1250, ...labels }, LONG, "ai");
    expect(over.clip.end).toBe(1200);
    expect(over.clip.end - over.clip.start).toBeGreaterThanOrEqual(CLIP_MIN_S);

    // The video is longer than its transcript: the end is bounded by the stated duration.
    const ctx: ClipContext = { video: video(400), segments: captions(300) };
    const tail = normalizeClip({ start: 240, end: 480, ...labels }, ctx, "ai").clip;
    expect(tail.end).toBeLessThanOrEqual(400);
    expect(tail.end - tail.start).toBeGreaterThanOrEqual(CLIP_MIN_S);
  });

  it("plays a short video in full whatever the proposal", () => {
    const ctx: ClipContext = { video: video(200), segments: captions(200) };
    const { clip } = normalizeClip({ start: 50, end: 90, ...labels }, ctx, "ai");
    expect(clip).toMatchObject({ start: 0, end: 200, picked: "ai" });
  });

  it("outputs whole seconds with end > start", () => {
    for (const [s, e] of [[10.2, 220.9], [0.4, 0.6], [1199.9, 1199.95]] as const) {
      const { clip } = normalizeClip({ start: s, end: e, ...labels }, LONG, "ai");
      expect(Number.isInteger(clip.start) && Number.isInteger(clip.end)).toBe(true);
      expect(clip.end).toBeGreaterThan(clip.start);
      expect(clip.end).toBeLessThanOrEqual(1200);
    }
  });

  it("cleans the labels and falls back to the video title and the excerpt", () => {
    const { clip, notes } = normalizeClip({ start: 100, end: 310, title: "  <b>Spacing</b>  &amp; recall ", summary: "", reason: "x".repeat(400) }, LONG, "ai");
    expect(clip.title).toBe("b Spacing /b & recall");
    expect(clip.summary).toMatch(/^Caption 20 about spaced retrieval practice\./);
    expect(clip.summary.endsWith("...")).toBe(true);
    expect(clip.reason).toHaveLength(300);
    expect(notes).toEqual([]);

    const untitled = normalizeClip({ start: 100, end: 310 }, LONG, "heuristic");
    expect(untitled.notes).toEqual(["title was empty"]);
    expect(untitled.clip.title).toBe("How memory works");
    expect(untitled.clip.reason).toBe("");
    const nothing = normalizeClip({ start: 100, end: 310 }, { video: video(1200, ""), segments: [] }, "heuristic");
    expect(nothing.clip.title).toBe("Untitled video");
    expect(nothing.clip.summary).toBe('A part of "Untitled video".');
  });
});

describe("clipExcerpt", () => {
  it("joins the captions that start inside the window, optionally capped", () => {
    const segs: TranscriptSegment[] = [
      { start: 20, dur: 5, text: "third" },
      { start: 0, dur: 5, text: "first &amp; one" },
      { start: 9.6, dur: 5, text: "second" },
      { start: 30, dur: 5, text: "outside" },
    ];
    expect(clipExcerpt(segs, 10, 30)).toBe("second third");
    expect(clipExcerpt(segs, 0, 30)).toBe("first & one second third");
    expect(clipExcerpt(segs, 0, 30, 2)).toBe("first &...");
    expect(clipExcerpt([], 0, 30)).toBe("");
  });
});

describe("heuristicClip", () => {
  const SPONSOR = "This video is sponsored by our sponsor, so subscribe, hit the like button and check the link in the description.";
  const CHATTER = "yeah so um really like okay you know right yeah so um really like okay";
  /** 20 min: sponsor read for 5 min, a dense explanation from 5:00 to 8:30, chatter elsewhere. */
  function lecture(): ClipContext {
    const segs = captions(1200, 5, 5, (i) => {
      const t = i * 5;
      if (t < 300) return SPONSOR;
      if (t >= 300 && t < 510) return `hippocampus${i} consolidates engram${i} during sleep${i} while cortex${i} rehearses pattern${i}.`;
      return CHATTER;
    });
    return { video: video(1200), segments: segs };
  }

  it("picks the dense explanation and avoids the sponsor read", () => {
    const clip = heuristicClip(lecture());
    expect(clip.picked).toBe("heuristic");
    expect(clip.start).toBeGreaterThanOrEqual(300);
    expect(clip.start).toBeLessThan(400);
    expect(clip.end - clip.start).toBeGreaterThanOrEqual(CLIP_MIN_S);
    expect(clip.end - clip.start).toBeLessThanOrEqual(CLIP_MAX_S);
    expect(clip.title).toBe("How memory works");
    expect(clip.summary).toMatch(/hippocampus/);
    expect(clip.summary).not.toMatch(/sponsor|subscribe/i);
  });

  it("is deterministic", () => {
    expect(heuristicClip(lecture())).toEqual(heuristicClip(lecture()));
  });

  it("stays inside the video for any transcript", () => {
    const clip = heuristicClip(LONG);
    expect(clip.start).toBeGreaterThanOrEqual(0);
    expect(clip.end).toBeLessThanOrEqual(1200);
    expect(clip.end - clip.start).toBeGreaterThanOrEqual(CLIP_MIN_S);
  });

  it("plays a short video in full and falls back to the default without captions", () => {
    expect(heuristicClip({ video: video(200), segments: captions(200) })).toMatchObject({ start: 0, end: 200, picked: "whole" });
    expect(heuristicClip({ video: video(1200), segments: [] })).toMatchObject({ picked: "nocaptions" });
  });
});

describe("wholeVideoClip / defaultClip", () => {
  it("wholeVideoClip covers the whole video", () => {
    const clip = wholeVideoClip({ video: video(200), segments: captions(200) });
    expect(clip).toMatchObject({ start: 0, end: 200, title: "How memory works", picked: "whole" });
    expect(clip.summary).toMatch(/^Caption 0/);
    expect(wholeVideoClip({ video: video(180), segments: [] }).summary).toBe("The full video, 3 minutes.");
    expect(wholeVideoClip({ video: video(0), segments: [] }).end).toBe(1);
  });

  it("defaultClip starts just after the intro", () => {
    expect(defaultClip({ video: video(1200), segments: [] })).toMatchObject({ start: 120, end: 120 + CLIP_TARGET_S, picked: "nocaptions" });
    // near the end it is pulled back so the window still fits
    expect(defaultClip({ video: video(300), segments: [] })).toMatchObject({ start: 30, end: 240 });
    expect(defaultClip({ video: video(0), segments: [] })).toMatchObject({ start: 0, end: CLIP_TARGET_S });
  });

  it("defaultClip plays a short video in full, still marked nocaptions", () => {
    expect(defaultClip({ video: video(200), segments: [] })).toMatchObject({ start: 0, end: 200, picked: "nocaptions" });
  });
});
