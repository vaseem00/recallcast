import "server-only";
import { now as dbNow, transaction } from "@/lib/db";
import { getEnv } from "@/lib/env";
import type { JobPayloads, JobRow, JobType } from "@/lib/types";
import { internalMessage, isRetryable, publicMessage, retryAfterOf } from "./errors";
import { HANDLERS, type JobHandler } from "./handlers";
import { settlePlaylist } from "./pipeline";
import { defaultProviderResolver, type ProviderResolver } from "./providers";
import {
  backoffDelayMs,
  claimNextJob,
  completeJob,
  failJob,
  isJobType,
  parsePayload,
  purgeFinishedJobs,
  recoverOrphanedJobs,
  recoverStaleJobs,
  releaseJobs,
  scheduleRetry,
  touchJob,
  type StaleRecovery,
} from "./queue";
import { purgeExpiredSessions } from "@/lib/auth/session";
import { purgeRateLimitHits } from "@/lib/auth/rate-limit";

/**
 * DB-backed job worker.
 *
 * - Polls every WORKER_POLL_MS (default 1000) while idle; when a job
 *   finishes it checks for the next one at once.
 * - Runs up to WORKER_CONCURRENCY jobs at a time (default 2, max 8).
 * - Never throws into the server: every tick, job and handler is wrapped in try/catch.
 * - Retryable errors (`retryable === true`) back off exponentially until max_attempts; other
 *   errors fail the job at once and the job type's failure handler stores a user-readable
 *   message on the video / episode / playlist so the rest of the playlist carries on.
 * - Heartbeats running jobs every minute; every minute it also recovers stale locks
 *   (> 10 min, crashed worker), purges finished jobs older than 7 days and deletes expired
 *   sessions.
 * - On start, re-queues jobs a previous process left 'running' (single server per database).
 * - On SIGTERM/SIGINT (installShutdownHandlers), stops claiming, releases the locks of running
 *   jobs at once and gives them SHUTDOWN_GRACE_MS to finish.
 */

export interface JobLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export const consoleLogger: JobLogger = {
  info: (m) => console.info(`[jobs] ${m}`),
  warn: (m) => console.warn(`[jobs] ${m}`),
  error: (m, err) => (err === undefined ? console.error(`[jobs] ${m}`) : console.error(`[jobs] ${m}`, err)),
};

export const silentLogger: JobLogger = { info() {}, warn() {}, error() {} };

export type JobOutcome = "done" | "retry" | "failed";

export interface ProcessOptions {
  resolve?: ProviderResolver;
  logger?: JobLogger;
  now?: () => number;
  /** Backoff overrides (tests). */
  backoff?: { baseMs?: number; maxMs?: number; random?: () => number };
}

const shortId = (id: string) => id.slice(0, 8);

function safeSettle(playlistId: string | null, logger: JobLogger): void {
  if (!playlistId) return;
  try {
    settlePlaylist(playlistId);
  } catch (err) {
    logger.error(`settle ${shortId(playlistId)} failed`, err);
  }
}

/**
 * Runs one claimed job to completion: done, retry (back in the queue with a delay) or failed.
 * Never throws.
 */
export async function processJob(job: JobRow, opts: ProcessOptions = {}): Promise<JobOutcome> {
  const logger = opts.logger ?? consoleLogger;
  const resolve = opts.resolve ?? defaultProviderResolver;
  const clock = opts.now ?? dbNow;
  const started = Date.now();
  const label = `${job.type} ${shortId(job.id)}`;

  if (!isJobType(job.type)) {
    failJob(job.id, `Unknown job type: ${String(job.type)}`, clock());
    logger.error(`${label} failed: unknown job type`);
    return "failed";
  }
  const type: JobType = job.type;
  const handler = HANDLERS[type] as unknown as JobHandler<JobType>;

  let payload: JobPayloads[JobType];
  try {
    payload = parsePayload(type, job.payload_json);
  } catch (err) {
    failJob(job.id, `Invalid payload: ${internalMessage(err)}`, clock());
    logger.error(`${label} failed: invalid payload`);
    return "failed";
  }

  try {
    const playlistId = await handler.run(payload, resolve, { lastAttempt: job.attempts >= job.max_attempts });
    completeJob(job.id, clock());
    logger.info(`${label} done in ${Date.now() - started}ms (attempt ${job.attempts})`);
    safeSettle(playlistId, logger);
    return "done";
  } catch (err) {
    const internal = internalMessage(err);
    try {
      if (isRetryable(err) && job.attempts < job.max_attempts) {
        const delay = backoffDelayMs(job.attempts, { ...opts.backoff, retryAfterMs: retryAfterOf(err) });
        scheduleRetry(job.id, delay, internal, clock());
        logger.warn(`${label} attempt ${job.attempts}/${job.max_attempts} failed, retry in ${Math.round(delay / 1000)}s: ${internal}`);
        return "retry";
      }
      const exhausted = isRetryable(err);
      const userMsg = publicMessage(err, handler.fallback);
      // One transaction: the job is marked failed only together with the video/episode/playlist
      // it was working on. If the handler throws, both roll back and the job stays 'running', so
      // stale-lock recovery picks it up later instead of leaving the video "processing" forever.
      const playlistId = transaction(() => {
        failJob(job.id, internal, clock());
        return handler.onFailure(payload, userMsg);
      });
      if (exhausted) {
        logger.error(`${label} failed after ${job.attempts} attempts: ${internal}`);
      } else {
        logger.error(`${label} failed: ${internal}`, isKnownError(err) ? undefined : err);
      }
      safeSettle(playlistId, logger);
      return "failed";
    } catch (inner) {
      logger.error(`${label} could not record its failure (left for stale-lock recovery)`, inner);
      return "failed";
    }
  }
}

