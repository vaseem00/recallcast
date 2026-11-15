import { describe, expect, it } from "vitest";
import { parseChapters, parseChaptersJson } from "./chapters";

describe("parseChapters", () => {
  it("reads the timestamp lines creators write for YouTube chapters", () => {
    const description = [
      "In this video we build the timer.",
      "",
      "Chapters:",
      "0:00 Intro",
      "01:15 - Choosing the LCD",
      "(5:40) Power budget",
      "• 12:03 – Measuring the current",
      "1:02:03 Q&A",
      "",
      "Patreon: https://example.com",
    ].join("\n");
    expect(parseChapters(description, 4000)).toEqual([
      { start: 0, title: "Intro" },
      { start: 75, title: "Choosing the LCD" },
      { start: 340, title: "Power budget" },
      { start: 723, title: "Measuring the current" },
      { start: 3723, title: "Q&A" },
    ]);
  });

  it("reads a timestamp at the end of the line too", () => {
    expect(parseChapters("Intro 0:00\nThe setup - 2:30\nPart 1: 4:05", 600)).toEqual([
      { start: 0, title: "Intro" },
      { start: 150, title: "The setup" },
      { start: 245, title: "Part 1" },
    ]);
  });

  it("keeps an ascending run only, and drops marks past the end of the video", () => {
    const description = "0:00 Start\n3:00 Middle\n1:00 Out of order\n9:00 After the end\n5:00 Late but valid";
    expect(parseChapters(description, 480)).toEqual([
      { start: 0, title: "Start" },
      { start: 180, title: "Middle" },
      { start: 300, title: "Late but valid" },
    ]);
  });

  it("is no chapters at all with fewer than two marks, bad stamps or no text", () => {
    expect(parseChapters("0:00 Only one", 600)).toEqual([]);
    expect(parseChapters("0:75 Bad seconds\n1:61:00 Bad minutes\n123:45 Too long", 9000)).toEqual([]);
    expect(parseChapters("0:00\n1:00 -\n2:00 https://example.com", 600)).toEqual([]);
    expect(parseChapters("", 600)).toEqual([]);
    expect(parseChapters(undefined, 600)).toEqual([]);
  });

  it("cuts very long titles", () => {
    const long = "x".repeat(200);
    const [first] = parseChapters(`0:00 ${long}\n1:00 Next`, 600);
    expect(first.title.length).toBeLessThanOrEqual(110);
    expect(first.title.endsWith("...")).toBe(true);
  });
});

describe("parseChaptersJson", () => {
  it("reads what was stored and rejects anything else", () => {
    expect(parseChaptersJson('[{"start":30,"title":"B"},{"start":0,"title":"A"}]')).toEqual([
      { start: 0, title: "A" },
      { start: 30, title: "B" },
    ]);
    expect(parseChaptersJson("[]")).toEqual([]);
    expect(parseChaptersJson('[{"start":"x","title":"A"},{"start":5}]')).toEqual([]);
    expect(parseChaptersJson(null)).toBeNull();
    expect(parseChaptersJson("not json")).toBeNull();
    expect(parseChaptersJson('{"start":0}')).toBeNull();
  });
});
