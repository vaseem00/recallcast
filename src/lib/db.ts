import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync, SQLInputValue } from "node:sqlite";
import { getEnv } from "@/lib/env";

/**
 * SQLite access via Node's built-in node:sqlite (DatabaseSync).
 *
 * HOW node:sqlite IS LOADED: through `process.getBuiltinModule("node:sqlite")`
 * at runtime instead of a static `import ... from "node:sqlite"`. Bundlers
 * (Turbopack/webpack) never see a module specifier, so there is nothing to
 * resolve or externalize, and it works the same in `next dev`, `next build`,
 * `next start` and vitest. The type-only import above is erased at compile time.
 *
 * All DB access goes through this module. Migrations run once, on the first
 * getDb() call. SQL is kept close to portable (TEXT ids, INTEGER ms timestamps,
 * REAL for floats, CHECK constraints, no SQLite-only types) for a later move to Postgres.
 */

export type SqlValue = SQLInputValue;
export type SqlParams = SqlValue[] | [Record<string, SqlValue>];

interface DbHolder {
  db: DatabaseSync;
  path: string;
  stmts: Map<string, StatementSync>;
}

const GLOBAL_KEY = "__recallcastDb" as const;
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: DbHolder };
const g = globalThis as GlobalWithDb;

function loadSqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!mod) {
    throw new Error("node:sqlite is unavailable. RecallCast needs Node.js >= 22.13 (built-in SQLite).");
  }
  return mod;
}

// ---------------------------------------------------------------------------
// Migrations (append only; never edit a migration that has shipped)
// ---------------------------------------------------------------------------

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  youtube_playlist_id TEXT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('playlist','video')),
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','ingesting','processing','ready','partial','failed')),
  error TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_playlists_user_created ON playlists(user_id, created_at);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  youtube_video_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  duration_s INTEGER NOT NULL DEFAULT 0,
  thumbnail TEXT NOT NULL DEFAULT '',
  transcript_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (transcript_status IN ('pending','ok','needs_manual','failed')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','transcribing','analyzing','scripting','voicing','ready','failed','skipped')),
  error TEXT NULL
);
CREATE INDEX idx_videos_playlist_position ON videos(playlist_id, position);

CREATE TABLE transcripts (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('youtubei','manual','mock')),
  lang TEXT NOT NULL DEFAULT '',
  segments_json TEXT NOT NULL
);

CREATE TABLE knowledge (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id TEXT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('video','recap')),
  title TEXT NOT NULL DEFAULT '',
  script_json TEXT NOT NULL,
  audio_path TEXT NULL,
  duration_s REAL NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','scripted','voiced','failed')),
  error TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_episodes_playlist ON episodes(playlist_id);
CREATE INDEX idx_episodes_video ON episodes(video_id);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_start REAL NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  interval_days REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cards_user_due ON cards(user_id, due_at);
CREATE INDEX idx_cards_playlist_due ON cards(playlist_id, due_at);
CREATE INDEX idx_cards_video ON cards(video_id);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating TEXT NOT NULL CHECK (rating IN ('again','hard','good','easy')),
  reviewed_at INTEGER NOT NULL
);
CREATE INDEX idx_reviews_card ON reviews(card_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after INTEGER NOT NULL,
  locked_at INTEGER NULL,
  last_error TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_status_run_after ON jobs(status, run_after);
`,
  },
  {
    version: 2,
    name: "usage_ledger_and_retry_counts",
    sql: `
-- Append-only record of playlist creations for the daily cap. Deleting a playlist must not
-- give the slot back, so the cap counts this table, not live playlists rows.
CREATE TABLE playlist_creations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_playlist_creations_user_created ON playlist_creations(user_id, created_at);
INSERT INTO playlist_creations (user_id, created_at) SELECT user_id, created_at FROM playlists;

-- How many times the user re-ran paid work for a video (retry or re-pasted transcript),
-- and for the playlist-level steps (ingest, recap). Capped in jobs/commands.ts.
ALTER TABLE videos ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playlists ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 3,
    name: "persistent_rate_limits_and_signup_ledger",
    sql: `
-- One row per counted hit of a rate limiter, so limits survive a restart or a deploy.
-- bucket = limiter name (loginIp, signupIp, ...), key = what is limited (an IP, an email).
CREATE TABLE rate_limit_hits (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_rate_limit_hits ON rate_limit_hits(bucket, key, at);
CREATE INDEX idx_rate_limit_hits_at ON rate_limit_hits(at);

-- Append-only record of account creations for the site-wide daily sign-up cap. Not tied to
-- users(id): deleting an account must not give the slot back.
CREATE TABLE signup_events (
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_signup_events_created ON signup_events(created_at);
INSERT INTO signup_events (created_at) SELECT created_at FROM users;
`,
  },
  {
    version: 4,
    name: "site_playlist_ledger",
    sql: `
-- Site-wide playlist ledger for MAX_PLAYLISTS_PER_DAY. Unlike playlist_creations it has no
-- user foreign key, so deleting an account does not give its slots back to the site cap.
CREATE TABLE playlist_events (
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_playlist_events_created ON playlist_events(created_at);
INSERT INTO playlist_events (created_at) SELECT created_at FROM playlist_creations;
`,
  },
  {
    version: 5,
    name: "reels_moments_and_shares",
    sql: `
-- Reels: the self-contained moments of a video (about a minute each), best first (ord 0).
-- Rows belong to the playlist's owner; saved_at / seen_at are that owner's feed state.
CREATE TABLE moments (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  start_s INTEGER NOT NULL,
  end_s INTEGER NOT NULL,
  hook TEXT NOT NULL,
  takeaway TEXT NOT NULL DEFAULT '',
  picked TEXT NOT NULL CHECK (picked IN ('ai','heuristic','whole')),
  saved_at INTEGER NULL,
  seen_at INTEGER NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_moments_video ON moments(video_id, ord);
CREATE INDEX idx_moments_playlist ON moments(playlist_id);

-- 'none' (not picked yet, or no transcript), 'pending' (pick_moments queued or running), 'ready'.
ALTER TABLE videos ADD COLUMN moments_status TEXT NOT NULL DEFAULT 'none';

-- Public links. The slug is the only credential: anyone who has it can watch that one moment,
-- or that playlist's reels, without an account. Deleting the row revokes the link.
CREATE TABLE shares (
  slug TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('moment','playlist')),
  moment_id TEXT NULL REFERENCES moments(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_shares_moment ON shares(moment_id) WHERE kind = 'moment';
CREATE UNIQUE INDEX idx_shares_playlist ON shares(playlist_id) WHERE kind = 'playlist';
CREATE INDEX idx_shares_user ON shares(user_id);
`,
  },
  {
    version: 6,
    name: "reels_without_captions_and_watch_signals",
    sql: `
-- The creator's chapter marks from the description (JSON [{start,title}]); NULL = never read.
-- Videos without captions get their reels cut at these marks.
ALTER TABLE videos ADD COLUMN chapters_json TEXT NULL;

-- What a reel was cut from. Every existing reel was cut from a transcript.
ALTER TABLE moments ADD COLUMN basis TEXT NOT NULL DEFAULT 'transcript'
  CHECK (basis IN ('transcript','chapters','position'));

-- The owner's viewing of each reel, which orders their feed: seconds played, times played to
-- the end, times swiped away within the first seconds.
ALTER TABLE moments ADD COLUMN watch_s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE moments ADD COLUMN completions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE moments ADD COLUMN skips INTEGER NOT NULL DEFAULT 0;
`,
  },
];

