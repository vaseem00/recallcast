import "server-only";
import { getEnv } from "@/lib/env";
import { HttpError } from "@/lib/http";

/**
 * CSRF defence for cookie-authenticated mutating routes.
 *
 * Rules for non-safe methods (anything but GET/HEAD/OPTIONS):
 * 1. If an Origin header is present it must equal an allowed origin
 *    ("null" and malformed values are rejected).
 * 2. Else if Sec-Fetch-Site is present it must be "same-origin" or "none".
 * 3. Else if a Referer is present its origin must be allowed.
 * 4. Else (no browser signals at all, e.g. curl) the request is allowed: a browser
 *    making a cross-site request always sends at least Origin or Sec-Fetch-Site.
 *
 * Allowed origins: APP_URL's origin (when set), the request URL's origin, and the
 * origin built from Host / X-Forwarded-Host + X-Forwarded-Proto. A cross-site
 * attacker cannot control the victim browser's Host header, so this is safe.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function firstHeaderValue(v: string | null): string | null {
  const first = v?.split(",")[0]?.trim();
  return first ? first : null;
}

export function allowedOrigins(req: Request): Set<string> {
  const out = new Set<string>();
  let appUrl: string | undefined;
  try {
    appUrl = getEnv().APP_URL;
  } catch {
    appUrl = undefined;
  }
  if (appUrl) {
    const o = originOf(appUrl);
    if (o) out.add(o);
  }
  const urlOrigin = originOf(req.url);
  if (urlOrigin) out.add(urlOrigin);

  let reqProto = "http";
  try {
    reqProto = new URL(req.url).protocol.replace(":", "");
  } catch {
    /* keep default */
  }
  const proto = (firstHeaderValue(req.headers.get("x-forwarded-proto")) ?? reqProto).toLowerCase();
  for (const host of [
    firstHeaderValue(req.headers.get("x-forwarded-host")),
    firstHeaderValue(req.headers.get("host")),
  ]) {
    if (!host) continue;
    const o = originOf(`${proto === "https" ? "https" : "http"}://${host}`);
    if (o) out.add(o);
  }
  return out;
}

/** Throws HttpError(403) when a mutating request does not come from this site. */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;

  const origin = req.headers.get("origin");
  if (origin !== null) {
    const o = origin.trim() === "null" ? null : originOf(origin.trim());
    if (!o || !allowedOrigins(req).has(o)) throw new HttpError(403, "Cross-origin request rejected");
    return;
  }

  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) {
    if (site === "same-origin" || site === "none") return;
    throw new HttpError(403, "Cross-origin request rejected");
  }

  const referer = req.headers.get("referer");
  if (referer) {
    const o = originOf(referer);
    if (!o || !allowedOrigins(req).has(o)) throw new HttpError(403, "Cross-origin request rejected");
  }
}
