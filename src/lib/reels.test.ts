import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// A real temp-file database for this file, set before any DB use.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-reels-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
process.env.STORAGE_DIR = path.join(dir, "storage");

import { AiRefusalError } from "@/lib/ai/errors";
import { createMockAiProvider } from "@/lib/ai/mock";
import { REEL_MAX_S, REEL_MIN_S } from "@/lib/ai/moments";
import { deleteAccount } from "@/lib/account";
import { all, closeDb, get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { createPlaylist, deletePlaylist, recheckCaptions, MAX_USER_RETRIES } from "@/lib/jobs/commands";
import { JobRetryableError } from "@/lib/jobs/errors";
import { pickVideoMoments, queueMissingMoments } from "@/lib/jobs/pipeline";
import type { Providers } from "@/lib/jobs/providers";
import { countingAi, fakeYouTube, jobRows, mkVideo, mockProviders, seedUser, videoRows } from "@/lib/jobs/test-helpers";
import { runUntilIdle, silentLogger, type ProcessOptions } from "@/lib/jobs/worker";
import { createMockTranscriptProvider } from "@/lib/transcripts/mock";
import { captionLimitRemainingMs, createYoutubeiTranscriptProvider, resetCaptionLimit } from "@/lib/transcripts/youtubei";
import type { MomentPlan, MomentRow } from "@/lib/types";
import { YouTubeError } from "@/lib/youtube/errors";
import {
  SAMPLE_HOOKS,
  captionsFor,
  getPlaylistShare,
  getSampleFeed,
  getSharedPage,
  isShareSlug,
  loadReelFeed,
  setReelState,
  shareMoment,
  sharePlaylist,
  unshareMoment,
  unsharePlaylist,
} from "./reels";

resetEnvCache();

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLreelslist001";
const three = [mkVideo("vidREEL0001", 0), mkVideo("vidREEL0002", 1), mkVideo("vidREEL0003", 2)];
const mockAi = createMockAiProvider();

let offset = 0;
const clock = () => Date.now() + offset;

function opts(overrides: Partial<Providers> = {}): ProcessOptions {
  return { resolve: mockProviders(overrides), logger: silentLogger, now: clock, backoff: { random: () => 0.5, baseMs: 1000 } };
}

/** An AI provider whose reels are exactly these windows, marked as Claude's picks. */
function fixedMoments(windows: Array<[number, number]>, calls = { n: 0 }): Providers["ai"] {
  return {
    pickClip: mockAi.pickClip,
    async pickMoments(): Promise<MomentPlan[]> {
      calls.n++;
      return windows.map(([start, end], i) => ({ start, end, hook: `Hook ${i + 1}`, takeaway: `Takeaway ${i + 1}.`, picked: "ai" }));
    },
  };
}

function momentRows(playlistId: string): MomentRow[] {
  return all<MomentRow>("SELECT * FROM moments WHERE playlist_id = ? ORDER BY video_id, ord", playlistId);
}

function momentsStatus(videoId: string): string {
  return get<{ s: string }>("SELECT moments_status AS s FROM videos WHERE id = ?", videoId)!.s;
}

async function readyPlaylist(user: string, ai: Providers["ai"] = fixedMoments([[10, 70], [80, 120]]), videos = three) {
  const { id } = createPlaylist(user, PLAYLIST_URL);
  await runUntilIdle(opts({ youtube: fakeYouTube(videos, { title: "Memory Series", channel: "Brain Lab" }), ai }));
  return id;
}

async function status(fn: () => unknown): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
}

beforeEach(() => {
  offset = 0;
});

