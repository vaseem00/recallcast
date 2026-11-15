import "server-only";
import { getEnv } from "@/lib/env";

/**
 * The absolute address of a path on this site, or null when APP_URL is not set. Canonical links,
 * robots.txt and the sitemap need absolute addresses; without APP_URL they are left out rather
 * than guessed from request headers, which a client controls.
 */
export function siteUrl(path = "/"): string | null {
  const base = getEnv().APP_URL;
  return base ? new URL(path, base).toString() : null;
}
