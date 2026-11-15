import { beforeEach, describe, expect, it } from "vitest";
import { get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import type { JobRow } from "@/lib/types";
import {
  STALE_LOCK_MS,
  backoffDelayMs,
  cancelQueuedJobs,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  getJob,
  hasActiveJob,
  purgeFinishedJobs,
  recoverOrphanedJobs,
  recoverStaleJobs,
  releaseJobs,
  scheduleRetry,
  touchJob,
} from "./queue";

const VID = "11111111-1111-4111-8111-111111111111";
const VID2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  run("DELETE FROM jobs");
});

describe("enqueue", () => {
  it("inserts a queued job with defaults and returns its id", () => {
    const before = Date.now();
    const id = enqueue("process_video", { videoId: VID });
    const job = getJob(id)!;
    expect(job.type).toBe("process_video");
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.max_attempts).toBe(3);
    expect(JSON.parse(job.payload_json)).toEqual({ videoId: VID });
    expect(job.run_after).toBeGreaterThanOrEqual(before);
    expect(job.locked_at).toBeNull();
  });

  it("honours runAfter and maxAttempts", () => {
    const id = enqueue("ingest_playlist", { playlistId: VID }, { runAfter: 123, maxAttempts: 5 });
    const job = getJob(id)!;
    expect(job.run_after).toBe(123);
    expect(job.max_attempts).toBe(5);
  });

  it("rejects invalid payloads and unknown types", () => {
    expect(() => enqueue("process_video", { videoId: "../etc" })).toThrow(/Invalid payload/);
    expect(() => enqueue("process_video", {} as never)).toThrow(/Invalid payload/);
    expect(() => enqueue("nope" as never, { videoId: VID } as never)).toThrow(/Unknown job type/);
  });

  it("strips unknown payload keys so payload_json is canonical", () => {
    const id = enqueue("process_video", { videoId: VID, extra: 1 } as never);
    expect(getJob(id)!.payload_json).toBe(JSON.stringify({ videoId: VID }));
  });

  it("unique: returns the existing active job instead of inserting", () => {
    const a = enqueue("process_video", { videoId: VID }, { unique: true });
    const b = enqueue("process_video", { videoId: VID }, { unique: true });
    expect(b).toBe(a);
    // same payload, different type is a different job
    const c = enqueue("ingest_playlist", { playlistId: VID }, { unique: true });
    expect(c).not.toBe(a);
    // once done, a new one can be queued
    completeJob(a);
    const e = enqueue("process_video", { videoId: VID }, { unique: true });
    expect(e).not.toBe(a);
    expect(hasActiveJob("process_video", { videoId: VID })).toBe(true);
    expect(hasActiveJob("process_video", { videoId: VID2 })).toBe(false);
  });
});

