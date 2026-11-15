import { describe, expect, it } from "vitest";
import {
  clipPosition,
  clipRangeLabel,
  describeUrl,
  formatClock,
  formatMinutes,
  isPlaylistSettled,
  isSpeed,
  isTypingTarget,
  playlistStatus,
  plural,
  progressFraction,
  safeNextPath,
  shouldPollDetail,
  shouldPollList,
  videoStatus,
  youtubeAt,
} from "./format";

describe("formatClock", () => {
  it("formats minutes and seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(272.9)).toBe("4:32");
    expect(formatClock(3723)).toBe("1:02:03");
  });
  it("treats bad input as zero", () => {
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Infinity)).toBe("0:00");
    expect(formatClock(null)).toBe("0:00");
    expect(formatClock(undefined)).toBe("0:00");
  });
});

describe("formatMinutes", () => {
  it("rounds to minutes and hours", () => {
    expect(formatMinutes(30)).toBe("under 1 min");
    expect(formatMinutes(0)).toBe("under 1 min");
    expect(formatMinutes(250)).toBe("4 min");
    expect(formatMinutes(3600)).toBe("1 h");
    expect(formatMinutes(4320)).toBe("1 h 12 min");
  });
});

describe("plural", () => {
  it("picks the form", () => {
    expect(plural(1, "video")).toBe("1 video");
    expect(plural(0, "video")).toBe("0 videos");
    expect(plural(2, "analysis", "analyses")).toBe("2 analyses");
  });
});

describe("status labels", () => {
  it("labels every playlist status with a tone", () => {
    for (const s of ["queued", "ingesting", "processing", "ready", "partial", "failed"] as const) {
      const r = playlistStatus(s);
      expect(r.label.length).toBeGreaterThan(0);
    }
    expect(playlistStatus("ready").tone).toBe("ok");
    expect(playlistStatus("failed").tone).toBe("error");
    expect(playlistStatus("partial").tone).toBe("warn");
    expect(playlistStatus("processing").tone).toBe("work");
  });
  it("shows needs-a-transcript ahead of the pipeline state", () => {
    expect(videoStatus("transcribing", "needs_manual")).toEqual({ label: "Needs a transcript", tone: "warn" });
    expect(videoStatus("failed", "needs_manual").label).toBe("Needs a transcript");
    expect(videoStatus("ready", "needs_manual").label).toBe("Ready");
    expect(videoStatus("skipped", "needs_manual").label).toBe("Skipped");
    expect(videoStatus("analyzing", "ok")).toEqual({ label: "Finding the key part", tone: "work" });
    expect(videoStatus("voicing", "ok").label).toBe("Working");
    expect(videoStatus("scripting", "ok").label).toBe("Working");
  });
  it("labels labels in sentence case, never all caps", () => {
    for (const s of ["queued", "ingesting", "processing", "ready", "partial", "failed"] as const) {
      const { label } = playlistStatus(s);
      expect(label).not.toBe(label.toUpperCase());
    }
  });
});

describe("polling rules", () => {
  const base = { playlist: { status: "ready" as const }, videos: [] };
  it("polls while the playlist is not settled", () => {
    expect(shouldPollDetail({ ...base, playlist: { status: "processing" } })).toBe(true);
    expect(shouldPollDetail({ ...base, playlist: { status: "queued" } })).toBe(true);
    expect(shouldPollDetail(base)).toBe(false);
    expect(isPlaylistSettled("partial")).toBe(true);
  });
  it("polls while a video is moving, but not for one waiting on a pasted transcript", () => {
    expect(shouldPollDetail({ ...base, videos: [{ status: "scripting", transcriptStatus: "ok" }] })).toBe(true);
    expect(shouldPollDetail({ ...base, playlist: { status: "partial" }, videos: [{ status: "pending", transcriptStatus: "needs_manual" }] })).toBe(false);
  });
  it("stops polling once every video is ready, failed or skipped", () => {
    const videos = [
      { status: "ready" as const, transcriptStatus: "ok" },
      { status: "ready" as const, transcriptStatus: "needs_manual" },
      { status: "failed" as const, transcriptStatus: "ok" },
      { status: "skipped" as const, transcriptStatus: "pending" },
    ];
    expect(shouldPollDetail({ playlist: { status: "partial" }, videos })).toBe(false);
  });
  it("polls the list while any playlist is working", () => {
    expect(shouldPollList([{ status: "ready" }, { status: "ingesting" }])).toBe(true);
    expect(shouldPollList([{ status: "ready" }, { status: "failed" }])).toBe(false);
    expect(shouldPollList([])).toBe(false);
  });
});

