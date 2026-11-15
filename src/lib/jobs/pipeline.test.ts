import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// A real temp-file database (WAL) and a temp storage dir for this file, set before any DB use.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-pipeline-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
process.env.STORAGE_DIR = path.join(dir, "storage");

import { AiInputError, AiRefusalError } from "@/lib/ai/errors";
import { CLIP_MAX_S, CLIP_MIN_S } from "@/lib/ai/clip";
import { closeDb, get, run } from "@/lib/db";
import { ConfigError, resetEnvCache } from "@/lib/env";
import { newId } from "@/lib/ids";
import { createMockAiProvider } from "@/lib/ai/mock";
import { createMockTranscriptProvider } from "@/lib/transcripts/mock";
import type { ClipPlan } from "@/lib/types";
import { YouTubeError } from "@/lib/youtube/errors";
import { createPlaylist, deletePlaylist, retryPlaylist, submitManualTranscript } from "./commands";
import { BUSY_MESSAGE, JobRetryableError } from "./errors";
import { cleanSegments, ingestPlaylist, parseStoredClip, processVideo } from "./pipeline";
import { staticProviders, type Providers } from "./providers";
import { recoverStale, runUntilIdle, silentLogger, type ProcessOptions } from "./worker";
import { getPlaylistDetail, listPlaylistsForUser } from "./views";
import {
  countingAi,
  episodeRows,
  fakeYouTube,
  jobRows,
  mkVideo,
  mockProviders,
  playlistRow,
  seedUser,
  videoRows,
} from "./test-helpers";

resetEnvCache();

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLtestlist0001";
const three = [mkVideo("vidAAAAAAA1", 0), mkVideo("vidAAAAAAA2", 1), mkVideo("vidAAAAAAA3", 2)];

let offset = 0;
const clock = () => Date.now() + offset;
const noJitter = { random: () => 0.5, baseMs: 1000 };
/** The heuristic provider: tests that fake the clip pick borrow its moment picker. */
const mockAi = createMockAiProvider();

function opts(overrides: Partial<Providers> = {}): ProcessOptions {
  return { resolve: mockProviders(overrides), logger: silentLogger, now: clock, backoff: noJitter };
}

async function drain(o: ProcessOptions) {
  return runUntilIdle(o);
}

/** A transcript provider that counts fetches (mock fixture underneath). */
function countingTranscripts() {
  const base = createMockTranscriptProvider();
  const t = {
    calls: 0,
    async fetch(id: string) {
      t.calls++;
      return base.fetch(id);
    },
  };
  return t;
}

/** An AI provider that always answers with this window, marked as Claude's pick. */
function fixedAi(start: number, end: number, calls = { n: 0 }): Providers["ai"] {
  return {
    pickMoments: mockAi.pickMoments,
    async pickClip() {
      calls.n++;
      return { start, end, title: "Why spacing beats cramming", summary: "The forgetting curve.", reason: "The core idea.", picked: "ai" };
    },
  };
}

/** ~10 minutes of timed lines, one every 15 s, in the "m:ss text" paste format. */
function pastedTranscript(topic: string): string {
  return Array.from({ length: 40 }, (_, i) => {
    const t = i * 15;
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")} Sentence ${i} explains ${topic}, retrieval cues and why spaced reviews consolidate memory traces.`;
  }).join("\n");
}

function episodeClip(videoId: string): ClipPlan | null {
  const row = get<{ script_json: string }>("SELECT script_json FROM episodes WHERE video_id = ? AND kind = 'video'", videoId);
  return parseStoredClip(row?.script_json);
}

function episodeRow(videoId: string) {
  return get<{ id: string; status: string; audio_path: string | null; duration_s: number; title: string; error: string | null }>(
    "SELECT id, status, audio_path, duration_s, title, error FROM episodes WHERE video_id = ?",
    videoId,
  );
}

beforeEach(() => {
  offset = 0;
});