function isKnownError(err: unknown): boolean {
  const e = err as { retryable?: unknown; name?: unknown } | null;
  return !!e && (typeof e.retryable === "boolean" || e.name === "ConfigError");
}

function runFailureHandler(
  handler: JobHandler<JobType>,
  payload: JobPayloads[JobType],
  message: string,
  logger: JobLogger,
  label: string,
): void {
  try {
    const playlistId = handler.onFailure(payload, message);
    safeSettle(playlistId, logger);
  } catch (err) {
    logger.error(`${label} failure handler threw`, err);
  }
}

/**
 * Recovers stale locks and runs the failure handlers of jobs that had no attempts left.
 * `inFlight`: ids of jobs this process is still running (never treated as stale). Never throws.
 */
export function recoverStale(
  logger: JobLogger = consoleLogger,
  at: number = dbNow(),
  inFlight: ReadonlySet<string> = new Set(),
): number {
  try {
    return handleRecovery(recoverStaleJobs(at, undefined, inFlight), "stale", logger);
  } catch (err) {
    logger.error("stale-lock recovery failed", err);
    return 0;
  }
}

/**
 * Startup recovery (single-server assumption, see recoverOrphanedJobs): re-queues every job a
 * previous process left 'running' and runs the failure handlers of those with no attempts left.
 * Never throws.
 */
export function recoverOrphaned(logger: JobLogger = consoleLogger, at: number = dbNow()): number {
  try {
    return handleRecovery(recoverOrphanedJobs(at), "orphaned", logger);
  } catch (err) {
    logger.error("startup recovery failed", err);
    return 0;
  }
}

/** Logs a recovery and runs the failure handlers of the jobs that had no attempts left. */
function handleRecovery({ requeued, exhausted }: StaleRecovery, kind: string, logger: JobLogger): number {
  if (requeued) logger.warn(`recovered ${requeued} ${kind} job(s)`);
  for (const job of exhausted) {
    if (!isJobType(job.type)) continue;
    const handler = HANDLERS[job.type] as unknown as JobHandler<JobType>;
    let payload: JobPayloads[JobType];
    try {
      payload = parsePayload(job.type, job.payload_json);
    } catch {
      continue;
    }
    logger.error(`${job.type} ${shortId(job.id)} abandoned with no attempts left`);
    runFailureHandler(handler, payload, "This step stopped unexpectedly. Please retry.", logger, job.type);
  }
  return requeued + exhausted.length;
}

export interface DrainResult {
  processed: number;
  done: number;
  retried: number;
  failed: number;
}

/**
 * Runs runnable jobs one at a time until none is left (jobs scheduled in the future are not
 * waited for). For tests and scripts; the server uses startWorker().
 */
