import { describe, expect, it } from "vitest";
import type { TranscriptSegment, VideoMeta } from "@/lib/types";
import { MOCK_TRANSCRIPT_SEGMENTS } from "@/lib/transcripts/fixture";
import {
  MAX_OVERLAP_S,
  MAX_REELS_PER_VIDEO,
  REEL_MAX_S,
  REEL_MIN_S,
  REEL_TARGET_S,
  chapterMoments,
  heuristicMoments,
  hookFromExcerpt,
  isReelLengthVideo,
  momentCount,
  noCaptionMoments,
  normalizeMoments,
  positionMoment,
  sentenceStart,
  wholeMoment,
} from "./moments";

const video = (durationS: number, title = "How memory works"): VideoMeta => ({
  youtubeVideoId: "vidREELS001",
  title,
  channel: "Brain Lab",
  durationS,
  thumbnail: "",
  position: 0,
});

/** One caption every 5 s; every line is a full sentence so the heuristic has words to weigh. */
function captions(totalS: number, text = (i: number) => `Line ${i} explains retrieval practice and spacing.`): TranscriptSegment[] {
  return Array.from({ length: Math.floor(totalS / 5) }, (_, i) => ({ start: i * 5, dur: 5, text: text(i) }));
}

const ctx = (durationS = 1200, segs = captions(durationS)) => ({ video: video(durationS), segments: segs });

describe("momentCount", () => {
  it("gives one reel per five minutes, at least one, at most the cap", () => {
    expect(momentCount(0)).toBe(1);
    expect(momentCount(60)).toBe(1);
    expect(momentCount(REEL_MAX_S)).toBe(1);
    expect(momentCount(420)).toBe(1);
    expect(momentCount(600)).toBe(2);
    expect(momentCount(1200)).toBe(4);
    expect(momentCount(3 * 3600)).toBe(6);
    expect(momentCount(3 * 3600, 3)).toBe(3);
    expect(momentCount(3 * 3600, 99)).toBe(MAX_REELS_PER_VIDEO);
    expect(momentCount(Number.NaN)).toBe(1);
  });
});

