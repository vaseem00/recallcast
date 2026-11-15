import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-worker-"));
process.env.STORAGE_DIR = dir;

import { get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { newId } from "@/lib/ids";
import type { PlaylistMeta } from "@/lib/types";
import { createPlaylist } from "./commands";
import { claimNextJob, enqueue, getJob } from "./queue";
import {
  JobWorker,
  installShutdownHandlers,
  processJob,
  shutdownJobWorker,
  silentLogger,
  startWorker,
  stopWorker,
  workerStatus,
} from "./worker";
import { mkVideo, mockProviders, playlistRow, seedUser } from "./test-helpers";

resetEnvCache();
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function activeJobs(): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')")!.n);
}

describe("processJob", () => {
  it("fails unknown job types and invalid payloads without throwing", async () => {
    const t = Date.now();
    const a = newId();
    run(
      `INSERT INTO jobs (id, type, payload_json, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, 'mystery', '{}', 'queued', 0, 3, ?, ?, ?)`,
      a,
      t,
      t,
      t,
    );
    const job = claimNextJob()!;
    expect(await processJob(job, { logger: silentLogger, resolve: mockProviders() })).toBe("failed");
    expect(getJob(a)!.status).toBe("failed");
    expect(getJob(a)!.last_error).toMatch(/Unknown job type/);

    const b = enqueue("process_video", { videoId: newId() });
    run("UPDATE jobs SET payload_json = 'not json' WHERE id = ?", b);
    const jb = claimNextJob()!;
    expect(await processJob(jb, { logger: silentLogger, resolve: mockProviders() })).toBe("failed");
    expect(getJob(b)!.last_error).toMatch(/Invalid payload/);
  });

  it("treats a job whose row was deleted as done (no-op)", async () => {
    const id = enqueue("process_video", { videoId: newId() });
    const job = claimNextJob()!;
    expect(await processJob(job, { logger: silentLogger, resolve: mockProviders() })).toBe("done");
    expect(getJob(id)!.status).toBe("done");
  });

  it("survives a resolver that throws", async () => {
    const id = enqueue("ingest_playlist", { playlistId: newId() });
    const job = claimNextJob()!;
    const resolve = (async () => {
      throw new Error("resolver exploded");
    }) as never;
    expect(await processJob(job, { logger: silentLogger, resolve })).toBe("failed");
    expect(getJob(id)!.status).toBe("failed");
  });
});

