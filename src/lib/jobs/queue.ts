import "server-only";
import { z } from "zod";
import { all, get, now as dbNow, run, transaction } from "@/lib/db";
import { newId } from "@/lib/ids";
import type { JobPayloads, JobRow, JobType } from "@/lib/types";

/**
 * DB-backed job queue (table `jobs`).
 *
 * Life cycle: queued -> running -> done | failed, or running -> queued again (retry with
 * backoff, or stale-lock recovery). `attempts` is incremented when a job is claimed, so a
 * claimed row's `attempts` is the number of the run in progress.
 *
 * Payloads are serialized with JSON.stringify of a validated object whose keys are always in the
 * same order, so (type, payload_json) identifies a logical job; enqueue({ unique: true }) uses
 * that to avoid queueing the same work twice.
 */

export const DEFAULT_MAX_ATTEMPTS = 3;
/** A running job whose lock is older than this is considered abandoned (crashed worker). */
export const STALE_LOCK_MS = 10 * 60 * 1000;
/** First retry delay; doubles per attempt. */
export const BACKOFF_BASE_MS = 30_000;
/** Upper bound for any retry delay (including server retry-after hints). */
export const BACKOFF_MAX_MS = 15 * 60 * 1000;

const id = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export const PAYLOAD_SCHEMAS: { [K in JobType]: z.ZodType<JobPayloads[K]> } = {
  ingest_playlist: z.object({ playlistId: id }),
  process_video: z.object({ videoId: id }),
  pick_moments: z.object({ videoId: id }),
};
// Rows of the removed job types (voice_episode, make_recap) fail as "Unknown job type" if any
// are still queued from before the switch to clips.

export const JOB_TYPES = Object.keys(PAYLOAD_SCHEMAS) as JobType[];

export function isJobType(t: unknown): t is JobType {
  return typeof t === "string" && (JOB_TYPES as string[]).includes(t);
}

export interface EnqueueOptions {
  /** Earliest run time in ms (default: now). */
  runAfter?: number;
  /** Default 3. */
  maxAttempts?: number;
  /**
   * When true and a queued or running job with the same type and payload already exists,
   * no new row is inserted and the existing job's id is returned.
   */
  unique?: boolean;
}

/** Canonical JSON for a payload (validated; key order fixed by the schema). */
export function payloadJson<T extends JobType>(type: T, payload: JobPayloads[T]): string {
  const parsed = PAYLOAD_SCHEMAS[type].safeParse(payload);
  if (!parsed.success) throw new Error(`Invalid payload for job ${type}`);
  return JSON.stringify(parsed.data);
}

/** Parses a stored payload; throws on mismatch. */
export function parsePayload<T extends JobType>(type: T, json: string): JobPayloads[T] {
  return PAYLOAD_SCHEMAS[type].parse(JSON.parse(json));
}