describe("normalizeMoments", () => {
  it("keeps valid moments in the given order", () => {
    const { moments, notes } = normalizeMoments(
      [
        { start: 600, end: 660, hook: "Second in time, first in rank", takeaway: "A." },
        { start: 100, end: 155, hook: "Earlier", takeaway: "B." },
      ],
      ctx(),
      "ai",
      4,
    );
    expect(notes).toEqual([]);
    expect(moments).toEqual([
      { start: 600, end: 660, hook: "Second in time, first in rank", takeaway: "A.", picked: "ai" },
      { start: 100, end: 155, hook: "Earlier", takeaway: "B.", picked: "ai" },
    ]);
  });

  it("starts on the caption that contains the proposed start and ends where a caption ends", () => {
    const { moments } = normalizeMoments([{ start: 203, end: 262, hook: "Snapped" }], ctx(), "ai", 1);
    expect(moments[0]).toMatchObject({ start: 200, end: 265 });
  });

  it("brings too-short and too-long windows to the target length and says so", () => {
    const { moments, notes } = normalizeMoments(
      [
        { start: 100, end: 110, hook: "Too short" },
        { start: 400, end: 700, hook: "Too long" },
      ],
      ctx(),
      "ai",
      4,
    );
    expect(moments.map((m) => m.end - m.start)).toEqual([REEL_TARGET_S, REEL_TARGET_S]);
    expect(notes.join(" ")).toMatch(/shorter than 30/);
    expect(notes.join(" ")).toMatch(/longer than 80/);
    for (const m of moments) {
      expect(m.end - m.start).toBeGreaterThanOrEqual(REEL_MIN_S);
      expect(m.end - m.start).toBeLessThanOrEqual(REEL_MAX_S);
    }
  });

  it("drops what cannot be used: non-numbers, the last seconds of the video, overlaps", () => {
    const { moments, notes } = normalizeMoments(
      [
        { start: Number.NaN, end: 50, hook: "Not a number" },
        { start: 100, end: 160, hook: "Kept" },
        { start: 130, end: 190, hook: "Overlaps the kept one" },
        { start: 1190, end: 1250, hook: "Starts at the very end" },
        // Shares 5 seconds with the kept one (captions are 5 s apart), inside the allowance.
        { start: 155, end: 215, hook: "Touches, within the allowance" },
      ],
      ctx(),
      "ai",
      6,
    );
    expect(MAX_OVERLAP_S).toBeGreaterThanOrEqual(5);
    expect(moments.map((m) => m.hook)).toEqual(["Kept", "Touches, within the allowance"]);
    expect(notes).toHaveLength(3);
    expect(notes.join(" ")).toMatch(/not a number/);
    expect(notes.join(" ")).toMatch(/overlapped/);
    expect(notes.join(" ")).toMatch(/last 30 seconds/);
  });

  it("swaps a reversed window and clamps a negative start", () => {
    const { moments } = normalizeMoments(
      [
        { start: 360, end: 300, hook: "Reversed" },
        { start: -20, end: 45, hook: "Negative" },
      ],
      ctx(),
      "ai",
      4,
    );
    expect(moments[0]).toMatchObject({ start: 300, end: 360 });
    expect(moments[1].start).toBe(0);
  });

  it("stops at the requested number", () => {
    const inputs = [0, 100, 200, 300, 400].map((s) => ({ start: s, end: s + 60, hook: `Reel at ${s}` }));
    expect(normalizeMoments(inputs, ctx(), "ai", 2).moments).toHaveLength(2);
  });

  it("writes a hook from the words spoken when none was given, and cleans the labels", () => {
    const { moments, notes } = normalizeMoments(
      [
        { start: 100, end: 160 },
        { start: 300, end: 360, hook: "  <b>Tidy</b>\n me ", takeaway: " One &amp; two. " },
      ],
      ctx(),
      "heuristic",
      4,
    );
    expect(moments[0].hook).toBe("Line 20 explains retrieval practice and spacing.");
    expect(moments[0].picked).toBe("heuristic");
    expect(notes.join(" ")).toMatch(/hook was empty/);
    expect(moments[1].hook).toBe("b Tidy /b me");
    expect(moments[1].takeaway).toBe("One & two.");
  });

  it("works without a transcript (nothing to snap to)", () => {
    const { moments } = normalizeMoments([{ start: 61.4, end: 119.2, hook: "No captions" }], { video: video(600), segments: [] }, "ai", 1);
    expect(moments).toEqual([{ start: 61, end: 120, hook: "No captions", takeaway: "", picked: "ai" }]);
  });

  it("a video of about a minute becomes one whole reel whatever was proposed", () => {
    const short = { video: video(70, "A short one"), segments: captions(70) };
    expect(isReelLengthVideo(short)).toBe(true);
    const { moments } = normalizeMoments([{ start: 10, end: 40, hook: "Ignored window, kept label" }], short, "ai", 3);
    expect(moments).toEqual([expect.objectContaining({ start: 0, end: 70, hook: "Ignored window, kept label", picked: "whole" })]);
    expect(wholeMoment(short)).toMatchObject({ start: 0, end: 70, hook: "A short one", picked: "whole" });
  });

  it("returns nothing for an empty list", () => {
    expect(normalizeMoments([], ctx(), "ai", 3)).toEqual({ moments: [], notes: [] });
  });
});

describe("hookFromExcerpt", () => {
  it("takes the first sentence when the captions are punctuated", () => {
    expect(hookFromExcerpt("Think of memory like a path through grass. Walk it once and it fades.")).toBe(
      "Think of memory like a path through grass.",
    );
  });

  it("takes the first words of unpunctuated auto-captions", () => {
    expect(hookFromExcerpt("so the thing about neurons is that they fire together and then wire together over time")).toBe(
      "so the thing about neurons is that they fire together...",
    );
    expect(hookFromExcerpt("short one")).toBe("short one");
    // A caption's speaker-change marker is not part of the headline.
    expect(hookFromExcerpt("- Was your birthday the greatest ever? - It was.")).toBe("Was your birthday the greatest ever?");
    expect(hookFromExcerpt(">> so here is the thing")).toBe("so here is the thing");
    expect(hookFromExcerpt("   ")).toBe("");
  });
});

