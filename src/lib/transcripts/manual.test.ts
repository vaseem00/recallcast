import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/lib/types";
import { parseManualTranscript, parseTimestamp } from "./manual";

function expectWellFormed(segs: TranscriptSegment[]) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    expect(Number.isFinite(s.start)).toBe(true);
    expect(Number.isFinite(s.dur)).toBe(true);
    expect(s.start).toBeGreaterThanOrEqual(0);
    expect(s.dur).toBeGreaterThanOrEqual(0);
    expect(s.text.trim()).toBe(s.text);
    expect(s.text.length).toBeGreaterThan(0);
    if (i > 0) expect(s.start).toBeGreaterThanOrEqual(segs[i - 1].start);
  }
}

describe("parseTimestamp", () => {
  it.each([
    ["0:00", 0],
    ["0:05", 5],
    ["1:23", 83],
    ["01:23", 83],
    ["12:34", 754],
    ["75:30", 4530],
    ["1:02:03", 3723],
    ["01:02:03", 3723],
    ["10:00:00", 36000],
    ["00:00:01.500", 1.5],
    ["00:00:01,250", 1.25],
    [" 2:00 ", 120],
  ])("%s -> %d", (input, expected) => {
    expect(parseTimestamp(input)).toBeCloseTo(expected, 5);
  });

  it.each(["", "1", "1:2", "1:60", "1:75:00", "1:00:60", "a:bc", "1:23:4", "-1:00", "1::23"])("rejects %j", (input) => {
    expect(parseTimestamp(input)).toBeNull();
  });
});

describe("parseManualTranscript: timestamped lines", () => {
  it("parses m:ss prefixes and derives durations from the next start", () => {
    const segs = parseManualTranscript("0:00 Hello and welcome.\n0:04 Today we talk about memory.\n1:10 Bye!");
    expect(segs).toEqual([
      { start: 0, dur: 4, text: "Hello and welcome." },
      { start: 4, dur: 66, text: "Today we talk about memory." },
      { start: 70, dur: 1, text: "Bye!" },
    ]);
  });

  it("parses h:mm:ss and mm:ss with separators and brackets", () => {
    const text = [
      "[00:00:05] First point",
      "(00:01:02) - Second point",
      "01:02:03 — Third point",
      "1:02:10 | Fourth point",
      "[1:02:20]: Fifth point",
    ].join("\n");
    const segs = parseManualTranscript(text);
    expect(segs.map((s) => [s.start, s.text])).toEqual([
      [5, "First point"],
      [62, "Second point"],
      [3723, "Third point"],
      [3730, "Fourth point"],
      [3740, "Fifth point"],
    ]);
    expectWellFormed(segs);
  });

  it("handles YouTube's copy format: timestamp on its own line, text below", () => {
    const text = "0:00\nhey everyone welcome back\n0:03\ntoday we're talking\nabout forgetting\n0:09\nlet's go\n";
    const segs = parseManualTranscript(text);
    expect(segs).toEqual([
      { start: 0, dur: 3, text: "hey everyone welcome back" },
      { start: 3, dur: 6, text: "today we're talking about forgetting" },
      { start: 9, dur: 1, text: "let's go" },
    ]);
  });

  it("joins continuation lines and keeps a preamble at 0", () => {
    const segs = parseManualTranscript("Intro words before any stamp\n0:10 first\ncontinued here\n0:20 second");
    expect(segs.map((s) => [s.start, s.text])).toEqual([
      [0, "Intro words before any stamp"],
      [10, "first continued here"],
      [20, "second"],
    ]);
  });

  it("sorts out-of-order timestamps and drops empty stamps", () => {
    const segs = parseManualTranscript("0:30 later\n0:10 earlier\n0:50\n\n0:40 middle");
    expect(segs.map((s) => [s.start, s.text])).toEqual([
      [10, "earlier"],
      [30, "later"],
      [40, "middle"],
    ]);
    expectWellFormed(segs);
  });

  it("estimates the last segment's duration at ~150 wpm", () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const segs = parseManualTranscript(`0:00 a\n0:02 ${words}`);
    expect(segs[1].dur).toBeCloseTo(12, 5); // 30 words / 150 wpm = 12 s
  });

  it("supports a single timestamp when it opens the transcript", () => {
    expect(parseManualTranscript("0:15 only one line")).toEqual([{ start: 15, dur: 1.2, text: "only one line" }]);
  });

  it("treats invalid timestamps as ordinary text", () => {
    const segs = parseManualTranscript("0:00 start\n1:75 not a time\n0:20 next");
    expect(segs.map((s) => s.text)).toEqual(["start 1:75 not a time", "next"]);
  });

  it("handles CRLF line endings, BOM and non-breaking spaces", () => {
    const segs = parseManualTranscript("﻿0:00 Hello\r\n0:05 World\r\n");
    expect(segs.map((s) => [s.start, s.text])).toEqual([
      [0, "Hello"],
      [5, "World"],
    ]);
  });

  it("does not treat a time like '10:30am' as a timestamp prefix", () => {
    const segs = parseManualTranscript("10:30am meeting notes. We talked about plans.");
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(0);
    expect(segs[0].text).toContain("10:30am");
  });
});