describe("full pipeline with mock providers", () => {
  it("ingest -> process -> one clip per video -> playlist ready", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    expect(playlistRow(id)!.status).toBe("queued");

    const r = await drain(opts({ youtube: fakeYouTube(three, { title: "Memory Series", channel: "Brain Lab" }) }));
    // 1 ingest + 3 process + 3 pick_moments (the reels of each video)
    expect(r).toEqual({ processed: 7, done: 7, retried: 0, failed: 0 });

    const p = playlistRow(id)!;
    expect(p).toMatchObject({ status: "ready", error: null, title: "Memory Series", channel: "Brain Lab" });

    const vids = videoRows(id);
    expect(vids.map((v) => v.status)).toEqual(["ready", "ready", "ready"]);
    expect(vids.every((v) => v.transcript_status === "ok")).toBe(true);

    const eps = episodeRows(id);
    expect(eps).toHaveLength(3);
    expect(eps.every((e) => e.kind === "video" && e.status === "voiced" && e.audio_path === null && e.error === null)).toBe(true);
    for (const v of vids) {
      const clip = episodeClip(v.id)!;
      expect(clip.picked).toBe("heuristic");
      expect(clip.end).toBeGreaterThan(clip.start);
      expect(episodeRow(v.id)!.duration_s).toBe(clip.end - clip.start);
    }

    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM cards WHERE playlist_id = ?", id)!.n).toBe(0);
    expect(jobRows().every((j) => j.status === "done")).toBe(true);
    expect(jobRows().map((j) => j.type).sort()).toEqual([
      "ingest_playlist",
      "pick_moments",
      "pick_moments",
      "pick_moments",
      "process_video",
      "process_video",
      "process_video",
    ]);

    // Read models used by the API
    const detail = getPlaylistDetail(user, id)!;
    expect(detail.progress).toEqual({ total: 3, ready: 3, failed: 0, skipped: 0, processing: 0 });
    expect(detail.episodes.map((e) => e.videoId)).toEqual(vids.map((v) => v.id)); // playlist order
    expect(detail.episodes[0]).toMatchObject({
      playlistId: id,
      youtubeVideoId: "vidAAAAAAA1",
      title: detail.episodes[0].clip.title,
      durationS: detail.episodes[0].clip.end - detail.episodes[0].clip.start,
    });
    expect(detail.episodes[0].excerpt.split(" ").length).toBeGreaterThan(20); // words spoken inside the clip
    expect(detail.videos[0].episodeId).toBe(detail.episodes[0].id);
    expect(getPlaylistDetail(seedUser(), id)).toBeNull(); // not the owner

    const list = listPlaylistsForUser(user);
    expect(list).toHaveLength(1);
    expect(list[0].counts).toMatchObject({ total: 3, ready: 3, failed: 0, episodes: 3 });
  });

  it("single video: one clip, ready", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidSINGLE01");
    await drain(opts());
    expect(playlistRow(id)!.status).toBe("ready");
    const eps = episodeRows(id);
    expect(eps).toHaveLength(1);
    expect(eps[0].kind).toBe("video");
    expect(videoRows(id)[0].youtube_video_id).toBe("vidSINGLE01");
  });

  it("a short video plays in full", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts({ youtube: fakeYouTube([mkVideo("vidSHORT001", 0, 100)]) }));
    const clip = episodeClip(videoRows(id)[0].id)!;
    // The mock transcript runs to 121.5 s, past the stated duration: the whole video is played.
    expect(clip).toMatchObject({ start: 0, end: 122, picked: "whole" });
  });
});