describe("pick_moments job", () => {
  it("cuts reels for every video with a transcript once its clip is stored", async () => {
    const user = seedUser();
    const calls = { n: 0 };
    const id = await readyPlaylist(user, fixedMoments([[10, 70], [80, 120]], calls));
    expect(calls.n).toBe(3);
    const vids = videoRows(id);
    for (const v of vids) expect(momentsStatus(v.id)).toBe("ready");
    const rows = momentRows(id);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.video_id === vids[0].id).map((r) => [r.ord, r.start_s, r.end_s, r.hook, r.picked])).toEqual([
      [0, 10, 70, "Hook 1", "ai"],
      [1, 80, 120, "Hook 2", "ai"],
    ]);
    expect(rows.every((r) => r.saved_at === null && r.seen_at === null)).toBe(true);
    expect(jobRows().every((j) => j.status === "done")).toBe(true);
  });

  it("uses the heuristic in mock mode, with windows of reel length", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, mockAi);
    const rows = momentRows(id);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.picked).toBe("heuristic");
      expect(r.end_s - r.start_s).toBeGreaterThanOrEqual(REEL_MIN_S);
      expect(r.end_s - r.start_s).toBeLessThanOrEqual(REEL_MAX_S);
    }
  });

  it("asks for one reel per five minutes of video, capped by REELS_PER_VIDEO_MAX", async () => {
    const user = seedUser();
    const asked: number[] = [];
    const ai: Providers["ai"] = {
      pickClip: mockAi.pickClip,
      async pickMoments(i) {
        asked.push(i.count);
        return mockAi.pickMoments(i);
      },
    };
    await readyPlaylist(user, ai, [mkVideo("vidLEN00600", 0, 600), mkVideo("vidLEN03000", 1, 3000), mkVideo("vidLEN10800", 2, 10800)]);
    expect(asked.sort((a, b) => a - b)).toEqual([2, 6, 6]);
  });

  it("a video without captions or chapters still gets a reel: a minute after the intro, no moment call", async () => {
    const user = seedUser();
    const ai = countingAi();
    const id = await readyPlaylist(user, ai, [mkVideo("NOCAPreel01", 0)]);
    expect(ai.calls.pickMoments).toBe(0);
    const v = videoRows(id)[0];
    expect(momentsStatus(v.id)).toBe("ready");
    expect(momentRows(id).map((m) => [m.start_s, m.end_s, m.hook, m.picked, m.basis])).toEqual([
      [60, 120, "Video 1: ideas about memory", "heuristic", "position"],
    ]);
  });

  it("a video without captions is cut at its chapter marks, read with the playlist", async () => {
    const user = seedUser();
    const ai = countingAi();
    const chapters = [
      { start: 0, title: "Intro" },
      { start: 30, title: "Setup" },
      { start: 300, title: "The main idea" },
      { start: 700, title: "Results" },
    ];
    const id = await readyPlaylist(user, ai, [{ ...mkVideo("NOCAPchap01", 0, 1200), chapters }]);
    expect(ai.calls.pickMoments).toBe(0);
    expect(momentRows(id).map((m) => [m.ord, m.start_s, m.end_s, m.hook, m.basis])).toEqual([
      [0, 300, 360, "The main idea", "chapters"],
      [1, 700, 760, "Results", "chapters"],
      [2, 30, 90, "Setup", "chapters"],
    ]);
    const stored = get<{ c: string }>("SELECT chapters_json AS c FROM videos WHERE playlist_id = ?", id)!.c;
    expect(JSON.parse(stored)).toEqual(chapters);
  });

  it("reads the chapters of a video ingested before they were stored, once, and copes when YouTube cannot answer", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, mockAi, [mkVideo("NOCAPold001", 0, 1200)]);
    const v = videoRows(id)[0];
    const reset = () => {
      run("DELETE FROM moments WHERE video_id = ?", v.id);
      run("UPDATE videos SET moments_status = 'none', chapters_json = NULL WHERE id = ?", v.id);
    };
    reset();
    let asked = 0;
    let answer: () => Promise<Map<string, { start: number; title: string }[]>> = async () =>
      new Map([["NOCAPold001", [{ start: 0, title: "Hello" }, { start: 200, title: "Deep dive" }]]]);
    const youtube = {
      ...fakeYouTube([]),
      async fetchChapters(ids: string[]) {
        asked++;
        expect(ids).toEqual(["NOCAPold001"]);
        return answer();
      },
    };
    expect(queueMissingMoments(user)).toBe(1);
    await runUntilIdle(opts({ youtube }));
    expect(asked).toBe(1);
    expect(momentRows(id).map((m) => [m.hook, m.basis])).toEqual([
      ["Deep dive", "chapters"],
      ["Hello", "chapters"],
    ]);

    // Stored now: a second cut does not ask again.
    run("DELETE FROM moments WHERE video_id = ?", v.id);
    run("UPDATE videos SET moments_status = 'none' WHERE id = ?", v.id);
    queueMissingMoments(user);
    await runUntilIdle(opts({ youtube }));
    expect(asked).toBe(1);

    // YouTube refuses for good (quota): cut by position, nothing stored, the job does not fail.
    reset();
    answer = async () => {
      throw new YouTubeError("quota", "YouTube API daily quota exceeded. Please try again tomorrow.", { status: 403 });
    };
    queueMissingMoments(user);
    const r = await runUntilIdle(opts({ youtube }));
    expect(r.failed).toBe(0);
    expect(momentRows(id).map((m) => m.basis)).toEqual(["position"]);
    expect(get<{ c: string | null }>("SELECT chapters_json AS c FROM videos WHERE id = ?", v.id)!.c).toBeNull();

    // A passing outage goes back to the queue, then the chapters are used.
    reset();
    let calls = 0;
    answer = async () => {
      if (calls++ === 0) throw new YouTubeError("network", "Could not reach YouTube. Please try again.", { retryable: true });
      return new Map([["NOCAPold001", [{ start: 0, title: "Hello" }, { start: 200, title: "Deep dive" }]]]);
    };
    queueMissingMoments(user);
    const first = await runUntilIdle(opts({ youtube }));
    expect(first.retried).toBe(1);
    offset = 120_000;
    await runUntilIdle(opts({ youtube }));
    expect(momentRows(id).map((m) => m.basis)).toEqual(["chapters", "chapters"]);
  });

  it("an unusable answer falls back to the heuristic", async () => {
    const user = seedUser();
    const ai: Providers["ai"] = {
      pickClip: mockAi.pickClip,
      async pickMoments() {
        throw new AiRefusalError("cyber");
      },
    };
    const id = await readyPlaylist(user, ai, [three[0]]);
    const rows = momentRows(id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.picked === "heuristic")).toBe(true);
    expect(videoRows(id)[0].status).toBe("ready");
  });

  it("a retryable error retries the moments only: the clip is not picked again", async () => {
    const user = seedUser();
    const calls = { clip: 0, moments: 0 };
    const ai: Providers["ai"] = {
      async pickClip(i) {
        calls.clip++;
        return mockAi.pickClip(i);
      },
      async pickMoments(i) {
        if (calls.moments++ === 0) throw new JobRetryableError("Claude API rate limit reached; will retry.", { retryAfterMs: 5000 });
        return mockAi.pickMoments(i);
      },
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidRETRYRL1");
    const first = await runUntilIdle(opts({ ai }));
    expect(first.retried).toBe(1);
    const v = videoRows(id)[0];
    expect(v.status).toBe("ready"); // the episode is playable while its reels wait
    expect(momentsStatus(v.id)).toBe("pending");
    expect(jobRows("queued").map((j) => j.type)).toEqual(["pick_moments"]);

    offset = 6000;
    await runUntilIdle(opts({ ai }));
    expect(calls).toEqual({ clip: 1, moments: 2 });
    expect(momentsStatus(v.id)).toBe("ready");
    expect(momentRows(id).length).toBeGreaterThan(0);
  });

  it("when the job fails for good the heuristic's reels are stored and the video stays ready", async () => {
    const user = seedUser();
    const ai: Providers["ai"] = {
      pickClip: mockAi.pickClip,
      async pickMoments() {
        throw new TypeError("Cannot read properties of undefined (reading 'x')");
      },
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidBUGREEL1");
    const r = await runUntilIdle(opts({ ai }));
    expect(r.failed).toBe(1);
    const v = videoRows(id)[0];
    expect(v).toMatchObject({ status: "ready", error: null });
    expect(momentsStatus(v.id)).toBe("ready");
    expect(momentRows(id).every((m) => m.picked === "heuristic")).toBe(true);
    expect(momentRows(id).length).toBeGreaterThan(0);
  });

  it("leaves a video whose reels are ready alone, so saved rows keep their ids", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70]]), [three[0]]);
    const before = momentRows(id).map((m) => m.id);
    const calls = { n: 0 };
    expect(await pickVideoMoments(videoRows(id)[0].id, { ai: fixedMoments([[200, 260]], calls) })).toBeNull();
    expect(calls.n).toBe(0);
    expect(momentRows(id).map((m) => m.id)).toEqual(before);
  });

  it("deleting the playlist or the account removes reels, shares and queued moment jobs", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70]]));
    const { slug } = shareMoment(user, momentRows(id)[0].id);
    sharePlaylist(user, id);
    const v = videoRows(id)[0];
    run("UPDATE videos SET moments_status = 'none' WHERE id = ?", v.id);
    expect(queueMissingMoments(user)).toBe(1);
    deletePlaylist(user, id);
    expect(momentRows(id)).toHaveLength(0);
    expect(getSharedPage(slug)).toBeNull();
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM shares WHERE user_id = ?", user)!.n).toBe(0);
    expect(jobRows("queued")).toHaveLength(0);

    const other = seedUser();
    const id2 = await readyPlaylist(other, fixedMoments([[10, 70]]));
    shareMoment(other, momentRows(id2)[0].id);
    deleteAccount(other);
    expect(momentRows(id2)).toHaveLength(0);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM shares WHERE user_id = ?", other)!.n).toBe(0);
  });
});