describe("claimNextJob", () => {
  it("claims the oldest runnable job, marks it running and increments attempts", () => {
    const t = Date.now();
    const later = enqueue("process_video", { videoId: VID }, { runAfter: t + 60_000 });
    const first = enqueue("process_video", { videoId: VID2 }, { runAfter: t - 10 });
    const job = claimNextJob(t)!;
    expect(job.id).toBe(first);
    expect(job.status).toBe("running");
    expect(job.attempts).toBe(1);
    expect(job.locked_at).toBe(t);
    // the future job is not runnable yet, and the running one is not claimable again
    expect(claimNextJob(t)).toBeNull();
    expect(claimNextJob(t + 60_000)!.id).toBe(later);
  });

  it("orders by run_after then created_at", () => {
    const t = Date.now();
    const b = enqueue("process_video", { videoId: VID }, { runAfter: t - 5 });
    const a = enqueue("process_video", { videoId: VID2 }, { runAfter: t - 50 });
    expect(claimNextJob(t)!.id).toBe(a);
    expect(claimNextJob(t)!.id).toBe(b);
  });

  // Before the fix claims were global FIFO, so one account's backlog held every worker slot.
  it("shares workers fairly between users: the owner with fewest running jobs goes first", () => {
    const owner = () => {
      const userId = newId();
      run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)", userId, `${userId}@example.com`, 1);
      return userId;
    };
    const playlist = (userId: string) => {
      const id = newId();
      run(
        "INSERT INTO playlists (id, user_id, source_url, kind, created_at, updated_at) VALUES (?, ?, 'u', 'playlist', 1, 1)",
        id,
        userId,
      );
      return id;
    };
    const t = Date.now();
    const a = owner();
    const b = owner();
    const aJobs = [0, 1, 2].map((i) => enqueue("ingest_playlist", { playlistId: playlist(a) }, { runAfter: t - 100 + i }));
    const bJob = enqueue("ingest_playlist", { playlistId: playlist(b) }, { runAfter: t - 10 });
    expect(claimNextJob(t)!.id).toBe(aJobs[0]); // nobody is running: oldest first
    expect(claimNextJob(t)!.id).toBe(bJob); // A already has one running, B has none
    expect(claimNextJob(t)!.id).toBe(aJobs[1]);
    completeJob(aJobs[0]);
    expect(claimNextJob(t)!.id).toBe(aJobs[2]); // only A has work left: it still gets the slot
  });

  it("a malformed payload does not stop the queue", () => {
    const bad = enqueue("process_video", { videoId: VID });
    run("UPDATE jobs SET payload_json = 'not json' WHERE id = ?", bad);
    expect(claimNextJob()!.id).toBe(bad);
  });

  it("never double-claims a job (conditional update)", () => {
    enqueue("process_video", { videoId: VID });
    const claimed = [claimNextJob(), claimNextJob(), claimNextJob()].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });
});