describe("heuristicMoments", () => {
  it("picks dense, non-overlapping minutes, best first, and is deterministic", () => {
    // Minutes 5-6 and 12-13 carry varied vocabulary; the rest repeats one sentence.
    const dense = (i: number) =>
      `Fact ${i}: ${["synapses", "myelin", "dopamine", "hippocampus", "cortex", "glia", "axons", "dendrites", "neurons", "plasticity", "encoding", "recall"][i % 12]} shape ${["learning", "habits", "attention", "sleep", "focus", "mood"][i % 6]} through ${["repetition", "novelty", "reward", "rest"][i % 4]} number ${i}.`;
    const segs = captions(1200, (i) => ((i >= 60 && i < 72) || (i >= 144 && i < 156) ? dense(i) : "And so we keep going and going with this."));
    const input = { video: video(1200), segments: segs };
    const a = heuristicMoments(input, 3);
    expect(a).toEqual(heuristicMoments(input, 3));
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.every((m) => m.picked === "heuristic" && m.hook.length > 0)).toBe(true);
    for (const m of a) {
      expect(m.end - m.start).toBeGreaterThanOrEqual(REEL_MIN_S);
      expect(m.end - m.start).toBeLessThanOrEqual(REEL_MAX_S);
    }
    // The two dense minutes are the two strongest picks.
    const top = a.slice(0, 2).map((m) => m.start).sort((x, y) => x - y);
    expect(top[0]).toBeGreaterThanOrEqual(290);
    expect(top[0]).toBeLessThanOrEqual(310);
    expect(top[1]).toBeGreaterThanOrEqual(710);
    expect(top[1]).toBeLessThanOrEqual(730);
    // No two picks overlap.
    const sorted = [...a].sort((x, y) => x.start - y.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
  });

  it("cuts the sample transcript into reels inside the transcript", () => {
    const moments = heuristicMoments({ video: video(754), segments: [...MOCK_TRANSCRIPT_SEGMENTS] }, 3);
    expect(moments.length).toBeGreaterThanOrEqual(1);
    for (const m of moments) {
      expect(m.start).toBeGreaterThanOrEqual(0);
      expect(m.end).toBeLessThanOrEqual(754);
      expect(m.hook).not.toBe("");
    }
  });

  it("starts a reel on a sentence when the captions are punctuated", () => {
    const segs: TranscriptSegment[] = [
      { start: 0, dur: 4, text: "and that was the end of" },
      { start: 4, dur: 4, text: "the previous thought." },
      { start: 8, dur: 4, text: "Here a new sentence begins" },
      { start: 12, dur: 4, text: "and carries on" },
    ];
    expect(sentenceStart(segs, 0)).toBe(0); // the first caption counts as a start
    expect(sentenceStart(segs, 3)).toBe(8);
    expect(sentenceStart(segs, 8)).toBe(8);
    expect(sentenceStart(segs, 12)).toBe(12); // nothing follows a full stop within reach: unchanged
    expect(sentenceStart(segs, 3, 2)).toBe(3); // out of reach
    // Auto-captions have no punctuation: unchanged.
    expect(sentenceStart(captions(120, (i) => `words without any stops ${i}`), 33)).toBe(33);

    // Lines 0-11 continue one another; a sentence starts at line 3 (15 s), 13 (65 s), 23 (115 s)...
    const run = captions(900, (i) => (i % 10 === 2 ? `the end of sentence ${i} about memory.` : `Line ${i} carries the thought on with dopamine, glia and axons`));
    const picks = heuristicMoments({ video: video(900), segments: run }, 3);
    expect(picks.length).toBeGreaterThan(0);
    for (const m of picks) expect(m.start % 50).toBe(15);
  });

  it("a short video is one whole reel; an empty or tiny transcript gives none", () => {
    expect(heuristicMoments({ video: video(60), segments: captions(60) }, 3)).toEqual([
      expect.objectContaining({ start: 0, end: 60, picked: "whole" }),
    ]);
    expect(heuristicMoments({ video: video(600), segments: [] }, 3)).toEqual([]);
    expect(heuristicMoments({ video: video(600), segments: [{ start: 0, dur: 4, text: "Only a few words here." }] }, 3)).toEqual([]);
  });
});