describe("clip picking", () => {
  it("stores Claude's pick as the episode (picked 'ai')", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidAIPICK01");
    await drain(opts({ ai: fixedAi(60, 270) }));
    const v = videoRows(id)[0];
    expect(v.status).toBe("ready");
    expect(episodeClip(v.id)).toEqual({
      start: 60,
      end: 270,
      title: "Why spacing beats cramming",
      summary: "The forgetting curve.",
      reason: "The core idea.",
      picked: "ai",
    });
    expect(episodeRow(v.id)).toMatchObject({ status: "voiced", audio_path: null, duration_s: 210, title: "Why spacing beats cramming" });
  });

  it("a non-retryable AI error falls back to the heuristic; the video is still ready", async () => {
    for (const err of [new AiRefusalError("cyber"), new AiInputError("The transcript is too long to analyze.")]) {
      const user = seedUser();
      const ai: Providers["ai"] = {
        pickMoments: mockAi.pickMoments,
        async pickClip() {
          throw err;
        },
      };
      const { id } = createPlaylist(user, "https://youtu.be/vidFALLBK01");
      const r = await drain(opts({ ai }));
      expect(r.failed).toBe(0);
      const v = videoRows(id)[0];
      expect(v).toMatchObject({ status: "ready", error: null, transcript_status: "ok" });
      const clip = episodeClip(v.id)!;
      expect(clip.picked).toBe("heuristic");
      expect(clip.end - clip.start).toBeGreaterThanOrEqual(CLIP_MIN_S);
      expect(clip.end - clip.start).toBeLessThanOrEqual(CLIP_MAX_S);
      expect(playlistRow(id)!.status).toBe("ready");
    }
  });

  it("an unexpected error from the AI provider fails the video visibly instead of falling back", async () => {
    const user = seedUser();
    const ai: Providers["ai"] = {
        pickMoments: mockAi.pickMoments,
      async pickClip() {
        throw new TypeError("Cannot read properties of undefined (reading 'secretInternalThing')");
      },
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidBUGGY001");
    await drain(opts({ ai }));
    const v = videoRows(id)[0];
    expect(v.status).toBe("failed");
    expect(v.error).not.toMatch(/secretInternalThing/);
    expect(episodeClip(v.id)).toBeNull();
  });

  it("a retryable AI error propagates: the job backs off and succeeds later, reusing the transcript", async () => {
    const user = seedUser();
    const transcripts = countingTranscripts();
    const calls = { n: 0 };
    const good = fixedAi(30, 240, calls);
    let failures = 0;
    const flaky: Providers["ai"] = {
      pickMoments: mockAi.pickMoments,
      async pickClip(i) {
        if (failures < 1) {
          failures++;
          throw new JobRetryableError("Claude API rate limit reached; will retry.", { retryAfterMs: 5000 });
        }
        return good.pickClip(i);
      },
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidRETRY001");
    const first = await drain(opts({ ai: flaky, transcripts }));
    expect(first.retried).toBe(1);
    const job = jobRows("queued")[0];
    expect(job.type).toBe("process_video");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toMatch(/rate limit/);
    expect(episodeRows(id)).toHaveLength(0); // nothing stored for a retryable failure
    expect(videoRows(id)[0].status).toBe("analyzing");
    expect(playlistRow(id)!.status).toBe("processing");

    offset = 6000; // past the retry-after hint
    await drain(opts({ ai: flaky, transcripts }));
    expect(transcripts.calls).toBe(1); // the stored transcript was reused on the retry
    expect(calls.n).toBe(1);
    expect(episodeClip(videoRows(id)[0].id)!.picked).toBe("ai");
    expect(playlistRow(id)!.status).toBe("ready");
  });

  it("retryable errors that never clear fail the video after max attempts; retry recovers it", async () => {
    const user = seedUser();
    const transcripts = countingTranscripts();
    const ai: Providers["ai"] = {
        pickMoments: mockAi.pickMoments,
      async pickClip() {
        throw new JobRetryableError("Claude API is temporarily unavailable (HTTP 529); will retry.");
      },
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidOVERLOAD");
    for (let i = 0; i < 4; i++) {
      await drain(opts({ ai, transcripts }));
      offset += 60_000;
    }
    const v = videoRows(id)[0];
    expect(v.status).toBe("failed");
    expect(v.error).toBe(BUSY_MESSAGE); // provider detail stays in jobs.last_error
    const job = jobRows().find((j) => j.type === "process_video" && j.payload_json.includes(v.id))!;
    expect(job).toMatchObject({ status: "failed", attempts: 3 });
    expect(job.last_error).toMatch(/HTTP 529/);
    expect(episodeRows(id)).toHaveLength(0);
    expect(playlistRow(id)!.status).toBe("failed");

    expect(retryPlaylist(user, id)).toEqual({ retried: 1 });
    await drain(opts({ transcripts }));
    expect(transcripts.calls).toBe(1); // transcript reused
    expect(videoRows(id)[0].status).toBe("ready");
    expect(playlistRow(id)!.status).toBe("ready");
  });
});

describe("no captions", () => {
  it("stores a default 'nocaptions' clip, marks the transcript needs_manual and the video ready", async () => {
    const user = seedUser();
    const vids = [mkVideo("vidAAAAAAA1", 0), mkVideo("vidAAAAAAA2", 1), mkVideo("NOCAPvid003", 2)];
    const ai = countingAi();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts({ youtube: fakeYouTube(vids), ai }));

    const rows = videoRows(id);
    expect(rows.map((v) => v.status)).toEqual(["ready", "ready", "ready"]);
    expect(rows.map((v) => v.transcript_status)).toEqual(["ok", "ok", "needs_manual"]);
    expect(rows[2].error).toBeNull();
    expect(ai.calls.pickClip).toBe(2); // no AI call without a transcript
    expect(get("SELECT 1 AS x FROM transcripts WHERE video_id = ?", rows[2].id)).toBeUndefined();
    const clip = episodeClip(rows[2].id)!;
    // 600 s video: starts just after the intro (10%), CLIP_TARGET_S long.
    expect(clip).toMatchObject({ start: 60, end: 270, picked: "nocaptions" });
    expect(playlistRow(id)).toMatchObject({ status: "ready", error: null });
  });

  it("a pasted transcript on a nocaptions video re-runs the pick and replaces the episode", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts({ youtube: fakeYouTube([mkVideo("NOCAPvid010", 0)]) }));
    const vid = videoRows(id)[0].id;
    const oldEp = episodeRow(vid)!;
    expect(episodeClip(vid)!.picked).toBe("nocaptions");

    const res = submitManualTranscript(user, vid, pastedTranscript("interleaving"));
    expect(res.segments).toBeGreaterThan(0);
    expect(get<{ source: string }>("SELECT source FROM transcripts WHERE video_id = ?", vid)!.source).toBe("manual");
    expect(episodeRow(vid)).toBeUndefined(); // the default window is gone at once
    expect(videoRows(id)[0]).toMatchObject({ status: "pending", transcript_status: "ok" });
    expect(playlistRow(id)!.status).toBe("processing");

    const transcripts = countingTranscripts();
    await drain(opts({ transcripts, ai: fixedAi(90, 300) }));
    expect(transcripts.calls).toBe(0); // the pasted transcript is used, not fetched
    const eps = episodeRows(id);
    expect(eps).toHaveLength(1);
    expect(eps[0].id).not.toBe(oldEp.id);
    expect(episodeClip(vid)).toMatchObject({ start: 90, end: 300, picked: "ai" });
    expect(videoRows(id)[0]).toMatchObject({ status: "ready", transcript_status: "ok" });
    expect(playlistRow(id)!.status).toBe("ready");
  });
});

