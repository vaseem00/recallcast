import "server-only";
import { get, run, transaction } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { readPeer } from "./peer";

/**
 * Sliding-log rate limiters. The app limiters (getAuthLimiters) are SqliteRateLimiter: hits are
 * stored in rate_limit_hits so a restart or deploy does not hand attackers a fresh budget.
 * RateLimiter is the in-memory variant with the same semantics (unit tests, fallback).
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the oldest counted hit leaves the window (0 when allowed and not full). */
  retryAfterS: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /** Max distinct keys kept; expired keys are pruned first, then the oldest. */
  maxKeys?: number;
}

export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: RateLimiterOptions) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) throw new Error("RateLimiter: limit and windowMs must be > 0");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  private live(key: string, at: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = at - this.windowMs;
    let i = 0;
    while (i < list.length && list[i] <= cutoff) i++;
    if (i > 0) list.splice(0, i);
    if (list.length === 0) this.hits.delete(key);
    return list;
  }

  private retryAfter(list: number[], at: number): number {
    return list.length > 0 ? Math.max(1, Math.ceil((list[0] + this.windowMs - at) / 1000)) : 1;
  }

  /** Whether one more hit for `key` would be allowed right now (does not count a hit). */
  check(key: string, at: number = Date.now()): RateLimitResult {
    const list = this.live(key, at);
    const allowed = list.length < this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - list.length),
      retryAfterS: allowed ? 0 : this.retryAfter(list, at),
    };
  }

  /**
   * Records one hit for `key` and reports whether THIS hit was within the limit
   * (the first `limit` hits in a window are allowed). Blocked hits still count, so a
   * client that keeps hammering stays blocked.
   */
  hit(key: string, at: number = Date.now()): RateLimitResult {
    let list = this.live(key, at);
    if (list.length === 0) {
      if (!this.makeRoom(at)) {
        // Full of blocked keys: fail closed for new keys rather than forget a blocked one.
        return { allowed: false, remaining: 0, retryAfterS: Math.max(1, Math.ceil(this.windowMs / 1000)) };
      }
      list = [];
      this.hits.set(key, list);
    }
    const allowed = list.length < this.limit;
    // Cap stored entries so a hammering client cannot grow memory without bound.
    if (!allowed) list.shift();
    list.push(at);
    return {
      allowed,
      remaining: Math.max(0, this.limit - list.length),
      retryAfterS: allowed ? 0 : this.retryAfter(list, at),
    };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  clear(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }

  /**
   * Makes room for one new key. Expired keys go first (a full sweep, at most once per second so
   * a flood of new keys does not cost O(n) each), then the oldest keys that are NOT blocked.
   * A blocked key is never evicted: otherwise flooding the limiter with throwaway keys would
   * reset a target's counter. Returns false when every stored key is blocked.
   */
  private makeRoom(at: number): boolean {
    if (this.hits.size < this.maxKeys) return true;
    if (at - this.lastSweep >= 1000 || at < this.lastSweep) {
      this.lastSweep = at;
      for (const key of [...this.hits.keys()]) this.live(key, at);
      if (this.hits.size < this.maxKeys) return true;
    }
    // Map iteration is in insertion order; deleting the current entry while iterating is safe.
    for (const [key, list] of this.hits) {
      if (this.hits.size < this.maxKeys) break;
      if (list.length < this.limit) this.hits.delete(key);
    }
    return this.hits.size < this.maxKeys;
  }

  private lastSweep = -Infinity;
}

// ---- Persistent limiter (SQLite) ----

export interface SqliteRateLimiterOptions {
  /** Limiter name stored in rate_limit_hits.bucket. Instances with the same bucket share hits. */
  bucket: string;
  limit: number;
  windowMs: number;
}

/** Longest window of any SqliteRateLimiter created in this process, per bucket (for the global purge). */
const bucketWindows = new Map<string, number>();
/** Rows of buckets nobody in this process knows about are kept at least this long. */
const UNKNOWN_BUCKET_KEEP_MS = 24 * 60 * 60 * 1000;
/** hit() runs a global purge at most this often (wall clock), in case no maintenance job calls it. */
const AUTO_PURGE_EVERY_MS = 10 * 60 * 1000;
let lastAutoPurge = -Infinity;

/**
 * Same semantics as RateLimiter (sliding log per key, blocked hits still count, retryAfterS from
 * the oldest counted hit) but the hits live in the rate_limit_hits table, so limits survive a
 * restart or deploy and are shared by every process using the same database file.
 *
 * Table growth is bounded: each hit first deletes that key's rows that left the window, and a
 * blocked hit replaces the key's oldest row instead of adding one, so a key never holds more
 * than `limit` rows. Rows of keys that stop hitting are removed by purgeRateLimitHits().
 * All work is synchronous (node:sqlite) and runs in one transaction, so parallel requests
 * cannot both take the last slot.
 */
