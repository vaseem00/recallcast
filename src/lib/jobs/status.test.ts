import { describe, expect, it } from "vitest";
import { computePlaylistStatus, isVideoTerminal } from "./status";

describe("computePlaylistStatus", () => {
  it("returns null when there are no videos yet (keep ingest status)", () => {
    expect(computePlaylistStatus({ videoStatuses: [] })).toBeNull();
  });

  it("is processing while any non-skipped video is in progress", () => {
    for (const s of ["pending", "transcribing", "analyzing", "scripting", "voicing"] as const) {
      expect(computePlaylistStatus({ videoStatuses: ["ready", s] })?.status).toBe("processing");
    }
  });

  it("fails when every video was skipped", () => {
    const r = computePlaylistStatus({ videoStatuses: ["skipped", "skipped"] });
    expect(r?.status).toBe("failed");
    expect(r?.error).toMatch(/length limit/);
  });

  it("fails when nothing is ready", () => {
    expect(computePlaylistStatus({ videoStatuses: ["failed", "failed"] })).toEqual({
      status: "failed",
      error: "None of the videos could be processed.",
    });
    expect(computePlaylistStatus({ videoStatuses: ["failed"] })?.error).toBe("This video could not be processed.");
  });

  it("is ready as soon as every video is ready (no recap to wait for)", () => {
    expect(computePlaylistStatus({ videoStatuses: ["ready", "ready"] })).toEqual({ status: "ready", error: null });
    expect(computePlaylistStatus({ videoStatuses: ["ready"] })).toEqual({ status: "ready", error: null });
  });

  it("is partial when some videos failed", () => {
    expect(computePlaylistStatus({ videoStatuses: ["ready", "ready", "failed"] })).toEqual({
      status: "partial",
      error: "1 of 3 videos could not be processed.",
    });
  });

  it("ignores skipped videos in counts", () => {
    expect(computePlaylistStatus({ videoStatuses: ["ready", "skipped", "ready"] })).toEqual({ status: "ready", error: null });
    expect(computePlaylistStatus({ videoStatuses: ["ready", "skipped", "failed"] })).toEqual({
      status: "partial",
      error: "1 of 2 videos could not be processed.",
    });
  });

  it("isVideoTerminal", () => {
    expect(isVideoTerminal("ready")).toBe(true);
    expect(isVideoTerminal("failed")).toBe(true);
    expect(isVideoTerminal("skipped")).toBe(true);
    expect(isVideoTerminal("analyzing")).toBe(false);
  });
});
