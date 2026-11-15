import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isProd } from "@/lib/env";
import { HttpError } from "@/lib/http";
import type { PublicUser } from "@/lib/types";
import {
  deleteSessionByToken,
  extendSession,
  insertSession,
  lookupSession,
  SESSION_TTL_MS,
} from "./session";

/**
 * Auth module (see docs/spec.md "MODULE INTERFACES").
 *
 * - Passwords: scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte salt), timing-safe verify.
 * - Sessions: random 32-byte token in an httpOnly, SameSite=Lax cookie (Secure in prod);
 *   the DB stores only sha256(token). 30-day lifetime with sliding refresh.
 * - Next.js 16: cookies() is async. Cookies can only be WRITTEN in route handlers and
 *   server functions; in server components the sliding refresh is skipped silently.
 *
 * Route handlers:     const user = await requireUser();      // throws HttpError(401)
 * Server components:  const user = await requireUserPage();  // redirects to /login
 */

export const SESSION_COOKIE = "rc_session";

export { hashPassword, verifyPassword, PASSWORD_MIN, PASSWORD_MAX } from "./password";
export { assertSameOrigin } from "./origin";
export { authenticate } from "./login";
export { createUser, EmailTakenError, signupSchema, loginSchema, emailSchema } from "./users";
export { getAuthLimiters, clientIp, ipKey, RateLimiter } from "./rate-limit";
export { DEVICE_COOKIE, rememberDevice, requestIsKnownDevice } from "./device";
export { deleteSessionsForUser, purgeExpiredSessions } from "./session";

export function sessionCookieOptions(expiresAt: number, at: number = Date.now()) {
  return {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt - at) / 1000)),
  };
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function readToken(store: CookieStore): string | undefined {
  return store.get(SESSION_COOKIE)?.value;
}

function clearCookie(store: CookieStore): void {
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
}

/**
 * Creates a session row and sets the rc_session cookie. Any session already named by
 * the incoming cookie is revoked first (no lingering pre-login session).
 * Must be called from a route handler or server function.
 */
export async function createSession(userId: string): Promise<void> {
  const store = await cookies();
  const previous = readToken(store);
  if (previous) deleteSessionByToken(previous);
  const at = Date.now();
  const { token, expiresAt } = insertSession(userId, at);
  store.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt, at));
}

/** The signed-in user from the rc_session cookie, or null. */
export async function getCurrentUser(): Promise<PublicUser | null> {
  const store = await cookies();
  const token = readToken(store);
  if (!token) return null;
  const at = Date.now();
  const found = lookupSession(token, at);
  if (!found) return null;
  if (found.shouldRefresh) {
    const newExpiry = at + SESSION_TTL_MS;
    let cookieWritten = false;
    try {
      store.set(SESSION_COOKIE, token, sessionCookieOptions(newExpiry, at));
      cookieWritten = true;
    } catch {
      // Server component render: cookies are read-only. Refresh on the next API call instead.
    }
    if (cookieWritten) extendSession(found.sessionId, at);
  }
  return found.user;
}

/** For route handlers: the signed-in user, or throws HttpError(401) (handleError -> 401 JSON). */
export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Not signed in");
  return user;
}

/** For server components / pages: the signed-in user, or redirects to /login (?next=). */
export async function requireUserPage(nextPath?: string): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) {
    const safeNext = nextPath && nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : null;
    redirect(safeNext ? `/login?next=${encodeURIComponent(safeNext)}` : "/login");
  }
  return user;
}

/** 401 JSON response helper for handlers that prefer returning over throwing. */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Not signed in" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Deletes the current session row and clears the cookie. Safe to call when signed out. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = readToken(store);
  if (token) deleteSessionByToken(token);
  clearCookie(store);
}