export class SqliteRateLimiter {
  readonly bucket: string;
  readonly limit: number;
  readonly windowMs: number;

  constructor(opts: SqliteRateLimiterOptions) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) throw new Error("SqliteRateLimiter: limit and windowMs must be > 0");
    if (!opts.bucket) throw new Error("SqliteRateLimiter: bucket is required");
    this.bucket = opts.bucket;
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    bucketWindows.set(opts.bucket, Math.max(bucketWindows.get(opts.bucket) ?? 0, opts.windowMs));
  }

  private stats(key: string, at: number): { n: number; oldest: number | null } {
    const row = get<{ n: number; oldest: number | null }>(
      "SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_limit_hits WHERE bucket = ? AND key = ? AND at > ?",
      this.bucket,
      key,
      at - this.windowMs,
    );
    return { n: Number(row?.n ?? 0), oldest: row?.oldest == null ? null : Number(row.oldest) };
  }

  private retryAfter(oldest: number | null, at: number): number {
    return oldest !== null ? Math.max(1, Math.ceil((oldest + this.windowMs - at) / 1000)) : 1;
  }

  /** Whether one more hit for `key` would be allowed right now (does not count a hit). */
  check(key: string, at: number = Date.now()): RateLimitResult {
    const { n, oldest } = this.stats(key, at);
    const allowed = n < this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - n),
      retryAfterS: allowed ? 0 : this.retryAfter(oldest, at),
    };
  }

  /**
   * Records one hit for `key` and reports whether THIS hit was within the limit (the first
   * `limit` hits in a window are allowed). Blocked hits still count, so a client that keeps
   * hammering stays blocked.
   */
  hit(key: string, at: number = Date.now()): RateLimitResult {
    maybeAutoPurge();
    return transaction(() => {
      run("DELETE FROM rate_limit_hits WHERE bucket = ? AND key = ? AND at <= ?", this.bucket, key, at - this.windowMs);
      const { n } = this.stats(key, at);
      const allowed = n < this.limit;
      if (!allowed) {
        // Keep at most `limit` rows per key: drop the oldest so this hit can be stored.
        run(
          `DELETE FROM rate_limit_hits WHERE rowid IN (
             SELECT rowid FROM rate_limit_hits WHERE bucket = ? AND key = ? ORDER BY at ASC LIMIT ?)`,
          this.bucket,
          key,
          n - this.limit + 1,
        );
      }
      run("INSERT INTO rate_limit_hits (bucket, key, at) VALUES (?, ?, ?)", this.bucket, key, at);
      const after = allowed ? null : this.stats(key, at);
      return {
        allowed,
        remaining: Math.max(0, this.limit - Math.min(n + 1, this.limit)),
        retryAfterS: allowed ? 0 : this.retryAfter(after?.oldest ?? null, at),
      };
    });
  }

  reset(key: string): void {
    run("DELETE FROM rate_limit_hits WHERE bucket = ? AND key = ?", this.bucket, key);
  }

  /** Forgets every key of this bucket (tests). */
  clear(): void {
    run("DELETE FROM rate_limit_hits WHERE bucket = ?", this.bucket);
  }

  /** Number of distinct keys with stored hits in this bucket. */
  get size(): number {
    return Number(
      get<{ n: number }>("SELECT COUNT(DISTINCT key) AS n FROM rate_limit_hits WHERE bucket = ?", this.bucket)?.n ?? 0,
    );
  }
}

/**
 * Deletes rate_limit_hits rows that no longer count: per known bucket, rows older than its
 * window; for buckets not created in this process, rows older than max(24 h, longest window).
 * Cheap (indexed on `at`); meant for the periodic maintenance job. Returns rows deleted.
 */
export function purgeRateLimitHits(at: number = Date.now()): number {
  getAuthLimiters(); // registers the app buckets' windows when called from a fresh process
  return transaction(() => {
    let deleted = 0;
    let longest = UNKNOWN_BUCKET_KEEP_MS;
    for (const [bucket, windowMs] of bucketWindows) {
      longest = Math.max(longest, windowMs);
      deleted += run("DELETE FROM rate_limit_hits WHERE bucket = ? AND at <= ?", bucket, at - windowMs).changes;
    }
    deleted += run("DELETE FROM rate_limit_hits WHERE at <= ?", at - longest).changes;
    return deleted;
  });
}