describe("idempotency", () => {
  it("re-running each step does not duplicate videos or episodes", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts());
    const vids = videoRows(id);
    const before = episodeRows(id);
    expect(before).toHaveLength(3);

    // ingest again: videos already exist -> nothing new
    const yt = fakeYouTube(three);
    await ingestPlaylist(id, { youtube: yt });
    expect(yt.calls).toBe(0);
    expect(videoRows(id)).toHaveLength(3);

    // process again: the stored transcript is reused, the episode is replaced (not added)
    const ai = countingAi();
    const transcripts = countingTranscripts();
    expect(await processVideo(vids[0].id, { transcripts, ai })).toBe(id);
    expect(transcripts.calls).toBe(0);
    expect(ai.calls.pickClip).toBe(1);
    let videoEps = episodeRows(id).filter((e) => e.video_id === vids[0].id);
    expect(videoEps).toHaveLength(1);
    expect(videoEps[0].id).not.toBe(before.find((e) => e.video_id === vids[0].id)!.id);
    expect(videoRows(id)[0].status).toBe("ready");

    // and once more, with a different pick: still exactly one, holding the newest clip
    await processVideo(vids[0].id, { transcripts, ai: fixedAi(120, 330) });
    videoEps = episodeRows(id).filter((e) => e.video_id === vids[0].id);
    expect(videoEps).toHaveLength(1);
    expect(episodeClip(vids[0].id)).toMatchObject({ start: 120, end: 330, picked: "ai" });
    expect(episodeRows(id)).toHaveLength(3);
    // Processing a video twice queues its reels once (the job is unique per video), nothing else.
    expect(jobRows("queued").map((j) => j.type)).toEqual(["pick_moments"]);
  });

  it("a skipped video is left alone", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts({ youtube: fakeYouTube([mkVideo("vidAAAAAAA1", 0), mkVideo("vidLONG0009", 1, 10_801)]) }));
    const skipped = videoRows(id)[1];
    const ai = countingAi();
    expect(await processVideo(skipped.id, { transcripts: createMockTranscriptProvider(), ai })).toBe(id);
    expect(ai.calls.pickClip).toBe(0);
    expect(videoRows(id)[1].status).toBe("skipped");
    expect(episodeRow(skipped.id)).toBeUndefined();
  });
});

