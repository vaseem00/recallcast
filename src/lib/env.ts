import "server-only";
import { z } from "zod";

/**
 * Typed, lazily-parsed environment accessor.
 *
 * - Never throws at import time. `getEnv()` parses on first call and caches.
 * - Empty strings are treated as "unset" (common with copied .env files).
 * - Provider keys are optional here; use `requireEnv()` inside a real provider
 *   (at job time) so a missing key surfaces as a clear ConfigError.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const optionalString = z.string().min(1).optional();
const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);
const bool = (def: boolean) =>
  z
    .enum(["1", "0", "true", "false", "yes", "no", "on", "off"])
    .default(def ? "1" : "0")
    .transform((v) => v === "1" || v === "true" || v === "yes" || v === "on");
/** A public link as "Share reels" copies it (https://host/r/<id>), or only its 22-character id. Parsed to the id. */
const shareLink = z
  .string()
  .transform((v) => v.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "")
  .refine((v) => /^[A-Za-z0-9_-]{22}$/.test(v), "must be a share link (https://.../r/<id>) or its 22-character id")
  .optional();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /** Public base URL, e.g. https://recallcast.example.com. Used for same-origin checks and absolute links. */
  APP_URL: z.url().optional(),
  /**
   * Reverse proxies in front of the app that append to X-Forwarded-For (0-5). 0 (default): XFF
   * is ignored and rate limits use the TCP peer address. N: the client is the Nth XFF entry
   * from the right. Never set it higher than the real number of proxies: XFF is client-controlled.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  /** SQLite file path (relative to process.cwd()) or ':memory:'. */
  DATABASE_PATH: z.string().min(1).default("./data/recallcast.db"),
  /** Root for generated files (legacy MP3s of removed AI-voiced episodes, deleted with their playlist). */
  STORAGE_DIR: z.string().min(1).default("./storage"),

  // Provider modes
  YOUTUBE_PROVIDER: z.enum(["api", "mock"]).default("mock"),
  TRANSCRIPT_PROVIDER: z.enum(["youtubei", "mock"]).default("mock"),
  AI_PROVIDER: z.enum(["anthropic", "mock"]).default("mock"),

  // YouTube
  YOUTUBE_API_KEY: optionalString,

  // Anthropic: one small call per video longer than ~4.5 minutes, to pick the clip.
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Server-side refusal fallbacks, on models that support them (not Haiku). Set 0 to turn off. */
  CLAUDE_REFUSAL_FALLBACK: bool(true),

  // Limits
  MAX_VIDEOS_PER_PLAYLIST: positiveInt(25),
  MAX_VIDEO_SECONDS: positiveInt(10800),
  MAX_PLAYLISTS_PER_USER_PER_DAY: positiveInt(5),
  /**
   * Site-wide caps over any rolling 24 hours. Without email verification these are what bound
   * the API bill if many throwaway accounts are made: new accounts, and new playlists across
   * every user.
   */
  MAX_SIGNUPS_PER_DAY: positiveInt(100),
  MAX_PLAYLISTS_PER_DAY: positiveInt(60),
  /**
   * Most reels cut from one video (1-12). A video gets one per five minutes up to this number,
   * from one extra Claude call per video however many it returns.
   */
  REELS_PER_VIDEO_MAX: z.coerce.number().int().min(1).max(12).default(6),
  /** Public links (shared reels and shared feeds) one account may have at a time. */
  MAX_SHARES_PER_USER: positiveInt(200),
  /**
   * The shared feed the landing page offers to visitors without an account: paste the link that
   * "Share reels" copied. Unset, or a link that was revoked since, and the landing page shows no sample.
   */
  SAMPLE_FEED: shareLink,

  /** On SIGTERM: how long running jobs get to finish before their locks are released (ms). */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),

  // Worker
  WORKER_ENABLED: bool(true),
  WORKER_POLL_MS: positiveInt(1000),
  /** Jobs run at the same time by one worker process (1-8). */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

function readRawEnv(): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = process.env[key];
    raw[key] = value === undefined || value.trim() === "" ? undefined : value.trim();
  }
  return raw;
}

/** Parsed env. Throws ConfigError (not at import) if a present value is malformed. */
export function getEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse(readRawEnv());
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }
  cached = result.data;
  return cached;
}

/** Clears the cache so the next getEnv() re-reads process.env (tests). */
export function resetEnvCache(): void {
  cached = null;
}

type StringKeys = {
  [K in keyof Env]-?: Env[K] extends string | undefined ? K : never;
}[keyof Env];

/**
 * Returns a required string env value or throws a ConfigError that names the
 * variable and the provider that needs it. Call this at job time, not import time.
 */
export function requireEnv(key: StringKeys, neededBy?: string): string {
  const value = getEnv()[key];
  if (typeof value !== "string" || value.length === 0) {
    const who = neededBy ? ` (required by ${neededBy})` : "";
    throw new ConfigError(`Missing environment variable ${String(key)}${who}. Set it in .env.local.`);
  }
  return value;
}

export function isProd(): boolean {
  return getEnv().NODE_ENV === "production";
}