describe("queueMissingMoments (videos processed before reels existed)", () => {
  it("queues each ready video with a transcript once, and only the caller's", async () => {
    const user = seedUser();
    const stranger = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70]]));
    const strangerId = await readyPlaylist(stranger, fixedMoments([[10, 70]]));
    // As migration 5 leaves old rows: no reels, status 'none'.
    run("DELETE FROM moments WHERE playlist_id IN (?, ?)", id, strangerId);
    run("UPDATE videos SET moments_status = 'none' WHERE playlist_id IN (?, ?)", id, strangerId);

    expect(queueMissingMoments(user)).toBe(3);
    expect(queueMissingMoments(user)).toBe(0); // already queued
    expect(jobRows("queued").map((j) => j.type)).toEqual(["pick_moments", "pick_moments", "pick_moments"]);
    for (const v of videoRows(strangerId)) expect(momentsStatus(v.id)).toBe("none");

    const calls = { n: 0 };
    await runUntilIdle(opts({ ai: fixedMoments([[20, 80]], calls) }));
    expect(calls.n).toBe(3);
    expect(momentRows(id)).toHaveLength(3);
    expect(queueMissingMoments(user)).toBe(0); // 'ready' is final
  });

  it("re-queues a video left 'pending' with no job, and can be limited to one playlist", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70]]), [three[0]]);
    const v = videoRows(id)[0];
    run("DELETE FROM moments WHERE video_id = ?", v.id);
    run("UPDATE videos SET moments_status = 'pending' WHERE id = ?", v.id);
    expect(queueMissingMoments(user, "another-playlist")).toBe(0);
    expect(queueMissingMoments(user, id)).toBe(1);
    await runUntilIdle(opts({ ai: fixedMoments([[20, 80]]) }));
    expect(momentsStatus(v.id)).toBe("ready");
  });

  it("queues videos without a transcript too, which get their reels without a moment call", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, mockAi, [mkVideo("NOCAPreel02", 0)]);
    // As the code before this change left them: no reels, status 'none'.
    run("DELETE FROM moments WHERE playlist_id = ?", id);
    run("UPDATE videos SET moments_status = 'none' WHERE playlist_id = ?", id);
    expect(queueMissingMoments(user)).toBe(1);
    const ai = countingAi();
    await runUntilIdle(opts({ ai }));
    expect(ai.calls.pickMoments).toBe(0);
    expect(momentRows(id).map((m) => m.basis)).toEqual(["position"]);
    expect(queueMissingMoments(user)).toBe(0);
  });
});