describe("partial failures and recovery", () => {
  it("skips videos longer than the limit, and fails a playlist where every video is skipped", async () => {
    const user = seedUser();
    const vids = [mkVideo("vidAAAAAAA1", 0), mkVideo("vidLONG0002", 1, 10_801), mkVideo("vidAAAAAAA3", 2)];
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts({ youtube: fakeYouTube(vids) }));
    const rows = videoRows(id);
    expect(rows.map((v) => v.status)).toEqual(["ready", "skipped", "ready"]);
    expect(rows[1].error).toMatch(/Longer than 3 hours/);
    expect(playlistRow(id)!.status).toBe("ready");
    expect(jobRows().filter((j) => j.type === "process_video" && j.payload_json.includes(rows[1].id))).toHaveLength(0);

    const { id: id2 } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts({ youtube: fakeYouTube([mkVideo("vidLONG0001", 0, 20_000)]) }));
    expect(playlistRow(id2)!.status).toBe("failed");
    expect(playlistRow(id2)!.error).toMatch(/length limit/);
  });

  it("caps the number of videos and de-duplicates repeats", async () => {
    const user = seedUser();
    const many = Array.from({ length: 30 }, (_, i) => mkVideo(`vidMANY${String(i).padStart(4, "0")}`, i));
    many.splice(1, 0, { ...many[0], position: 0 });
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await ingestPlaylist(id, { youtube: fakeYouTube(many) }, { maxVideos: 25, maxVideoSeconds: 10_800 });
    const rows = videoRows(id);
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((r) => r.youtube_video_id)).size).toBe(25);
    expect(jobRows("queued").filter((j) => j.type === "process_video")).toHaveLength(25);
    expect(playlistRow(id)!.status).toBe("processing");
    run("DELETE FROM jobs");
  });

  it("YouTube errors fail the ingest with the provider's user-facing message", async () => {
    const user = seedUser();
    const yt = {
      fetchPlaylist: async () => {
        throw new YouTubeError("not_found", "YouTube playlist not found. It may be private or deleted.", { status: 404 });
      },
      fetchVideo: async () => {
        throw new Error("unused");
      },
    };
    const { id } = createPlaylist(user, PLAYLIST_URL);
    const r = await drain(opts({ youtube: yt }));
    expect(r.failed).toBe(1);
    expect(playlistRow(id)).toMatchObject({ status: "failed", error: "YouTube playlist not found. It may be private or deleted." });

    // retry re-queues the ingest
    expect(retryPlaylist(user, id)).toEqual({ retried: 1 });
    expect(playlistRow(id)!.status).toBe("queued");
    await drain(opts());
    expect(playlistRow(id)!.status).toBe("ready");
  });

  it("a missing provider key fails only the jobs that need it, with a generic user message", async () => {
    const user = seedUser();
    const resolve = async <K extends keyof Providers>(key: K): Promise<Providers[K]> => {
      if (key === "ai") throw new ConfigError("Missing environment variable ANTHROPIC_API_KEY (required by AI_PROVIDER=anthropic). Set it in .env.local.");
      return mockProviders()(key);
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidCONFIG01");
    await runUntilIdle({ resolve, logger: silentLogger, now: clock });
    const v = videoRows(id)[0];
    expect(v.status).toBe("failed");
    expect(v.error).toBe("Something went wrong while preparing this episode. Please retry."); // no config details for users
    const job = jobRows("failed").find((j) => j.type === "process_video" && j.payload_json.includes(v.id))!;
    expect(job.last_error).toMatch(/ANTHROPIC_API_KEY/); // kept for operators
    expect(jobRows().find((j) => j.type === "ingest_playlist" && j.payload_json.includes(id))!.status).toBe("done");
    expect(playlistRow(id)!.status).toBe("failed");
  });

  it("unknown errors are stored with a generic message (no internals leak)", async () => {
    const user = seedUser();
    const yt = {
      fetchPlaylist: async () => {
        throw new Error("unused");
      },
      fetchVideo: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'secretInternalThing')");
      },
    };
    const { id } = createPlaylist(user, "https://youtu.be/vidBROKEN01");
    await drain(opts({ youtube: yt }));
    expect(playlistRow(id)).toMatchObject({ status: "failed", error: "We couldn't read this playlist from YouTube. Please try again." });
    const job = jobRows("failed").find((j) => j.payload_json.includes(id))!;
    expect(job.last_error).toMatch(/secretInternalThing/); // kept for operators
  });
});

