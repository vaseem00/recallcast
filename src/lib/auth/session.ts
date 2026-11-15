import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { get, now as dbNow, run, transaction } from "@/lib/db";
import type { PublicUser } from "@/lib/types";

/**
 * DB-level session store, free of next/headers so it is unit-testable.
 * The raw token only ever lives in the cookie; the DB stores sha256(token) as the id.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding refresh: extend when less than this much lifetime is left. */
export const SESSION_REFRESH_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;
/** Cap on concurrent sessions per user; the oldest are pruned. */
export const MAX_SESSIONS_PER_USER = 20;

/** 32 random bytes, base64url without padding = 43 chars. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedSession {
  token: string;
  expiresAt: number;
}

/** Inserts a new session row for `userId` and returns the raw token (for the cookie). */
export function insertSession(userId: string, at: number = dbNow()): IssuedSession {
  const token = newSessionToken();
  const expiresAt = at + SESSION_TTL_MS;
  transaction(() => {
    // Opportunistic cleanup of this user's expired sessions and of the oldest beyond the cap.
    run("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?", userId, at);
    run(
      `DELETE FROM sessions WHERE user_id = ? AND id IN (
         SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, id LIMIT 1000000 OFFSET ?
       )`,
      userId,
      userId,
      MAX_SESSIONS_PER_USER - 1,
    );
    run(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      hashToken(token),
      userId,
      at,
      expiresAt,
    );
  });
  return { token, expiresAt };
}

export interface SessionLookup {
  user: PublicUser;
  sessionId: string;
  expiresAt: number;
  /** True when the caller should extend the session (and re-set the cookie). */
  shouldRefresh: boolean;
}

interface JoinedRow {
  session_id: string;
  expires_at: number;
  user_id: string;
  email: string;
  user_created_at: number;
}

/** Resolves a raw token to its user. Expired sessions are deleted and yield null. */
export function lookupSession(token: string | undefined | null, at: number = dbNow()): SessionLookup | null {
  if (!isWellFormedToken(token)) return null;
  const sessionId = hashToken(token);
  const row = get<JoinedRow>(
    `SELECT s.id AS session_id, s.expires_at AS expires_at,
            u.id AS user_id, u.email AS email, u.created_at AS user_created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    sessionId,
  );
  if (!row) return null;
  const expiresAt = Number(row.expires_at);
  if (expiresAt <= at) {
    run("DELETE FROM sessions WHERE id = ?", sessionId);
    return null;
  }
  return {
    user: { id: row.user_id, email: row.email, createdAt: Number(row.user_created_at) },
    sessionId,
    expiresAt,
    shouldRefresh: expiresAt - at < SESSION_REFRESH_THRESHOLD_MS,
  };
}

/** Pushes a session's expiry to at + TTL. Returns the new expiry, or null if it no longer exists. */
export function extendSession(sessionId: string, at: number = dbNow()): number | null {
  const expiresAt = at + SESSION_TTL_MS;
  const r = run("UPDATE sessions SET expires_at = ? WHERE id = ? AND expires_at > ?", expiresAt, sessionId, at);
  return r.changes > 0 ? expiresAt : null;
}

export function deleteSessionByToken(token: string | undefined | null): void {
  if (!isWellFormedToken(token)) return;
  run("DELETE FROM sessions WHERE id = ?", hashToken(token));
}

export function deleteSessionsForUser(userId: string): number {
  return run("DELETE FROM sessions WHERE user_id = ?", userId).changes;
}

/** Global cleanup; cheap thanks to idx_sessions_expires. */
export function purgeExpiredSessions(at: number = dbNow()): number {
  return run("DELETE FROM sessions WHERE expires_at <= ?", at).changes;
}