describe("recheckCaptions", () => {
  it("re-runs no-caption videos; captions found now give a real pick and reels", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    const videos = [mkVideo("vidHASCAP01", 0), mkVideo("NOCAPlater1", 1)];
    await runUntilIdle(opts({ youtube: fakeYouTube(videos) }));
    const noCap = videoRows(id)[1];
    expect(noCap).toMatchObject({ status: "ready", transcript_status: "needs_manual" });

    expect(recheckCaptions(user, id)).toEqual({ rechecked: 1 });
    expect(videoRows(id)[1]).toMatchObject({ status: "pending", transcript_status: "pending" });
    expect(get<{ status: string }>("SELECT status FROM playlists WHERE id = ?", id)!.status).toBe("processing");

    // This time YouTube returns captions for it.
    const base = createMockTranscriptProvider();
    const transcripts = { fetch: (vid: string) => base.fetch(vid.replace("NOCAP", "WITHC")) };
    await runUntilIdle(opts({ transcripts }));
    expect(videoRows(id)[1]).toMatchObject({ status: "ready", transcript_status: "ok" });
    expect(momentsStatus(noCap.id)).toBe("ready");
    expect(momentRows(id).some((m) => m.video_id === noCap.id)).toBe(true);
    expect(recheckCaptions(user, id)).toEqual({ rechecked: 0 }); // nothing is waiting any more
  });

  it("is capped per video, owner-only, and still no captions stays playable", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/NOCAPcapped");
    await runUntilIdle(opts());
    expect(await status(() => recheckCaptions(seedUser(), id))).toBe(404);
    for (let i = 0; i < MAX_USER_RETRIES; i++) {
      expect(recheckCaptions(user, id)).toEqual({ rechecked: 1 });
      await runUntilIdle(opts());
      expect(videoRows(id)[0]).toMatchObject({ status: "ready", transcript_status: "needs_manual" });
    }
    expect(await status(() => recheckCaptions(user, id))).toBe(429);
  });

  it("refuses while YouTube is limiting caption requests, without spending a re-check", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/NOCAPlimit1");
    await runUntilIdle(opts());
    const retries = () => get<{ n: number }>("SELECT retry_count AS n FROM videos WHERE playlist_id = ?", id)!.n;

    // A caption download has just been answered with HTTP 429.
    const limited = createYoutubeiTranscriptProvider({
      getClient: async () => ({
        getInfo: async () => ({}),
        getBasicInfo: async () => ({ captions: { caption_tracks: [{ base_url: "https://www.youtube.com/api/timedtext?v=x", language_code: "en" }] } }),
      }),
      fetchImpl: (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
      log: () => {},
    });
    await limited.fetch("dQw4w9WgXcQ").catch(() => {});
    try {
      expect(captionLimitRemainingMs()).toBeGreaterThan(0);
      let err: unknown = null;
      try {
        recheckCaptions(user, id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(429);
      expect((err as HttpError).message).toMatch(/YouTube is limiting caption requests.*about 1 minute\./);
      expect(retries()).toBe(0);
      expect(videoRows(id)[0]).toMatchObject({ status: "ready", transcript_status: "needs_manual" });
    } finally {
      resetCaptionLimit();
    }
    expect(recheckCaptions(user, id)).toEqual({ rechecked: 1 });
    expect(retries()).toBe(1);
    await runUntilIdle(opts()); // leave no queued job for the next test
  });
});