describe("deletion and stale locks", () => {
  it("deleting the playlist while the clip is being picked is a no-op, not an error", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidDELETE01");
    const inner = fixedAi(30, 240);
    const ai: Providers["ai"] = {
        pickMoments: mockAi.pickMoments,
      async pickClip(i) {
        deletePlaylist(user, id); // user deletes while Claude is thinking
        return inner.pickClip(i);
      },
    };
    const r = await drain(opts({ ai }));
    expect(r.failed).toBe(0);
    expect(playlistRow(id)).toBeUndefined();
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM episodes WHERE playlist_id = ?", id)!.n).toBe(0);
  });

  it("deleting while the transcript is being fetched is a no-op too", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidDELETE02");
    const base = createMockTranscriptProvider();
    const transcripts = {
      async fetch(videoId: string) {
        deletePlaylist(user, id);
        return base.fetch(videoId);
      },
    };
    const ai = countingAi();
    const r = await drain(opts({ transcripts, ai }));
    expect(r.failed).toBe(0);
    expect(ai.calls.pickClip).toBe(0);
    expect(playlistRow(id)).toBeUndefined();
  });

  it("processVideo for a video that no longer exists returns null", async () => {
    expect(await processVideo(newId(), { transcripts: createMockTranscriptProvider(), ai: countingAi() })).toBeNull();
  });

  it("deletePlaylist cascades rows and cancels queued jobs", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, PLAYLIST_URL);
    await drain(opts());
    const vid = videoRows(id)[0].id;
    retryPlaylist(user, id); // nothing failed -> nothing queued
    expect(jobRows("queued")).toHaveLength(0);
    run("UPDATE videos SET status = 'failed' WHERE id = ?", vid);
    retryPlaylist(user, id); // queues process_video
    expect(jobRows("queued")).toHaveLength(1);

    expect(() => deletePlaylist(seedUser(), id)).toThrow(/not found/);
    deletePlaylist(user, id);
    expect(get("SELECT 1 AS x FROM videos WHERE playlist_id = ?", id)).toBeUndefined();
    expect(get("SELECT 1 AS x FROM episodes WHERE playlist_id = ?", id)).toBeUndefined();
    expect(get("SELECT 1 AS x FROM transcripts WHERE video_id = ?", vid)).toBeUndefined();
    expect(jobRows("queued")).toHaveLength(0);
  });

  it("an abandoned job with no attempts left fails its video via the failure handler", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidSTALE001");
    await ingestPlaylist(id, { youtube: fakeYouTube([mkVideo("vidSTALE001", 0)]) });
    const job = jobRows("queued").find((j) => j.type === "process_video")!;
    run(
      "UPDATE jobs SET status = 'running', attempts = 3, locked_at = ? WHERE id = ?",
      Date.now() - 11 * 60 * 1000,
      job.id,
    );
    run("UPDATE jobs SET status = 'done' WHERE type = 'ingest_playlist'");
    expect(recoverStale(silentLogger)).toBe(1);
    const v = videoRows(id)[0];
    expect(v.status).toBe("failed");
    expect(v.error).toMatch(/stopped unexpectedly/);
    expect(playlistRow(id)!.status).toBe("failed");
  });
});