describe("JobWorker loop", () => {
  it("runs jobs with bounded concurrency until the queue is empty", async () => {
    run("DELETE FROM jobs");
    const user = seedUser();
    const ids = [
      createPlaylist(user, "https://youtu.be/vidCONC0001").id,
      createPlaylist(user, "https://youtu.be/vidCONC0002").id,
      createPlaylist(user, "https://youtu.be/vidCONC0003").id,
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const youtube = {
      async fetchPlaylist(): Promise<PlaylistMeta> {
        throw new Error("unused");
      },
      async fetchVideo(id: string): Promise<PlaylistMeta> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight--;
        const v = mkVideo(id, 0);
        return { youtubePlaylistId: null, kind: "video", title: v.title, channel: v.channel, thumbnail: v.thumbnail, videos: [v] };
      },
    };
    const worker = new JobWorker({ concurrency: 2, pollMs: 20, logger: silentLogger, resolve: mockProviders({ youtube }) });
    worker.start();
    worker.start(); // idempotent
    await vi.waitFor(() => expect(activeJobs()).toBe(0), { timeout: 10_000, interval: 25 });
    await worker.stop();
    expect(maxInFlight).toBe(2);
    for (const id of ids) expect(playlistRow(id)!.status).toBe("ready");
  });

  // Before the fix maintenance judged locks by age only, so after a host suspend (wall clock
  // jumps > 10 min before the next heartbeat) the worker re-queued its own running job.
  it("does not treat its own in-flight job as stale after a clock jump", async () => {
    run("DELETE FROM jobs");
    const user = seedUser();
    createPlaylist(user, "https://youtu.be/vidSUSPEND1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const youtube = {
      async fetchPlaylist(): Promise<PlaylistMeta> {
        throw new Error("unused");
      },
      async fetchVideo(id: string): Promise<PlaylistMeta> {
        calls++;
        await gate;
        const v = mkVideo(id, 0);
        return { youtubePlaylistId: null, kind: "video", title: v.title, channel: v.channel, thumbnail: v.thumbnail, videos: [v] };
      },
    };
    let offset = 0;
    const worker = new JobWorker({
      concurrency: 2,
      pollMs: 60_000,
      logger: silentLogger,
      now: () => Date.now() + offset,
      resolve: mockProviders({ youtube }),
    });
    worker.start();
    await vi.waitFor(() => expect(worker.active).toBe(1), { timeout: 2000, interval: 5 });
    const ingest = get<{ id: string }>("SELECT id FROM jobs WHERE type = 'ingest_playlist' AND status = 'running'")!;

    offset = 11 * 60 * 1000; // the host slept; the heartbeat has not run yet
    worker.tick();
    expect(getJob(ingest.id)!.status).toBe("running");
    expect(getJob(ingest.id)!.attempts).toBe(1);
    expect(calls).toBe(1); // not claimed a second time by the free slot

    release();
    await worker.stop();
    expect(getJob(ingest.id)!.status).toBe("done");
  });

  it("stop() waits for in-flight jobs", async () => {
    run("DELETE FROM jobs");
    const user = seedUser();
    createPlaylist(user, "https://youtu.be/vidSTOP0001");
    let finished = false;
    const youtube = {
      async fetchPlaylist(): Promise<PlaylistMeta> {
        throw new Error("unused");
      },
      async fetchVideo(id: string): Promise<PlaylistMeta> {
        await new Promise((r) => setTimeout(r, 60));
        finished = true;
        const v = mkVideo(id, 0);
        return { youtubePlaylistId: null, kind: "video", title: v.title, channel: v.channel, thumbnail: v.thumbnail, videos: [v] };
      },
    };
    const worker = new JobWorker({ concurrency: 1, pollMs: 10, logger: silentLogger, resolve: mockProviders({ youtube }) });
    worker.start();
    await vi.waitFor(() => expect(worker.active).toBe(1), { timeout: 2000, interval: 5 });
    await worker.stop();
    expect(finished).toBe(true);
    expect(worker.active).toBe(0);
  });
});

