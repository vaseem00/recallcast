const ISO_DURATION_RE =
  /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parses an ISO-8601 duration as used by the YouTube Data API (contentDetails.duration),
 * e.g. "PT1H2M3S", "PT45S", "P1DT2H", "P0D". Returns whole seconds (rounded), or null when
 * the string is not a valid duration. Years/months are not used by YouTube and are rejected.
 */
export function parseIsoDuration(input: string | null | undefined): number | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toUpperCase();
  const m = ISO_DURATION_RE.exec(value);
  if (!m) return null;
  // "P" and "PT" alone are invalid.
  if (m.slice(1).every((g) => g === undefined)) return null;
  const [w, d, h, min, s] = m.slice(1).map((g) => (g === undefined ? 0 : Number(g)));
  const total = w * 604800 + d * 86400 + h * 3600 + min * 60 + s;
  return Number.isFinite(total) ? Math.round(total) : null;
}