export async function runUntilIdle(opts: ProcessOptions & { maxJobs?: number } = {}): Promise<DrainResult> {
  const clock = opts.now ?? dbNow;
  const logger = opts.logger ?? consoleLogger;
  const result: DrainResult = { processed: 0, done: 0, retried: 0, failed: 0 };
  const max = opts.maxJobs ?? 1000;
  recoverStale(logger, clock());
  while (result.processed < max) {
    const job = claimNextJob(clock());
    if (!job) break;
    const outcome = await processJob(job, opts);
    result.processed++;
    if (outcome === "done") result.done++;
    else if (outcome === "retry") result.retried++;
    else result.failed++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Background loop
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 60_000;
const MAINTENANCE_MS = 60_000;
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface WorkerOptions extends ProcessOptions {
  concurrency?: number;
  pollMs?: number;
}

export class JobWorker {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly logger: JobLogger;
  private readonly opts: WorkerOptions;
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private lastMaintenance = 0;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly runningIds = new Set<string>();

  constructor(opts: WorkerOptions = {}) {
    this.opts = opts;
    this.concurrency = Math.min(8, Math.max(1, Math.floor(opts.concurrency ?? 2)));
    this.pollMs = Math.max(50, Math.floor(opts.pollMs ?? 1000));
    this.logger = opts.logger ?? consoleLogger;
  }

  get active(): number {
    return this.running;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger.info(`worker started (concurrency ${this.concurrency}, poll ${this.pollMs}ms)`);
    this.schedule(0);
  }

  /** True between start() and stop()/stopClaiming(). */
  get isRunning(): boolean {
    return !this.stopped;
  }

  /** Ids of the jobs this worker is running right now. */
  runningJobIds(): string[] {
    return [...this.runningIds];
  }

  /** Stops polling and claiming at once (synchronous); running jobs carry on. */
  stopClaiming(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Waits until every in-flight job has settled, or `timeoutMs` passed.
   * Resolves true when the worker is idle, false on timeout.
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    });
    try {
      return await Promise.race([Promise.allSettled([...this.inFlight]).then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops polling and waits for in-flight jobs to finish. */
  async stop(): Promise<void> {
    this.stopClaiming();
    await Promise.allSettled([...this.inFlight]);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
    this.timer.unref?.();
  }

  private now(): number {
    return (this.opts.now ?? dbNow)();
  }

  /** One polling pass: maintenance (every minute), then claim jobs up to the concurrency limit. */
  tick(): void {
    if (this.stopped) return;
    try {
      const at = this.now();
      if (at - this.lastMaintenance >= MAINTENANCE_MS) {
        this.lastMaintenance = at;
        recoverStale(this.logger, at, this.runningIds);
        try {
          purgeFinishedJobs(at - PURGE_AFTER_MS);
          purgeExpiredSessions(at);
          purgeRateLimitHits(at);
        } catch (err) {
          this.logger.error("purge failed", err);
        }
      }
      while (!this.stopped && this.running < this.concurrency) {
        const job = claimNextJob(this.now());
        if (!job) break;
        this.launch(job);
      }
    } catch (err) {
      this.logger.error("poll failed", err);
    } finally {
      this.schedule(this.pollMs);
    }
  }

  private launch(job: JobRow): void {
    this.running++;
    this.runningIds.add(job.id);
    const heartbeat = setInterval(() => {
      try {
        touchJob(job.id, this.now());
      } catch (err) {
        this.logger.error("heartbeat failed", err);
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const p: Promise<unknown> = processJob(job, this.opts)
      .catch((err) => this.logger.error(`${job.type} crashed`, err))
      .finally(() => {
        clearInterval(heartbeat);
        this.running--;
        this.runningIds.delete(job.id);
        this.inFlight.delete(p);
        // A slot is free: look for more work right away instead of waiting for the poll.
        if (!this.stopped) this.schedule(0);
      });
    this.inFlight.add(p);
  }
}

const GLOBAL_KEY = "__recallcastWorker" as const;
type GlobalWithWorker = typeof globalThis & { [GLOBAL_KEY]?: JobWorker };
const g = globalThis as GlobalWithWorker;

/**
 * Starts the DB-backed job worker loop (idempotent: guarded by a globalThis flag, so HMR or a
 * second register() call never starts a second loop). Called once from src/instrumentation.ts
 * register() when NEXT_RUNTIME === 'nodejs'. Never throws: a bad config is logged and the
 * server keeps running without a worker.
 */
export function startWorker(): void {
  try {
    if (g[GLOBAL_KEY]) return;
    const env = getEnv();
    if (!env.WORKER_ENABLED) {
      consoleLogger.info("worker disabled (WORKER_ENABLED=0)");
      return;
    }
    const worker = new JobWorker({ concurrency: env.WORKER_CONCURRENCY, pollMs: env.WORKER_POLL_MS });
    g[GLOBAL_KEY] = worker;
    // Single-server assumption: jobs still 'running' now were left by a previous process that
    // did not shut down cleanly; re-queue them before claiming anything (see recoverOrphanedJobs).
    recoverOrphaned(consoleLogger);
    worker.start();
  } catch (err) {
    consoleLogger.error("worker failed to start", err);
  }
}

/** Stops the global worker, if any (tests / graceful shutdown). */
export async function stopWorker(): Promise<void> {
  const w = g[GLOBAL_KEY];
  delete g[GLOBAL_KEY];
  if (w) await w.stop();
}

/** Worker state for /api/health. */
export function workerStatus(): { running: boolean; active: number } {
  const w = g[GLOBAL_KEY];
  return { running: !!w && w.isRunning, active: w?.active ?? 0 };
}

export interface ShutdownResult {
  /** Jobs put back in the queue (attempt not counted). */
  released: number;
  /** True when every running job finished within the grace period. */
  drained: boolean;
}

/**
 * Graceful shutdown of a worker, in this order:
 * 1. synchronously: stop claiming, then release the locks of the jobs still running
 *    (releaseJobs: back to 'queued', run_after = now, attempt not counted). This happens before
 *    the first await, so it is already in the DB even if something else (Next's own signal
 *    handler, or a SIGKILL after the platform's drain time) ends the process right after;
 * 2. then wait up to `graceMs` for those jobs to finish. A job that finishes in time still
 *    records its real outcome (completeJob/failJob accept the released 'queued' row).
 * Never throws.
 */
export async function shutdownJobWorker(
  worker: JobWorker,
  graceMs: number,
  logger: JobLogger = consoleLogger,
  at: () => number = dbNow,
): Promise<ShutdownResult> {
  worker.stopClaiming();
  const ids = worker.runningJobIds();
  let released = 0;
  try {
    released = releaseJobs(ids, at());
  } catch (err) {
    logger.error("could not release running jobs at shutdown (stale-lock recovery will pick them up)", err);
  }
  if (ids.length === 0) {
    logger.info("worker stopped (no running jobs)");
    return { released, drained: true };
  }
  logger.info(`worker stopping: released ${released} running job(s); waiting up to ${graceMs}ms for them to finish`);
  const drained = await worker.waitForIdle(graceMs);
  logger.info(drained ? "running jobs finished" : `grace period over; ${worker.active} job(s) will re-run on the next start`);
  return { released, drained };
}

const SHUTDOWN_KEY = "__recallcastShutdownHandlers" as const;
type GlobalWithShutdown = typeof globalThis & { [SHUTDOWN_KEY]?: true };

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Installs SIGTERM/SIGINT handlers for the global worker (idempotent). Called from
 * instrumentation.ts register().
 *
 * Next's server registers its own SIGTERM/SIGINT handlers before instrumentation runs; they
 * close the HTTP server and then call process.exit(). Both handlers run on the same signal,
 * and the DB release here is synchronous (shutdownJobWorker step 1), so it always lands before
 * Next's asynchronous cleanup can exit. With Next's handlers active, the grace wait is cut
 * short when Next exits. To let running jobs use the full SHUTDOWN_GRACE_MS, set
 * NEXT_MANUAL_SIG_HANDLE=true (the Dockerfile does): Next then skips its handlers and this
 * one exits the process itself after the grace period (128 + signal number).
 */
export function installShutdownHandlers(): void {
  const gs = globalThis as GlobalWithShutdown;
  if (gs[SHUTDOWN_KEY]) return;
  gs[SHUTDOWN_KEY] = true;

  const ownsExit = !!process.env.NEXT_MANUAL_SIG_HANDLE;
  let graceMs = 15_000;
  try {
    graceMs = getEnv().SHUTDOWN_GRACE_MS;
  } catch {
    // a bad env is reported by startWorker(); keep the default here
  }
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals) => {
    const code = SIGNAL_EXIT_CODES[signal] ?? 128;
    if (shuttingDown) {
      // Second Ctrl+C / SIGTERM: stop waiting. The locks were already released.
      if (ownsExit) process.exit(code);
      return;
    }
    shuttingDown = true;
    consoleLogger.info(`${signal} received: shutting down`);
    const w = g[GLOBAL_KEY];
    delete g[GLOBAL_KEY];
    const done = w ? shutdownJobWorker(w, graceMs) : Promise.resolve(null);
    void done
      .catch((err) => consoleLogger.error("shutdown failed", err))
      .finally(() => {
        if (ownsExit) process.exit(code);
      });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