function maybeAutoPurge(): void {
  const wall = Date.now();
  if (wall - lastAutoPurge < AUTO_PURGE_EVERY_MS) return;
  lastAutoPurge = wall;
  try {
    purgeRateLimitHits(wall);
  } catch (err) {
    // Housekeeping only: a failed purge must not fail the request being limited.
    console.error("[rate-limit] purge failed", err);
  }
}

// ---- App limiters (survive HMR via globalThis; hits persist in SQLite) ----

/** The part of a limiter the routes use; both RateLimiter and SqliteRateLimiter implement it. */
export interface Limiter {
  readonly limit: number;
  readonly windowMs: number;
  hit(key: string, at?: number): RateLimitResult;
  check(key: string, at?: number): RateLimitResult;
  reset(key: string): void;
  clear(): void;
}

export interface Limiters {
  /** Per client IP across all emails: caps credential stuffing / password spraying. */
  loginIp: Limiter;
  /** Spec: per IP + email, 10 attempts / 15 min. */
  loginIpEmail: Limiter;
  /**
   * Per email across all IPs (distributed guessing). Not applied to a device that already signed
   * in to the account (rc_device cookie), so nobody can lock the owner out by failing on purpose.
   */
  loginEmail: Limiter;
  /** Per IP account creation (counts every attempt, including ones refused as a duplicate email). */
  signupIp: Limiter;
  /** Per user id: change-password attempts (current password checks), 10 / 15 min. */
  passwordChange: Limiter;
}

// Versioned so a dev-server HMR does not keep an older object without newer limiters.
const KEY = "__recallcastAuthLimitersV2" as const;
type G = typeof globalThis & { [KEY]?: Limiters };

export function getAuthLimiters(): Limiters {
  const g = globalThis as G;
  if (!g[KEY]) {
    const fifteenMin = 15 * 60 * 1000;
    g[KEY] = {
      loginIp: new SqliteRateLimiter({ bucket: "loginIp", limit: 100, windowMs: fifteenMin }),
      loginIpEmail: new SqliteRateLimiter({ bucket: "loginIpEmail", limit: 10, windowMs: fifteenMin }),
      loginEmail: new SqliteRateLimiter({ bucket: "loginEmail", limit: 50, windowMs: fifteenMin }),
      signupIp: new SqliteRateLimiter({ bucket: "signupIp", limit: 10, windowMs: 60 * 60 * 1000 }),
      passwordChange: new SqliteRateLimiter({ bucket: "passwordChange", limit: 10, windowMs: fifteenMin }),
    };
  }
  return g[KEY];
}

/**
 * The client IP used as a rate-limit key. Never trusts client-supplied headers by default:
 *
 * - TRUST_PROXY_HOPS = 0 (default): the TCP peer address stamped by installPeerStamp()
 *   (see ./peer.ts). X-Forwarded-For and X-Real-IP are ignored.
 * - TRUST_PROXY_HOPS = N: the Nth X-Forwarded-For entry from the RIGHT, i.e. the address that
 *   the outermost of your N proxies saw. Entries further left were written by the client.
 *   With fewer than N entries the peer address is used.
 *
 * IPv6 addresses are reduced to their /64 prefix (one host usually controls a whole /64), and
 * IPv4-mapped IPv6 to plain IPv4. Returns "unknown" when nothing trustworthy is available.
 */
export function clientIp(req: Request, hops: number = getEnv().TRUST_PROXY_HOPS): string {
  let ip: string | null = null;
  if (hops > 0) {
    const chain = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length >= hops) ip = chain[chain.length - hops];
  }
  ip ??= readPeer(req.headers);
  return ip ? ipKey(ip) : "unknown";
}

/** Normalises an address into a rate-limit key (see clientIp). */
export function ipKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  const v4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (v4Port) s = v4Port[1];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return s;
  if (s.includes(":")) {
    const zone = s.indexOf("%");
    if (zone >= 0) s = s.slice(0, zone);
    const groups = expandIpv6(s);
    if (groups) return `${groups.slice(0, 4).join(":")}::/64`;
  }
  return s.slice(0, 64);
}

function expandIpv6(s: string): string[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(":") : []);
  const toGroups = (parts: string[]): string[] | null => {
    const out: string[] = [];
    for (const p of parts) {
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(p)) {
        const [a, b, c, d] = p.split(".").map(Number);
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(p)) {
        out.push(parseInt(p, 16).toString(16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = toGroups(part(halves[0]));
  const tail = halves.length === 2 ? toGroups(part(halves[1])) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<string>(Math.max(0, missing)).fill("0"), ...tail];
}