describe("a caption rate limit in the pipeline", () => {
  it("goes back to the queue; out of retries the video plays a default window and can be re-checked", async () => {
    const user = seedUser();
    let calls = 0;
    const transcripts: Providers["transcripts"] = {
      async fetch() {
        calls++;
        throw new JobRetryableError("YouTube is limiting caption downloads from this server (HTTP 429); will retry.", { retryAfterMs: 5000 });
      },
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidLIMITED1");
    const first = await runUntilIdle(opts({ transcripts }));
    expect(first.retried).toBe(1);
    expect(videoRows(id)[0].status).not.toBe("ready"); // waiting, not "no captions"
    expect(jobRows("queued").map((j) => j.type)).toEqual(["process_video"]);

    offset = 6000;
    const second = await runUntilIdle(opts({ transcripts }));
    expect(second.retried).toBe(1);
    offset = 60_000;
    const third = await runUntilIdle(opts({ transcripts })); // the last attempt
    expect(calls).toBe(3);
    expect(third.failed).toBe(0);
    expect(videoRows(id)[0]).toMatchObject({ status: "ready", transcript_status: "needs_manual", error: null });
    expect(get<{ status: string }>("SELECT status FROM playlists WHERE id = ?", id)!.status).toBe("ready");
    // Still in the feed meanwhile, with a reel cut without captions.
    expect(momentRows(id).map((m) => m.basis)).toEqual(["position"]);

    // Later, YouTube answers: the same button finds the captions, and the reels are cut from them.
    expect(recheckCaptions(user, id)).toEqual({ rechecked: 1 });
    await runUntilIdle(opts());
    expect(videoRows(id)[0]).toMatchObject({ status: "ready", transcript_status: "ok" });
    expect(momentRows(id).length).toBeGreaterThan(0);
    expect(momentRows(id).every((m) => m.basis === "transcript")).toBe(true);
  });
});

describe("loadReelFeed", () => {
  it("returns the caller's reels with captions, one playlist played as a series", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70], [80, 120]]));
    const feed = loadReelFeed(user);
    expect(feed).toMatchObject({ total: 6, pending: 0, videos: 3, noCaptions: 0 });
    expect(feed.reels).toHaveLength(6);
    // Video by video in playlist order, each video's reels in the order they occur.
    expect(feed.reels.map((r) => [r.youtubeVideoId, r.start])).toEqual([
      ["vidREEL0001", 10],
      ["vidREEL0001", 80],
      ["vidREEL0002", 10],
      ["vidREEL0002", 80],
      ["vidREEL0003", 10],
      ["vidREEL0003", 80],
    ]);
    const first = feed.reels[0];
    expect(first).toMatchObject({
      playlistId: id,
      playlistTitle: "Memory Series",
      channel: "Test Channel",
      videoTitle: "Video 1: ideas about memory",
      end: 70,
      hook: "Hook 1",
      takeaway: "Takeaway 1.",
      picked: "ai",
      basis: "transcript",
      saved: false,
      seen: false,
      shareSlug: null,
    });
    expect(first.captions.length).toBeGreaterThan(5);
    expect(first.captions.every((c) => c.t >= 9.5 && c.t < 70 && c.text.length > 0)).toBe(true);
    expect(first.captions[0].text).toMatch(/^He memorised long lists/);

    expect(loadReelFeed(seedUser()).reels).toHaveLength(0); // someone else sees nothing
    expect(loadReelFeed(user, { playlistId: "nope" })).toMatchObject({ total: 0, videos: 0 });
    expect(loadReelFeed(user, { playlistId: id, limit: 2 }).reels).toHaveLength(2);
  });

  it("puts seen reels behind unseen ones, longest ago first, and lists saved ones newest first", async () => {
    const user = seedUser();
    await readyPlaylist(user, fixedMoments([[10, 70], [80, 120]]));
    const ids = loadReelFeed(user).reels.map((r) => r.id);

    const t0 = Date.now();
    // Watched in the order 1, 0: the one seen longest ago (1) comes back first.
    expect(setReelState(user, ids[1], { seen: true }, t0)).toEqual({ saved: false, seen: true });
    setReelState(user, ids[0], { seen: true }, t0 + 1000);
    const after = loadReelFeed(user).reels;
    expect(after.map((r) => r.id)).toEqual([...ids.slice(2), ids[1], ids[0]]);
    expect(after.at(-1)).toMatchObject({ seen: true });

    expect(setReelState(user, ids[3], { saved: true }, t0 + 2000)).toEqual({ saved: true, seen: false });
    setReelState(user, ids[0], { saved: true }, t0 + 3000);
    const saved = loadReelFeed(user, { saved: true });
    expect(saved.total).toBe(2);
    expect(saved.reels.map((r) => r.id)).toEqual([ids[0], ids[3]]);
    expect(setReelState(user, ids[0], { saved: false })).toEqual({ saved: false, seen: true });
    expect(loadReelFeed(user, { saved: true }).reels.map((r) => r.id)).toEqual([ids[3]]);
  });

  it("reports videos still being cut and videos with no captions, and queues missing reels", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70]]), [three[0], mkVideo("NOCAPfeed01", 1)]);
    const v = videoRows(id)[0];
    run("DELETE FROM moments WHERE video_id = ?", v.id);
    run("UPDATE videos SET moments_status = 'none' WHERE id = ?", v.id);
    const feed = loadReelFeed(user);
    // The video without captions is in the feed already (a reel by position).
    expect(feed).toMatchObject({ total: 1, pending: 1, videos: 2, noCaptions: 1 });
    expect(feed.reels.map((r) => r.basis)).toEqual(["position"]);
    expect(jobRows("queued").map((j) => j.type)).toEqual(["pick_moments"]);
    await runUntilIdle(opts({ ai: fixedMoments([[20, 80]]) }));
    expect(loadReelFeed(user)).toMatchObject({ total: 2, pending: 0 });
  });

  it("weaves all the caller's playlists together, each played from its first part", async () => {
    const user = seedUser();
    // A newest-first series (Week 3 listed first) with captions...
    const weeks = [3, 2, 1].map((n, i) => ({ ...mkVideo(`vidWEEK000${n}`, i), title: `Your Week ${n} Plan` }));
    const series = await readyPlaylist(user, fixedMoments([[10, 70], [80, 140]]), weeks);
    // ...and a newer playlist whose videos have no captions.
    const { id: plain } = createPlaylist(user, "https://www.youtube.com/playlist?list=PLreelsplain01");
    await runUntilIdle(opts({ youtube: fakeYouTube([mkVideo("NOCAPmix001", 0), mkVideo("NOCAPmix002", 1)], { title: "Plain" }) }));

    const feed = loadReelFeed(user);
    expect(feed.total).toBe(8);
    const ids = feed.reels.map((r) => r.youtubeVideoId);
    // Both playlists near the top; the series from Week 1, each week's reels in time order.
    expect(new Set(feed.reels.slice(0, 3).map((r) => r.playlistId))).toEqual(new Set([series, plain]));
    expect(ids.filter((x) => x.startsWith("vidWEEK"))).toEqual(["vidWEEK0001", "vidWEEK0001", "vidWEEK0002", "vidWEEK0002", "vidWEEK0003", "vidWEEK0003"]);
    expect(feed.reels.filter((r) => r.youtubeVideoId === "vidWEEK0001").map((r) => r.start)).toEqual([10, 80]);
    expect(ids.filter((x) => x.startsWith("NOCAP"))).toEqual(["NOCAPmix001", "NOCAPmix002"]);

    // One playlist's feed is just its series.
    expect(loadReelFeed(user, { playlistId: series }).reels.map((r) => r.youtubeVideoId)).toEqual([
      "vidWEEK0001",
      "vidWEEK0001",
      "vidWEEK0002",
      "vidWEEK0002",
      "vidWEEK0003",
      "vidWEEK0003",
    ]);
  });

  it("records viewing reports, which re-order the feed", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70], [80, 140]]));
    const [a, b] = loadReelFeed(user).reels; // video 1's two reels
    const t0 = Date.now();

    expect(setReelState(user, a.id, { watched: 1.4, skipped: true }, t0)).toEqual({ saved: false, seen: true });
    const row = (rid: string) => get<MomentRow>("SELECT * FROM moments WHERE id = ?", rid)!;
    expect(row(a.id)).toMatchObject({ watch_s: 1, completions: 0, skips: 1, seen_at: t0 });

    // Swiped away early: the rest of that video waits behind videos 2 and 3 (4 reels), and the
    // swiped reel itself is last.
    const after = loadReelFeed(user).reels.map((r) => r.id);
    expect(after.indexOf(b.id)).toBe(4);
    expect(after.at(-1)).toBe(a.id);

    setReelState(user, b.id, { watched: 60, completed: true }, t0 + 1000);
    expect(row(b.id)).toMatchObject({ watch_s: 60, completions: 1, skips: 0 });
    // A completed report never counts as a skip, and a report is capped.
    setReelState(user, b.id, { watched: 5000, completed: true, skipped: true }, t0 + 2000);
    expect(row(b.id)).toMatchObject({ watch_s: 660, completions: 2, skips: 0 });
    expect(momentRows(id)).toHaveLength(6);
  });

  it("another user's reel cannot be saved, seen or shared", async () => {
    const owner = seedUser();
    const id = await readyPlaylist(owner, fixedMoments([[10, 70]]), [three[0]]);
    const reel = momentRows(id)[0].id;
    const stranger = seedUser();
    expect(await status(() => setReelState(stranger, reel, { saved: true }))).toBe(404);
    expect(await status(() => shareMoment(stranger, reel))).toBe(404);
    expect(await status(() => unshareMoment(stranger, reel))).toBe(404);
    expect(await status(() => sharePlaylist(stranger, id))).toBe(404);
    expect(await status(() => unsharePlaylist(stranger, id))).toBe(404);
    expect(momentRows(id)[0].saved_at).toBeNull();
  });
});