/**
 * Applies one migration under the write lock. The "already applied?" check runs AFTER
 * BEGIN IMMEDIATE, so when two processes open a fresh database at once the second one sees the
 * first one's commit and skips the migration instead of failing on CREATE TABLE.
 * Returns true when this call applied it.
 */
export function applyMigration(db: DatabaseSync, m: { version: number; name: string; sql: string }): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 AS x FROM schema_migrations WHERE version = ?").get(m.version)) {
      db.exec("COMMIT");
      return false;
    }
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      m.version,
      m.name,
      Date.now(),
    );
    db.exec("COMMIT");
    return true;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  // A cheap pre-read skips the lock entirely on the usual (already migrated) start;
  // applyMigration re-checks under the lock.
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => Number(r.version),
    ),
  );
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    applyMigration(db, m);
  }
}

/** Opens a database at `file` (or ':memory:'), applies PRAGMAs and migrations. Does not touch the singleton. */
export function openDatabase(file: string): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function resolveDbPath(): string {
  const configured = getEnv().DATABASE_PATH;
  // turbopackIgnore: a runtime-configured path; without it Turbopack traces the whole project.
  return configured === ":memory:" ? configured : path.resolve(/*turbopackIgnore: true*/ process.cwd(), configured);
}

function holder(): DbHolder {
  let h = g[GLOBAL_KEY];
  if (!h) {
    const file = resolveDbPath();
    h = { db: openDatabase(file), path: file, stmts: new Map() };
    g[GLOBAL_KEY] = h;
  }
  return h;
}

/** The process-wide DatabaseSync (created and migrated on first call; survives HMR via globalThis). */
export function getDb(): DatabaseSync {
  return holder().db;
}

/** Closes and forgets the singleton (tests; next getDb() reopens using current env). */
export function closeDb(): void {
  const h = g[GLOBAL_KEY];
  if (h) {
    try {
      h.db.close();
    } finally {
      delete g[GLOBAL_KEY];
    }
  }
}

function stmt(sql: string): StatementSync {
  const h = holder();
  let s = h.stmts.get(sql);
  if (!s) {
    s = h.db.prepare(sql);
    h.stmts.set(sql, s);
  }
  return s;
}

function call<R>(s: StatementSync, method: "run" | "get" | "all", params: SqlParams): R {
  // node:sqlite accepts either positional values or one named-parameter object first.
  const fn = s[method] as (...args: unknown[]) => unknown;
  return fn.apply(s, params) as R;
}

/** Executes a write. Positional `?` params, or a single object for `:name` / `$name` / `@name` params. */
export function run(sql: string, ...params: SqlParams): { changes: number; lastInsertRowid: number } {
  const r = call<{ changes: number | bigint; lastInsertRowid: number | bigint }>(stmt(sql), "run", params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** Returns the first row or undefined. */
export function get<T = Record<string, unknown>>(sql: string, ...params: SqlParams): T | undefined {
  return call<T | undefined>(stmt(sql), "get", params);
}

/** Returns all rows. */
export function all<T = Record<string, unknown>>(sql: string, ...params: SqlParams): T[] {
  return call<T[]>(stmt(sql), "all", params);
}

/** Runs raw multi-statement SQL (no params). */
export function exec(sql: string): void {
  getDb().exec(sql);
}

let savepointSeq = 0;

/**
 * Runs `fn` inside a transaction (BEGIN IMMEDIATE). Nested calls use SAVEPOINTs.
 * `fn` must be synchronous: node:sqlite is synchronous, and awaiting inside a
 * transaction would let other requests interleave on the same connection.
 */
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  if (db.isTransaction) {
    const name = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      db.exec(`RELEASE SAVEPOINT ${name}`);
      throw err;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    if (out instanceof Promise) {
      throw new Error("transaction(fn): fn must be synchronous");
    }
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

/** Current time in integer ms (single place so tests can reason about it). */
export function now(): number {
  return Date.now();
}
