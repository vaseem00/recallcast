import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { all, closeDb, get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { newId } from "@/lib/ids";
import type { SessionRow } from "@/lib/types";
import {
  deleteSessionByToken,
  deleteSessionsForUser,
  extendSession,
  hashToken,
  insertSession,
  isWellFormedToken,
  lookupSession,
  MAX_SESSIONS_PER_USER,
  newSessionToken,
  purgeExpiredSessions,
  SESSION_REFRESH_THRESHOLD_MS,
  SESSION_TTL_MS,
} from "./session";

// Sessions run against a real temp database file on disk.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-auth-"));

beforeAll(() => {
  process.env.DATABASE_PATH = path.join(dir, "auth.db");
  resetEnvCache();
  closeDb();
});

afterAll(() => {
  closeDb();
  process.env.DATABASE_PATH = ":memory:";
  resetEnvCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertUser(email: string): string {
  const id = newId();
  run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", id, email, "x", 1000);
  return id;
}

describe("session tokens", () => {
  it("are 32 random bytes as 43-char base64url", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(newSessionToken()).not.toBe(t);
    expect(isWellFormedToken(t)).toBe(true);
    expect(isWellFormedToken("short")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken(t + "x")).toBe(false);
  });

  it("hash to sha256 hex", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("session lifecycle", () => {
  it("create -> lookup -> destroy; DB stores only the sha256 of the token", () => {
    const userId = insertUser("life@example.com");
    const t0 = 1_700_000_000_000;
    const { token, expiresAt } = insertSession(userId, t0);
    expect(expiresAt).toBe(t0 + SESSION_TTL_MS);

    const rows = all<SessionRow>("SELECT * FROM sessions WHERE user_id = ?", userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(hashToken(token));
    expect(rows[0].id).not.toBe(token);
    expect(Number(rows[0].created_at)).toBe(t0);

    const found = lookupSession(token, t0 + 1000);
    expect(found?.user).toEqual({ id: userId, email: "life@example.com", createdAt: 1000 });
    expect(found?.shouldRefresh).toBe(false);

    deleteSessionByToken(token);
    expect(lookupSession(token, t0 + 2000)).toBeNull();
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(token))).toBeUndefined();
  });

  it("returns null for unknown, malformed or missing tokens", () => {
    expect(lookupSession(undefined)).toBeNull();
    expect(lookupSession("")).toBeNull();
    expect(lookupSession("not-a-token")).toBeNull();
    expect(lookupSession(newSessionToken())).toBeNull();
    // Looking up by the stored hash (instead of the raw token) must not work.
    const userId = insertUser("hashlookup@example.com");
    const { token } = insertSession(userId);
    expect(lookupSession(hashToken(token))).toBeNull();
  });

  it("expires after 30 days and deletes the expired row", () => {
    const userId = insertUser("expire@example.com");
    const t0 = 1_700_000_000_000;
    const { token } = insertSession(userId, t0);
    expect(lookupSession(token, t0 + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(lookupSession(token, t0 + SESSION_TTL_MS)).toBeNull();
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(token))).toBeUndefined();
  });

  it("asks for a sliding refresh in the second half of its life, and extends", () => {
    const userId = insertUser("slide@example.com");
    const t0 = 1_700_000_000_000;
    const { token } = insertSession(userId, t0);
    const late = t0 + SESSION_TTL_MS - SESSION_REFRESH_THRESHOLD_MS + 1;
    const found = lookupSession(token, late);
    expect(found?.shouldRefresh).toBe(true);
    const newExpiry = extendSession(found!.sessionId, late);
    expect(newExpiry).toBe(late + SESSION_TTL_MS);
    // Valid well past the original expiry now.
    expect(lookupSession(token, late + 1000)?.shouldRefresh).toBe(false);
    const after = lookupSession(token, t0 + SESSION_TTL_MS + 1000);
    expect(after).not.toBeNull();
  });

  it("does not resurrect an expired or deleted session on extend", () => {
    const userId = insertUser("noresurrect@example.com");
    const t0 = 1_700_000_000_000;
    const { token } = insertSession(userId, t0);
    expect(extendSession(hashToken(token), t0 + SESSION_TTL_MS + 1)).toBeNull();
    deleteSessionByToken(token);
    expect(extendSession(hashToken(token), t0 + 1)).toBeNull();
  });

  it("caps concurrent sessions per user and prunes the user's expired ones", () => {
    const userId = insertUser("cap@example.com");
    const t0 = 1_700_000_000_000;
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 5; i++) tokens.push(insertSession(userId, t0 + i).token);
    const n = get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId);
    expect(Number(n?.n)).toBe(MAX_SESSIONS_PER_USER);
    expect(lookupSession(tokens[0], t0 + 100)).toBeNull(); // oldest pruned
    expect(lookupSession(tokens.at(-1)!, t0 + 100)).not.toBeNull(); // newest kept

    // A login after everything expired leaves only the fresh session.
    const later = t0 + SESSION_TTL_MS + 10_000;
    insertSession(userId, later);
    const n2 = get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId);
    expect(Number(n2?.n)).toBe(1);
  });

  it("deleteSessionsForUser and purgeExpiredSessions", () => {
    const a = insertUser("purge-a@example.com");
    const b = insertUser("purge-b@example.com");
    const t0 = 1_700_000_000_000;
    insertSession(a, t0);
    insertSession(a, t0);
    const keep = insertSession(b, t0 + SESSION_TTL_MS).token;
    expect(deleteSessionsForUser(a)).toBe(2);
    insertSession(a, t0);
    expect(purgeExpiredSessions(t0 + SESSION_TTL_MS + 1)).toBeGreaterThanOrEqual(1);
    expect(lookupSession(keep, t0 + SESSION_TTL_MS + 1)).not.toBeNull();
  });

  it("sessions cascade when the user is deleted", () => {
    const userId = insertUser("cascade@example.com");
    const { token } = insertSession(userId);
    run("DELETE FROM users WHERE id = ?", userId);
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(token))).toBeUndefined();
  });
});