describe("reels without captions", () => {
  const chapters = [
    { start: 0, title: "Intro" },
    { start: 30, title: "Setup" },
    { start: 300, title: "The main idea" },
    { start: 700, title: "Results" },
    { start: 1150, title: "Outro and thanks" },
  ];

  it("cuts at the chapter marks, substantive chapters first, titled with them", () => {
    const moments = chapterMoments(video(1200), chapters, 4);
    expect(moments).toEqual([
      { start: 300, end: 360, hook: "The main idea", takeaway: "", picked: "heuristic", basis: "chapters" },
      { start: 700, end: 760, hook: "Results", takeaway: "", picked: "heuristic", basis: "chapters" },
      { start: 30, end: 90, hook: "Setup", takeaway: "", picked: "heuristic", basis: "chapters" },
    ]); // the intro and the outro are left out while there is anything else
  });

  it("keeps windows between the reel limits and inside the video", () => {
    const short = [
      { start: 0, title: "Opening" },
      { start: 10, title: "A quick point" },
      { start: 50, title: "Another point" },
      { start: 575, title: "Near the end" },
    ];
    const moments = chapterMoments(video(600), short, 12);
    for (const m of moments) {
      expect(m.end - m.start).toBeGreaterThanOrEqual(REEL_MIN_S);
      expect(m.end - m.start).toBeLessThanOrEqual(REEL_TARGET_S);
      expect(m.end).toBeLessThanOrEqual(600);
    }
    expect(moments.some((m) => m.hook === "Near the end")).toBe(false); // too close to the end
    for (let i = 0; i < moments.length; i++)
      for (let j = i + 1; j < moments.length; j++)
        expect(Math.min(moments[i].end, moments[j].end) - Math.max(moments[i].start, moments[j].start)).toBeLessThanOrEqual(MAX_OVERLAP_S);
  });

  it("uses a filler chapter only when nothing else is usable", () => {
    expect(chapterMoments(video(900), [{ start: 0, title: "Intro" }, { start: 600, title: "Sponsor" }], 3).map((m) => m.hook)).toEqual(["Intro"]);
    expect(chapterMoments(video(900), [{ start: 0, title: "Intro" }, { start: 40, title: "Wiring" }, { start: 600, title: "Sponsor" }], 3).map((m) => m.hook)).toEqual(["Wiring"]);
  });

  it("without chapters: one minute just after the intro, titled with the video", () => {
    expect(positionMoment(video(1200))).toEqual({ start: 120, end: 180, hook: "How memory works", takeaway: "", picked: "heuristic", basis: "position" });
    expect(positionMoment(video(50))).toMatchObject({ start: 0, end: 50, picked: "whole", basis: "position" });
    expect(positionMoment(video(0))).toMatchObject({ start: 0, end: REEL_TARGET_S });
  });

  it("always gives a video at least one reel", () => {
    expect(noCaptionMoments(video(1200), chapters, 6)).toHaveLength(3);
    expect(noCaptionMoments(video(1200), chapters, 1)).toHaveLength(1);
    expect(noCaptionMoments(video(1200), [], 6)).toEqual([positionMoment(video(1200))]);
    expect(noCaptionMoments(video(1200), null, 6)).toEqual([positionMoment(video(1200))]);
    expect(noCaptionMoments(video(1200), [{ start: 1190, title: "Too late" }, { start: 1195, title: "Later" }], 6)).toEqual([positionMoment(video(1200))]);
    expect(noCaptionMoments(video(60), chapters, 6)).toEqual([positionMoment(video(60))]);
  });
});