describe("captionsFor", () => {
  it("keeps the lines that start inside the window and cleans their text", () => {
    const segs = [
      { start: 0, dur: 5, text: "before" },
      { start: 9.6, dur: 5, text: "just inside &amp; <b>clean</b>" },
      { start: 20, dur: 5, text: "middle" },
      { start: 30, dur: 5, text: "after" },
    ];
    expect(captionsFor(segs, 10, 30)).toEqual([
      { t: 9.6, d: 5, text: "just inside & b clean /b" },
      { t: 20, d: 5, text: "middle" },
    ]);
  });
});

describe("share links", () => {
  it("a shared reel is public by its slug, shows nothing about the owner, and can be revoked", async () => {
    const user = seedUser("owner-of-reels@example.com");
    const id = await readyPlaylist(user, fixedMoments([[10, 70], [80, 120]]));
    const reel = loadReelFeed(user).reels[0];
    setReelState(user, reel.id, { saved: true, seen: true });

    const { slug } = shareMoment(user, reel.id);
    expect(isShareSlug(slug)).toBe(true);
    expect(shareMoment(user, reel.id).slug).toBe(slug); // one link per reel
    expect(loadReelFeed(user).reels.find((r) => r.id === reel.id)!.shareSlug).toBe(slug);

    const page = getSharedPage(slug)!;
    expect(page).toMatchObject({ kind: "moment", title: "Hook 1", channel: "Test Channel" });
    expect(page.reels).toHaveLength(1);
    expect(page.reels[0]).toMatchObject({
      id: reel.id,
      playlistId: null,
      youtubeVideoId: reel.youtubeVideoId,
      start: 10,
      end: 70,
      saved: false,
      seen: false,
      shareSlug: null,
    });
    expect(page.reels[0].captions.length).toBeGreaterThan(0);
    const json = JSON.stringify(page);
    expect(json).not.toContain(user);
    expect(json).not.toContain(id);
    expect(json).not.toContain("owner-of-reels");

    unshareMoment(user, reel.id);
    expect(getSharedPage(slug)).toBeNull();
    expect(shareMoment(user, reel.id).slug).not.toBe(slug); // a new link, the old one stays dead
  });

  it("a shared playlist is a public feed of its reels", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70], [80, 120]]));
    expect(getPlaylistShare(user, id)).toBeNull();
    const { slug } = sharePlaylist(user, id);
    expect(sharePlaylist(user, id).slug).toBe(slug);
    expect(getPlaylistShare(user, id)).toBe(slug);
    const page = getSharedPage(slug)!;
    expect(page).toMatchObject({ kind: "playlist", title: "Memory Series", channel: "Brain Lab" });
    expect(page.reels).toHaveLength(6);
    expect(page.reels.every((r) => r.playlistId === null && !r.saved && !r.seen)).toBe(true);
    unsharePlaylist(user, id);
    expect(getSharedPage(slug)).toBeNull();
    expect(getPlaylistShare(user, id)).toBeNull();
  });

  it("rejects anything that is not a slug without touching the database, and unknown slugs", () => {
    for (const bad of ["", "short", "x".repeat(23), "has space in it 1234567", "../../../etc/passwd....", "' OR 1=1 --xxxxxxxxxxxx"]) {
      expect(isShareSlug(bad)).toBe(false);
      expect(getSharedPage(bad)).toBeNull();
    }
    expect(getSharedPage("AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
  });

  it("the landing page's sample is the feed SAMPLE_FEED names, and is gone when that link is", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70], [80, 120]]));
    expect(getSampleFeed()).toBeNull(); // nothing configured
    const { slug } = sharePlaylist(user, id);
    process.env.SAMPLE_FEED = `https://recallcast.example.com/r/${slug}`;
    resetEnvCache();
    try {
      const sample = getSampleFeed()!;
      expect(sample).toEqual({ slug, title: "Memory Series", channel: "Brain Lab", count: 6, hooks: ["Hook 1", "Hook 1", "Hook 1"] });
      expect(sample.hooks).toHaveLength(SAMPLE_HOOKS);
      expect(JSON.stringify(sample)).not.toContain(user);
      expect(JSON.stringify(sample)).not.toContain(id);

      // one reel can be the sample too
      const reel = momentRows(id)[0];
      process.env.SAMPLE_FEED = shareMoment(user, reel.id).slug;
      resetEnvCache();
      expect(getSampleFeed()).toMatchObject({ count: 1, hooks: [reel.hook], channel: "Test Channel" });

      // revoked: the landing page falls back to no sample instead of linking to a 404
      process.env.SAMPLE_FEED = slug;
      resetEnvCache();
      unsharePlaylist(user, id);
      expect(getSampleFeed()).toBeNull();
    } finally {
      delete process.env.SAMPLE_FEED;
      resetEnvCache();
    }
  });

  it("caps the public links one account can hold", async () => {
    const user = seedUser();
    const id = await readyPlaylist(user, fixedMoments([[10, 70], [80, 120]]));
    process.env.MAX_SHARES_PER_USER = "2";
    resetEnvCache();
    try {
      const reels = momentRows(id);
      shareMoment(user, reels[0].id);
      shareMoment(user, reels[1].id);
      expect(await status(() => shareMoment(user, reels[2].id))).toBe(429);
      expect(await status(() => sharePlaylist(user, id))).toBe(429);
      unshareMoment(user, reels[0].id);
      expect(sharePlaylist(user, id).slug).toMatch(/^[A-Za-z0-9_-]{22}$/);
    } finally {
      delete process.env.MAX_SHARES_PER_USER;
      resetEnvCache();
    }
  });
});