/** Inserts a queued job row and returns its id. Synchronous; safe inside transaction(). */
export function enqueue<T extends JobType>(type: T, payload: JobPayloads[T], opts?: EnqueueOptions): string {
  if (!isJobType(type)) throw new Error(`Unknown job type: ${String(type)}`);
  const json = payloadJson(type, payload);
  const at = dbNow();
  const maxAttempts = Math.max(1, Math.floor(opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const runAfter = Math.floor(opts?.runAfter ?? at);
  return transaction(() => {
    if (opts?.unique) {
      const existing = findActiveJob(type, json);
      if (existing) return existing.id;
    }
    const jobId = newId();
    run(
      `INSERT INTO jobs (id, type, payload_json, status, attempts, max_attempts, run_after, locked_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, ?)`,
      jobId,
      type,
      json,
      maxAttempts,
      runAfter,
      at,
      at,
    );
    return jobId;
  });
}

function findActiveJob(type: JobType, json: string): JobRow | undefined {
  return get<JobRow>(
    `SELECT * FROM jobs WHERE type = ? AND payload_json = ? AND status IN ('queued','running')
     ORDER BY created_at LIMIT 1`,
    type,
    json,
  );
}

/** True when a queued or running job with this type and payload exists. */
export function hasActiveJob<T extends JobType>(type: T, payload: JobPayloads[T]): boolean {
  return findActiveJob(type, payloadJson(type, payload)) !== undefined;
}

export function getJob(jobId: string): JobRow | undefined {
  return get<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId);
}

/**
 * Owner (user id) of every active job, derived from its payload: playlistId, videoId -> video's
 * playlist, or episodeId -> episode's playlist. Orphans (deleted rows) and malformed payloads
 * get '' (json_extract throws on invalid JSON, so the payload is checked with json_valid first:
 * one bad row must not stop the whole queue).
 */
const ACTIVE_JOBS_WITH_OWNER = `
  SELECT j.id, j.status, j.run_after, j.created_at,
         COALESCE(p1.user_id, p2.user_id, p3.user_id, '') AS owner
    FROM (SELECT id, status, run_after, created_at,
                 CASE WHEN json_valid(payload_json) THEN payload_json END AS pj
            FROM jobs
           WHERE status = 'running' OR (status = 'queued' AND run_after <= ?)) j
    LEFT JOIN playlists p1 ON p1.id = json_extract(j.pj, '$.playlistId')
    LEFT JOIN videos v ON v.id = json_extract(j.pj, '$.videoId')
    LEFT JOIN playlists p2 ON p2.id = v.playlist_id
    LEFT JOIN episodes e ON e.id = json_extract(j.pj, '$.episodeId')
    LEFT JOIN playlists p3 ON p3.id = e.playlist_id`;

/**
 * Claims the next runnable job (status='queued' AND run_after <= now), shared fairly between
 * users: the job's owner with the fewest running jobs goes first, then oldest first. One account
 * with 5 x 25 long videos therefore cannot hold every worker slot while other users wait; when
 * only one user has work, it still gets every slot.
 * The claim is a conditional UPDATE (… WHERE id = ? AND status = 'queued') inside an
 * IMMEDIATE transaction, so two workers (even in two processes) can never claim the same row.
 * Returns the claimed row (status 'running', attempts already incremented) or null.
 */
export function claimNextJob(at: number = dbNow()): JobRow | null {
  return transaction(() => {
    const candidate = get<{ id: string }>(
      `WITH active AS (${ACTIVE_JOBS_WITH_OWNER}),
            busy AS (SELECT owner, COUNT(*) AS n FROM active WHERE status = 'running' GROUP BY owner)
       SELECT a.id FROM active a LEFT JOIN busy b ON b.owner = a.owner
        WHERE a.status = 'queued'
        ORDER BY COALESCE(b.n, 0), a.run_after, a.created_at
        LIMIT 1`,
      at,
    );
    if (!candidate) return null;
    const claimed = run(
      `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      at,
      at,
      candidate.id,
    );
    if (claimed.changes !== 1) return null;
    return get<JobRow>("SELECT * FROM jobs WHERE id = ?", candidate.id) ?? null;
  });
}

/** Marks a job done. Also accepts a job that stale recovery re-queued meanwhile (its work is finished). */
export function completeJob(jobId: string, at: number = dbNow()): void {
  run(
    `UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = ?
     WHERE id = ? AND status IN ('running','queued')`,
    at,
    jobId,
  );
}

/** Puts a running job back in the queue to run after `delayMs`. */
export function scheduleRetry(jobId: string, delayMs: number, lastError: string, at: number = dbNow()): void {
  run(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, run_after = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'running'`,
    at + Math.max(0, Math.floor(delayMs)),
    lastError,
    at,
    jobId,
  );
}

/** Marks a job permanently failed. */
export function failJob(jobId: string, lastError: string, at: number = dbNow()): void {
  run(
    `UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = ?, updated_at = ?
     WHERE id = ? AND status IN ('running','queued')`,
    lastError,
    at,
    jobId,
  );
}

/** Heartbeat: refreshes the lock of a running job so long steps are not mistaken for stale ones. */
export function touchJob(jobId: string, at: number = dbNow()): void {
  run("UPDATE jobs SET locked_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", at, at, jobId);
}

/**
 * Exponential backoff: base * 2^(attempt-1), +/-20% jitter, at least the server's retry-after
 * hint, capped at maxMs.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; retryAfterMs?: number | null; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? BACKOFF_BASE_MS;
  const max = opts.maxMs ?? BACKOFF_MAX_MS;
  const random = opts.random ?? Math.random;
  const n = Math.max(1, Math.floor(attempt));
  const exp = base * 2 ** Math.min(n - 1, 20);
  const jittered = exp * (0.8 + 0.4 * random());
  const withHint = Math.max(jittered, opts.retryAfterMs ?? 0);
  return Math.round(Math.min(max, withHint));
}

export interface StaleRecovery {
  /** Jobs put back in the queue. */
  requeued: number;
  /** Jobs that were stale and had no attempts left; now status 'failed'. The caller runs their failure handlers. */
  exhausted: JobRow[];
}

/**
 * Recovers jobs whose worker died: status='running' with locked_at older than staleMs.
 * Jobs with attempts left go back to 'queued' (runnable now); the rest are marked failed.
 * `inFlight` lists jobs the calling worker is still running: they are alive whatever their lock
 * age says (after a host suspend the wall clock jumps past the lock before the next heartbeat),
 * so their lock is refreshed instead of the job being run twice or failed mid-run.
 */
export function recoverStaleJobs(
  at: number = dbNow(),
  staleMs: number = STALE_LOCK_MS,
  inFlight: ReadonlySet<string> = new Set(),
): StaleRecovery {
  return transaction(() => {
    const cutoff = at - staleMs;
    const stale = all<JobRow>(
      "SELECT * FROM jobs WHERE status = 'running' AND (locked_at IS NULL OR locked_at < ?)",
      cutoff,
    );
    return requeueOrFail(stale, at, inFlight, {
      requeued: "Recovered stale lock (worker stopped while running)",
      exhausted: "Stale lock and no attempts left (worker stopped while running)",
    });
  });
}

/**
 * Startup recovery: every job still 'running' belongs to a previous server process that did not
 * shut down cleanly (crash, OOM, SIGKILL), because a clean shutdown releases its jobs with
 * releaseJobs(). SINGLE-SERVER ASSUMPTION: only one process runs the worker against this
 * database, so nothing else can own these locks. Call it before the worker claims anything.
 * The interrupted attempt IS counted (a job that crashes the process must not loop forever):
 * jobs with attempts left are re-queued, runnable now; the rest are marked failed and returned
 * so the caller runs their failure handlers.
 */
export function recoverOrphanedJobs(at: number = dbNow()): StaleRecovery {
  return transaction(() => {
    const orphans = all<JobRow>("SELECT * FROM jobs WHERE status = 'running'");
    return requeueOrFail(orphans, at, new Set(), {
      requeued: "Recovered at startup (server stopped while running)",
      exhausted: "Server stopped while running and no attempts left",
    });
  });
}

function requeueOrFail(
  jobs: JobRow[],
  at: number,
  inFlight: ReadonlySet<string>,
  messages: { requeued: string; exhausted: string },
): StaleRecovery {
  let requeued = 0;
  const exhausted: JobRow[] = [];
  for (const job of jobs) {
    if (inFlight.has(job.id)) {
      touchJob(job.id, at);
      continue;
    }
    if (job.attempts < job.max_attempts) {
      run(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, run_after = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
        at,
        messages.requeued,
        at,
        job.id,
      );
      requeued++;
    } else {
      run(
        `UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
        messages.exhausted,
        at,
        job.id,
      );
      exhausted.push({ ...job, status: "failed", locked_at: null, last_error: messages.exhausted, updated_at: at });
    }
  }
  return { requeued, exhausted };
}

/**
 * Graceful-shutdown release: puts jobs this process is running back in the queue, runnable at
 * once, with the interrupted attempt not counted (attempts - 1), so the next server start picks
 * them up immediately instead of waiting STALE_LOCK_MS for stale-lock recovery. Only rows still
 * 'running' change. Synchronous (one transaction), so it is safe to call from a signal handler
 * right before the process exits. If a released job still finishes in this process,
 * completeJob()/failJob() accept the 'queued' row and record the real outcome.
 * Returns the number of jobs released.
 */
export function releaseJobs(jobIds: Iterable<string>, at: number = dbNow()): number {
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) return 0;
  return transaction(() => {
    let released = 0;
    for (const jobId of ids) {
      released += run(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, run_after = ?, attempts = MAX(attempts - 1, 0),
                last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
        at,
        "Released at server shutdown (interrupted attempt not counted)",
        at,
        jobId,
      ).changes;
    }
    return released;
  });
}

/** Deletes queued jobs matching any of the given (type, payload) pairs. Returns the number removed. */
export function cancelQueuedJobs(items: { type: JobType; payload: JobPayloads[JobType] }[]): number {
  let removed = 0;
  transaction(() => {
    for (const item of items) {
      const json = payloadJson(item.type, item.payload as never);
      removed += run("DELETE FROM jobs WHERE type = ? AND payload_json = ? AND status = 'queued'", item.type, json).changes;
    }
  });
  return removed;
}

/** Removes finished (done/failed) jobs last updated before `olderThan`. */
export function purgeFinishedJobs(olderThan: number): number {
  return run("DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at < ?", olderThan).changes;
}
