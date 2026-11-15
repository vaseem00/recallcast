import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { isProd } from "@/lib/env";

/**
 * "Known device" cookie for the login limiter.
 *
 * The per-email login limiter (all IPs together) stops distributed guessing, but on its own it
 * lets anyone lock an account by failing on purpose. A browser that has signed in to (or signed
 * up for) the account carries rc_device = HMAC(process key, email), and login does not hold such
 * a browser back on the per-email limit (the per-IP and per-IP+email limits still apply).
 *
 * The key is random per process, like the in-memory limiters it complements: after a restart
 * old cookies stop matching, and the counters they bypass are empty again anyway.
 */

export const DEVICE_COOKIE = "rc_device";
const MAX_AGE_S = 180 * 24 * 60 * 60;

const KEY = "__recallcastDeviceKey" as const;
type G = typeof globalThis & { [KEY]?: Buffer };

function key(): Buffer {
  const g = globalThis as G;
  if (!g[KEY]) g[KEY] = crypto.randomBytes(32);
  return g[KEY];
}

export function deviceToken(email: string): string {
  return crypto.createHmac("sha256", key()).update(`device|${email.trim().toLowerCase()}`).digest("base64url");
}

export function isKnownDevice(token: string | undefined | null, email: string): boolean {
  if (!token) return false;
  const expected = Buffer.from(deviceToken(email));
  const got = Buffer.from(token);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** Reads the rc_device cookie of the current request and checks it against `email`. */
export async function requestIsKnownDevice(email: string): Promise<boolean> {
  const store = await cookies();
  return isKnownDevice(store.get(DEVICE_COOKIE)?.value, email);
}

/** Sets rc_device for `email` (route handlers only). */
export async function rememberDevice(email: string): Promise<void> {
  const store = await cookies();
  store.set(DEVICE_COOKIE, deviceToken(email), {
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/api/auth",
    maxAge: MAX_AGE_S,
  });
}