describe("retry / fail / complete", () => {
  it("scheduleRetry puts a running job back with a delay and keeps attempts", () => {
    const id = enqueue("process_video", { videoId: VID });
    const t = Date.now();
    claimNextJob(t);
    scheduleRetry(id, 30_000, "boom", t);
    const job = getJob(id)!;
    expect(job.status).toBe("queued");
    expect(job.run_after).toBe(t + 30_000);
    expect(job.last_error).toBe("boom");
    expect(job.attempts).toBe(1);
    expect(job.locked_at).toBeNull();
    expect(claimNextJob(t + 29_999)).toBeNull();
    expect(claimNextJob(t + 30_000)!.attempts).toBe(2);
  });

  it("failJob and completeJob set terminal states", () => {
    const a = enqueue("process_video", { videoId: VID });
    const b = enqueue("process_video", { videoId: VID2 });
    claimNextJob();
    claimNextJob();
    failJob(a, "nope");
    completeJob(b);
    expect(getJob(a)!.status).toBe("failed");
    expect(getJob(a)!.last_error).toBe("nope");
    expect(getJob(b)!.status).toBe("done");
    // a done job is not resurrected by a late retry
    scheduleRetry(b, 0, "late");
    expect(getJob(b)!.status).toBe("done");
  });

  it("touchJob refreshes the lock of running jobs only", () => {
    const id = enqueue("process_video", { videoId: VID });
    const other = enqueue("process_video", { videoId: VID2 }, { runAfter: Date.now() + 60_000 });
    expect(claimNextJob()!.id).toBe(id);
    const t = Date.now() + 5000;
    touchJob(id, t);
    touchJob(other, t);
    expect(getJob(id)!.locked_at).toBe(t);
    expect(getJob(other)!.locked_at).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  const mid = () => 0.5; // no jitter
  it("doubles per attempt from the base", () => {
    expect(backoffDelayMs(1, { baseMs: 1000, random: mid })).toBe(1000);
    expect(backoffDelayMs(2, { baseMs: 1000, random: mid })).toBe(2000);
    expect(backoffDelayMs(3, { baseMs: 1000, random: mid })).toBe(4000);
  });
  it("applies +/-20% jitter", () => {
    expect(backoffDelayMs(1, { baseMs: 1000, random: () => 0 })).toBe(800);
    expect(backoffDelayMs(1, { baseMs: 1000, random: () => 1 })).toBe(1200);
  });
  it("respects retry-after hints and the cap", () => {
    expect(backoffDelayMs(1, { baseMs: 1000, random: mid, retryAfterMs: 9000 })).toBe(9000);
    expect(backoffDelayMs(30, { baseMs: 1000, maxMs: 60_000, random: mid })).toBe(60_000);
    expect(backoffDelayMs(1, { baseMs: 1000, maxMs: 5000, retryAfterMs: 999_999, random: mid })).toBe(5000);
  });
  it("defaults to a 30s base", () => {
    expect(backoffDelayMs(1, { random: mid })).toBe(30_000);
  });
});

describe("recoverStaleJobs", () => {
  function lockAt(id: string, lockedAt: number, attempts: number) {
    run("UPDATE jobs SET status = 'running', locked_at = ?, attempts = ? WHERE id = ?", lockedAt, attempts, id);
  }

  it("re-queues running jobs whose lock is older than 10 minutes", () => {
    const t = Date.now();
    const stale = enqueue("process_video", { videoId: VID });
    const fresh = enqueue("process_video", { videoId: VID2 });
    lockAt(stale, t - STALE_LOCK_MS - 1, 1);
    lockAt(fresh, t - STALE_LOCK_MS + 1000, 1);
    const r = recoverStaleJobs(t);
    expect(r.requeued).toBe(1);
    expect(r.exhausted).toEqual([]);
    const s = getJob(stale)!;
    expect(s.status).toBe("queued");
    expect(s.locked_at).toBeNull();
    expect(s.run_after).toBe(t);
    expect(s.last_error).toMatch(/stale/i);
    expect(getJob(fresh)!.status).toBe("running");
  });

  it("leaves jobs the caller is still running alone and refreshes their lock", () => {
    const t = Date.now();
    const live = enqueue("process_video", { videoId: VID });
    const dead = enqueue("process_video", { videoId: VID2 });
    lockAt(live, t - STALE_LOCK_MS - 1, 3);
    lockAt(dead, t - STALE_LOCK_MS - 1, 1);
    const r = recoverStaleJobs(t, STALE_LOCK_MS, new Set([live]));
    expect(r).toEqual({ requeued: 1, exhausted: [] });
    expect(getJob(live)).toMatchObject({ status: "running", locked_at: t });
    expect(getJob(dead)!.status).toBe("queued");
  });

  it("fails stale jobs that have no attempts left and returns them", () => {
    const t = Date.now();
    const id = enqueue("process_video", { videoId: VID });
    lockAt(id, t - STALE_LOCK_MS - 1, 3);
    const r = recoverStaleJobs(t);
    expect(r.requeued).toBe(0);
    expect(r.exhausted.map((j: JobRow) => j.id)).toEqual([id]);
    expect(getJob(id)!.status).toBe("failed");
  });
});

describe("releaseJobs (graceful shutdown)", () => {
  const VID3 = "33333333-3333-4333-8333-333333333333";

  it("re-queues the given running jobs at once without counting the interrupted attempt", () => {
    const a = enqueue("process_video", { videoId: VID });
    const b = enqueue("process_video", { videoId: VID2 });
    const c = enqueue("process_video", { videoId: VID3 });
    claimNextJob(); // a: running, attempts 1
    claimNextJob(); // b: running, attempts 1
    run("UPDATE jobs SET attempts = 3 WHERE id = ?", b); // b on its last attempt
    const t = Date.now() + 5000;
    expect(releaseJobs([a, b, c, a], t)).toBe(2); // duplicates and non-running ids are ignored
    expect(getJob(a)).toMatchObject({ status: "queued", attempts: 0, locked_at: null, run_after: t, updated_at: t });
    expect(getJob(a)!.last_error).toMatch(/shutdown/i);
    // A job on its last attempt gets that attempt back instead of being failed.
    expect(getJob(b)).toMatchObject({ status: "queued", attempts: 2 });
    expect(getJob(c)).toMatchObject({ status: "queued", attempts: 0, last_error: null });
    // Runnable at once by the next claim.
    expect(claimNextJob(t)?.status).toBe("running");
  });

  it("does not touch running jobs it was not given, nor finished ones", () => {
    const mine = enqueue("process_video", { videoId: VID });
    const other = enqueue("process_video", { videoId: VID2 });
    claimNextJob();
    claimNextJob();
    completeJob(mine);
    expect(releaseJobs([mine])).toBe(0);
    expect(getJob(mine)!.status).toBe("done");
    expect(getJob(other)!.status).toBe("running");
    expect(releaseJobs([])).toBe(0);
  });

  it("lets a released job that still finishes record its real outcome", () => {
    const a = enqueue("process_video", { videoId: VID });
    const b = enqueue("process_video", { videoId: VID2 });
    claimNextJob();
    claimNextJob();
    releaseJobs([a, b]);
    completeJob(a);
    failJob(b, "boom");
    expect(getJob(a)).toMatchObject({ status: "done", last_error: null });
    expect(getJob(b)).toMatchObject({ status: "failed", last_error: "boom" });
  });
});

describe("recoverOrphanedJobs (startup)", () => {
  it("re-queues every running job whatever its lock age, counting the attempt", () => {
    const t = Date.now();
    const fresh = enqueue("process_video", { videoId: VID });
    const queued = enqueue("ingest_playlist", { playlistId: VID });
    run("UPDATE jobs SET status = 'running', locked_at = ?, attempts = 1 WHERE id = ?", t - 1000, fresh);
    const r = recoverOrphanedJobs(t);
    expect(r).toEqual({ requeued: 1, exhausted: [] });
    expect(getJob(fresh)).toMatchObject({ status: "queued", attempts: 1, locked_at: null, run_after: t });
    expect(getJob(fresh)!.last_error).toMatch(/startup/i);
    expect(getJob(queued)).toMatchObject({ status: "queued", last_error: null });
  });

  it("fails orphans with no attempts left and returns them for their failure handlers", () => {
    const t = Date.now();
    const id = enqueue("process_video", { videoId: VID });
    run("UPDATE jobs SET status = 'running', locked_at = ?, attempts = 3 WHERE id = ?", t, id);
    const r = recoverOrphanedJobs(t);
    expect(r.requeued).toBe(0);
    expect(r.exhausted.map((j: JobRow) => j.id)).toEqual([id]);
    expect(getJob(id)!.status).toBe("failed");
  });
});

describe("cancelQueuedJobs / purgeFinishedJobs", () => {
  it("cancels only queued jobs with matching type and payload", () => {
    const a = enqueue("process_video", { videoId: VID });
    const b = enqueue("process_video", { videoId: VID2 });
    const c = enqueue("ingest_playlist", { playlistId: VID });
    claimNextJob(); // a is running now
    const removed = cancelQueuedJobs([
      { type: "process_video", payload: { videoId: VID } },
      { type: "process_video", payload: { videoId: VID2 } },
    ]);
    expect(removed).toBe(1);
    expect(getJob(a)).toBeDefined();
    expect(getJob(b)).toBeUndefined();
    expect(getJob(c)).toBeDefined();
  });

  it("purges finished jobs older than the cutoff", () => {
    const a = enqueue("process_video", { videoId: VID });
    const b = enqueue("process_video", { videoId: VID2 });
    run("UPDATE jobs SET status = 'done', updated_at = 100 WHERE id = ?", a);
    run("UPDATE jobs SET status = 'failed', updated_at = 100 WHERE id = ?", b);
    enqueue("ingest_playlist", { playlistId: VID });
    expect(purgeFinishedJobs(200)).toBe(2);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")!.n).toBe(1);
  });
});