describe("progressFraction", () => {
  it("counts ready and failed against the total, clamped", () => {
    expect(progressFraction({ total: 4, ready: 1, failed: 1 })).toBe(0.5);
    expect(progressFraction({ total: 0, ready: 0, failed: 0 })).toBe(0);
    expect(progressFraction({ total: 2, ready: 5, failed: 0 })).toBe(1);
  });
});

describe("clip timing", () => {
  const clip = { start: 600, end: 810 };
  it("clipPosition is the time inside the clip, clamped to its length", () => {
    expect(clipPosition(600, clip)).toBe(0);
    expect(clipPosition(700.5, clip)).toBe(100.5);
    expect(clipPosition(100, clip)).toBe(0);
    expect(clipPosition(5000, clip)).toBe(210);
    expect(clipPosition(Number.NaN, clip)).toBe(0);
    expect(clipPosition(10, { start: 20, end: 10 })).toBe(0);
  });
  it("clipRangeLabel shows both ends as clock times", () => {
    expect(clipRangeLabel(clip)).toBe("10:00 to 13:30");
    expect(clipRangeLabel({ start: 0, end: 3723 })).toBe("0:00 to 1:02:03");
  });
  it("youtubeAt links to the video at the clip's start", () => {
    expect(youtubeAt("dQw4w9WgXcQ", 754.8)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s");
    expect(youtubeAt("dQw4w9WgXcQ", 0)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeAt("dQw4w9WgXcQ", -5)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeAt("a b&c", 10)).toBe("https://www.youtube.com/watch?v=a%20b%26c&t=10s");
  });
});

describe("describeUrl", () => {
  it("is neutral when empty", () => {
    expect(describeUrl("   ").state).toBe("empty");
  });
  it("recognises playlists and videos", () => {
    expect(describeUrl("https://www.youtube.com/playlist?list=PLabcdefghijkl")).toMatchObject({ state: "ok", kind: "playlist" });
    expect(describeUrl("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ state: "ok", kind: "video" });
    expect(describeUrl("  https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijkl  ")).toMatchObject({ state: "ok", kind: "playlist" });
  });
  it("explains bare IDs, private lists and other links", () => {
    expect(describeUrl("dQw4w9WgXcQ")).toMatchObject({ state: "invalid", message: expect.stringContaining("whole link") });
    expect(describeUrl("https://www.youtube.com/playlist?list=WL")).toMatchObject({ state: "invalid", message: expect.stringContaining("private") });
    expect(describeUrl("https://vimeo.com/123")).toMatchObject({ state: "invalid" });
    expect(describeUrl("javascript:alert(1)")).toMatchObject({ state: "invalid" });
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/app")).toBe("/app");
    expect(safeNextPath("/app/p/abc?x=1#y")).toBe("/app/p/abc?x=1#y");
    expect(safeNextPath(["/app/account", "/evil"])).toBe("/app/account");
  });
  it("rejects open redirects and odd input", () => {
    expect(safeNextPath("https://evil.example")).toBe("/app");
    expect(safeNextPath("//evil.example")).toBe("/app");
    expect(safeNextPath("/\\evil.example")).toBe("/app");
    expect(safeNextPath("/app\\..\\x")).toBe("/app");
    expect(safeNextPath("javascript:alert(1)")).toBe("/app");
    expect(safeNextPath("/a\nb")).toBe("/app");
    expect(safeNextPath("")).toBe("/app");
    expect(safeNextPath(undefined)).toBe("/app");
    expect(safeNextPath("/" + "a".repeat(600))).toBe("/app");
  });
  it("never sends a signed-in user back to the auth pages", () => {
    expect(safeNextPath("/login")).toBe("/app");
    expect(safeNextPath("/signup?next=/x")).toBe("/app");
  });
});

describe("speeds and keyboard targets", () => {
  it("accepts only the offered speeds", () => {
    expect(isSpeed(1.5)).toBe(true);
    expect(isSpeed(3)).toBe(false);
    expect(isSpeed("1")).toBe(false);
  });
  it("treats text fields as typing targets but not buttons or checkboxes", () => {
    const el = (tagName: string, type?: string, editable = false) => ({
      tagName,
      isContentEditable: editable,
      getAttribute: (n: string) => (n === "type" ? type ?? null : null),
    });
    expect(isTypingTarget(el("INPUT", "text") as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el("INPUT") as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el("INPUT", "range") as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el("INPUT", "radio") as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(el("TEXTAREA") as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el("DIV", undefined, true) as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el("BUTTON") as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