describe("parseManualTranscript: SRT and WebVTT", () => {
  it("parses SRT cues with explicit end times", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:04,500",
      "Hello there.",
      "",
      "2",
      "00:00:05,000 --> 00:00:08,000",
      "<i>Second</i> line",
      "continues",
      "",
    ].join("\n");
    expect(parseManualTranscript(srt)).toEqual([
      { start: 1, dur: 3.5, text: "Hello there." },
      { start: 5, dur: 3, text: "Second line continues" },
    ]);
  });

  it("parses WebVTT with header, notes, cue ids, inline tags and rolling duplicates", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "NOTE this is a comment",
      "that spans lines",
      "",
      "intro",
      "00:00.000 --> 00:02.000 align:start position:0%",
      "<v Maya>Welcome<00:00:01.000><c> back</c>",
      "",
      "00:02.000 --> 00:04.000",
      "Welcome back",
      "",
      "00:04.000 --> 00:07.250",
      "to the show",
    ].join("\n");
    expect(parseManualTranscript(vtt)).toEqual([
      { start: 0, dur: 2, text: "Welcome back" },
      { start: 4, dur: 3.25, text: "to the show" },
    ]);
  });
});

describe("parseManualTranscript: plain text", () => {
  it("returns [] for empty or whitespace input", () => {
    expect(parseManualTranscript("")).toEqual([]);
    expect(parseManualTranscript("  \n\n\t ")).toEqual([]);
    expect(parseManualTranscript(undefined as unknown as string)).toEqual([]);
  });

  it("synthesizes start times at ~150 words per minute", () => {
    const sentence = "This sentence has exactly ten words in it for testing.";
    const para = Array.from({ length: 6 }, () => sentence).join(" "); // 60 words
    const segs = parseManualTranscript(para);
    expectWellFormed(segs);
    // ~30 words per segment -> 12 s each
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: 0, dur: 12 });
    expect(segs[1]).toMatchObject({ start: 12, dur: 12 });
    const total = segs.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    expect(total).toBe(60);
  });

  it("keeps paragraphs as segment boundaries and ends each segment on a sentence", () => {
    const text = "Short first paragraph. Second sentence here.\n\nA new paragraph starts. It has two sentences.";
    const segs = parseManualTranscript(text);
    expect(segs.map((s) => s.text)).toEqual([
      "Short first paragraph. Second sentence here.",
      "A new paragraph starts. It has two sentences.",
    ]);
    expect(segs[1].start).toBeCloseTo(segs[0].dur, 5);
  });

  it("splits an unpunctuated wall of text into bounded segments", () => {
    const words = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
    const segs = parseManualTranscript(words);
    expectWellFormed(segs);
    for (const s of segs) expect(s.text.split(" ").length).toBeLessThanOrEqual(60);
    expect(segs.map((s) => s.text).join(" ")).toBe(words);
    const last = segs[segs.length - 1];
    expect(last.start + last.dur).toBeCloseTo(100, 1); // 250 words at 150 wpm = 100 s
  });

  it("keeps a stray mid-prose time reference as plain text", () => {
    const text = "We met at noon.\n3:16 is my favourite verse, he said. Then we left.";
    const segs = parseManualTranscript(text);
    expect(segs.map((s) => s.start)[0]).toBe(0);
    expect(segs.map((s) => s.text).join(" ")).toContain("3:16 is my favourite verse");
  });

  it("collapses whitespace inside segments", () => {
    const segs = parseManualTranscript("Hello    world.\n  How   are you?");
    expect(segs).toEqual([{ start: 0, dur: 2, text: "Hello world. How are you?" }]);
  });
});

describe("parseManualTranscript: adversarial input (ReDoS guard)", () => {
  // Before the fix, LEADING_TS_RE (`^\s*[[(]?\s*...`) was quadratic on a long whitespace run:
  // 80k spaces + "x" took ~13 s, and the route accepts 1,000,000 characters.
  it("parses a huge whitespace run followed by text in linear time", () => {
    const started = Date.now();
    const segs = parseManualTranscript(`${" ".repeat(999_990)}x and more words`);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(segs.map((s) => s.text).join(" ")).toBe("x and more words");
  });

  it("handles many long whitespace lines and an unclosed-tag run in cue mode quickly", () => {
    const lines = Array.from({ length: 20 }, () => `${" ".repeat(40_000)}[x`).join("\n");
    let started = Date.now();
    parseManualTranscript(lines);
    expect(Date.now() - started).toBeLessThan(1500);

    const cue = `00:00:01.000 --> 00:00:02.000\n${"<".repeat(200_000)}`;
    started = Date.now();
    parseManualTranscript(cue);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("still reads indented and bracketed timestamps", () => {
    const segs = parseManualTranscript("   [ 0:05 ]  first line here\n\t(1:10) - second line here");
    expect(segs.map((s) => [s.start, s.text])).toEqual([
      [5, "first line here"],
      [70, "second line here"],
    ]);
  });
});