describe("graceful shutdown", () => {
  /** A worker whose one ingest job blocks until release() is called. */
  async function gatedWorker() {
    run("DELETE FROM jobs");
    createPlaylist(seedUser(), "https://youtu.be/vidSHUTDWN1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const youtube = {
      async fetchPlaylist(): Promise<PlaylistMeta> {
        throw new Error("unused");
      },
      async fetchVideo(id: string): Promise<PlaylistMeta> {
        await gate;
        const v = mkVideo(id, 0);
        return { youtubePlaylistId: null, kind: "video", title: v.title, channel: v.channel, thumbnail: v.thumbnail, videos: [v] };
      },
    };
    const worker = new JobWorker({ concurrency: 2, pollMs: 10, logger: silentLogger, resolve: mockProviders({ youtube }) });
    worker.start();
    await vi.waitFor(() => expect(worker.active).toBe(1), { timeout: 2000, interval: 5 });
    const job = get<{ id: string }>("SELECT id FROM jobs WHERE type = 'ingest_playlist' AND status = 'running'")!;
    return { worker, release, jobId: job.id };
  }

  it("releases running jobs synchronously, stops claiming, then lets them finish within the grace", async () => {
    const { worker, release, jobId } = await gatedWorker();
    const p = shutdownJobWorker(worker, 5000, silentLogger);
    // Before any await: the lock is already released and the attempt given back.
    expect(getJob(jobId)).toMatchObject({ status: "queued", attempts: 0, locked_at: null });
    expect(worker.isRunning).toBe(false);
    release();
    expect(await p).toEqual({ released: 1, drained: true });
    // The job finished during the grace period and recorded its real outcome...
    expect(getJob(jobId)!.status).toBe("done");
    // ...and the stopped worker claimed none of the process_video jobs it enqueued.
    await new Promise((r) => setTimeout(r, 50));
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'")!.n).toBe(0);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'process_video' AND status = 'queued'")!.n).toBe(1);
  });

  it("gives up after the grace period and leaves the job queued for the next start", async () => {
    const { worker, release, jobId } = await gatedWorker();
    const started = Date.now();
    expect(await shutdownJobWorker(worker, 30, silentLogger)).toEqual({ released: 1, drained: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(getJob(jobId)).toMatchObject({ status: "queued", attempts: 0 });
    release();
    await worker.stop();
  });

  it("returns at once when nothing is running", async () => {
    const worker = new JobWorker({ pollMs: 60_000, logger: silentLogger });
    expect(await shutdownJobWorker(worker, 60_000, silentLogger)).toEqual({ released: 0, drained: true });
  });

  it("SIGTERM handler releases the global worker's jobs before the first await", async () => {
    const { worker, release, jobId } = await gatedWorker();
    const g = globalThis as Record<string, unknown>;
    g.__recallcastWorker = worker;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const before = new Set(process.listeners("SIGTERM"));
    try {
      installShutdownHandlers();
      installShutdownHandlers(); // idempotent
      const added = process.listeners("SIGTERM").filter((l) => !before.has(l));
      expect(added).toHaveLength(1);
      expect(workerStatus()).toEqual({ running: true, active: 1 });
      // Call our listener directly (process.emit would also run vitest's own handlers).
      (added[0] as (s: NodeJS.Signals) => void)("SIGTERM");
      expect(getJob(jobId)).toMatchObject({ status: "queued", attempts: 0 });
      expect(g.__recallcastWorker).toBeUndefined();
      expect(workerStatus()).toEqual({ running: false, active: 0 });
      release();
      await worker.stop();
      await new Promise((r) => setTimeout(r, 20)); // let the handler log "running jobs finished"
      for (const l of added) process.off("SIGTERM", l);
      for (const l of process.listeners("SIGINT").filter((l) => (l as { name?: string }).name === "onSignal")) process.off("SIGINT", l);
    } finally {
      info.mockRestore();
    }
  });
});

describe("startWorker", () => {
  const key = "__recallcastWorker";
  const g = globalThis as Record<string, unknown>;

  it("does nothing when WORKER_ENABLED=0", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    startWorker();
    expect(g[key]).toBeUndefined();
    info.mockRestore();
  });

  it("starts once (globalThis guard) and stops", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.WORKER_ENABLED = "1";
    resetEnvCache();
    try {
      startWorker();
      const first = g[key];
      expect(first).toBeInstanceOf(JobWorker);
      startWorker();
      expect(g[key]).toBe(first);
    } finally {
      await stopWorker();
      process.env.WORKER_ENABLED = "0";
      resetEnvCache();
      info.mockRestore();
    }
    expect(g[key]).toBeUndefined();
  });

  it("re-queues jobs a previous process left running before it claims anything", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    run("DELETE FROM jobs");
    const orphan = enqueue("ingest_playlist", { playlistId: newId() }, { runAfter: Date.now() + 3_600_000 });
    run("UPDATE jobs SET status = 'running', locked_at = ?, attempts = 1 WHERE id = ?", Date.now(), orphan);
    process.env.WORKER_ENABLED = "1";
    process.env.WORKER_POLL_MS = "60000";
    resetEnvCache();
    try {
      startWorker();
      // Requeued (attempt counted) and, run_after = now, claimed by the first tick.
      await vi.waitFor(() => expect(getJob(orphan)!.status).not.toBe("running"), { timeout: 2000, interval: 5 });
      expect(getJob(orphan)!.attempts).toBeGreaterThanOrEqual(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recovered 1 orphaned job/));
    } finally {
      await stopWorker();
      process.env.WORKER_ENABLED = "0";
      delete process.env.WORKER_POLL_MS;
      resetEnvCache();
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("never throws on a bad configuration", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MAX_VIDEO_SECONDS = "not-a-number";
    resetEnvCache();
    try {
      expect(() => startWorker()).not.toThrow();
      expect(err).toHaveBeenCalled();
    } finally {
      delete process.env.MAX_VIDEO_SECONDS;
      resetEnvCache();
      err.mockRestore();
    }
  });
});