describe("re-processing keeps derived content consistent", () => {
  // A pasted transcript must invalidate the old episode at once; otherwise a transient failure
  // of the next step left the clip picked from the old transcript in place.
  it("a pasted transcript replaces the old episode even when the next step is retried", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidSTALECNT");
    await drain(opts());
    const vid = videoRows(id)[0].id;
    const oldEp = episodeRows(id)[0];
    run("UPDATE videos SET status = 'failed', error = 'x' WHERE id = ?", vid); // a later re-process failed

    submitManualTranscript(user, vid, pastedTranscript("interleaving practice"));
    expect(episodeRows(id)).toHaveLength(0);

    const good = fixedAi(45, 255);
    let failed = false;
    const flaky: Providers["ai"] = {
      pickMoments: mockAi.pickMoments,
      async pickClip(i) {
        if (!failed) {
          failed = true;
          throw new JobRetryableError("Claude API is temporarily unavailable (HTTP 529); will retry.");
        }
        return good.pickClip(i);
      },
    };
    expect((await drain(opts({ ai: flaky }))).retried).toBe(1);
    expect(episodeRows(id)).toHaveLength(0);
    offset = 60_000;
    await drain(opts({ ai: flaky }));
    const eps = episodeRows(id);
    expect(eps).toHaveLength(1);
    expect(eps[0].id).not.toBe(oldEp.id);
    expect(episodeClip(vid)).toMatchObject({ start: 45, end: 255, picked: "ai" });
    expect(videoRows(id)[0].status).toBe("ready");
  });

  it("legacy podcast episodes are ignored by the read model", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidLEGACY01");
    await drain(opts());
    const vid = videoRows(id)[0].id;
    run("UPDATE episodes SET script_json = ? WHERE video_id = ?", JSON.stringify({ title: "t", summary: "s", turns: [], chapters: [] }), vid);
    run(
      `INSERT INTO episodes (id, playlist_id, video_id, kind, title, script_json, audio_path, duration_s, status, error, created_at)
       VALUES (?, ?, NULL, 'recap', 'Season recap', '{}', NULL, 100, 'voiced', NULL, ?)`,
      newId(),
      id,
      Date.now(),
    );
    const detail = getPlaylistDetail(user, id)!;
    expect(detail.episodes).toEqual([]);
    expect(detail.videos[0].episodeId).toBeNull();
  });
});

describe("failure recording is atomic", () => {
  // If the failure handler throws, the job must stay recoverable ('running') instead of being
  // recorded as failed while its playlist stays 'ingesting' forever.
  it("when the failure handler throws, the job stays recoverable", async () => {
    const user = seedUser();
    const { id } = createPlaylist(user, "https://youtu.be/vidATOMIC01");
    const yt = {
      fetchPlaylist: async () => {
        throw new Error("unused");
      },
      fetchVideo: async () => {
        throw new YouTubeError("not_found", "This video is not available.", { status: 404 });
      },
    };
    run(
      `CREATE TEMP TRIGGER fail_playlist_update BEFORE UPDATE OF status ON playlists
         WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`,
    );
    try {
      await drain(opts({ youtube: yt }));
    } finally {
      run("DROP TRIGGER IF EXISTS temp.fail_playlist_update");
    }
    expect(playlistRow(id)!.status).toBe("ingesting");
    const job = jobRows().find((j) => j.type === "ingest_playlist" && j.payload_json.includes(id))!;
    expect(job.status).toBe("running"); // not 'failed': the stale-lock sweep can still recover it

    offset = 11 * 60 * 1000;
    expect(recoverStale(silentLogger, clock())).toBe(1);
    await drain(opts());
    expect(playlistRow(id)!.status).toBe("ready");
  });
});

describe("helpers", () => {
  it("cleanSegments drops bad segments, fixes durations and sorts", () => {
    expect(
      cleanSegments([
        { start: 10, dur: 2, text: "b" },
        { start: 0, dur: -1, text: "a" },
        { start: -1, dur: 1, text: "neg" },
        { start: 5, dur: 1, text: "   " },
        { start: Number.NaN, dur: 1, text: "nan" },
        null,
        { start: 3, text: "no dur" },
      ]),
    ).toEqual([
      { start: 0, dur: 0, text: "a" },
      { start: 3, dur: 0, text: "no dur" },
      { start: 10, dur: 2, text: "b" },
    ]);
    expect(cleanSegments("nope")).toEqual([]);
  });

  it("parseStoredClip accepts clips only", () => {
    const clip: ClipPlan = { start: 1, end: 200, title: "t", summary: "s", reason: "", picked: "heuristic" };
    expect(parseStoredClip(JSON.stringify(clip))).toEqual(clip);
    expect(parseStoredClip(JSON.stringify({ ...clip, end: 1 }))).toBeNull();
    expect(parseStoredClip(JSON.stringify({ ...clip, picked: "other" }))).toBeNull();
    expect(parseStoredClip(JSON.stringify({ title: "t", turns: [] }))).toBeNull();
    expect(parseStoredClip("not json")).toBeNull();
    expect(parseStoredClip(null)).toBeNull();
  });

  it("staticProviders throws for a provider that was not supplied", async () => {
    await expect(staticProviders({})("ai")).rejects.toThrow(/not supplied/);
  });
});
