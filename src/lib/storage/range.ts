/**
 * HTTP Range header parsing (RFC 9110 section 14), single byte range only.
 *
 *   none          no Range header, a non-"bytes" unit, or several ranges: serve the full body (200).
 *                 (Ignoring Range is always allowed; media elements only ever ask for one range.)
 *   range         a satisfiable single range: serve 206 with Content-Range: bytes start-end/size.
 *   unsatisfiable malformed bytes range, start beyond the end, or an empty file: 416 with
 *                 Content-Range: bytes * /size.
 *
 * Pure function, no I/O.
 */

export type RangeResult =
  | { type: "none" }
  | { type: "range"; start: number; end: number }
  | { type: "unsatisfiable" };

const MAX_DIGITS = 15; // < Number.MAX_SAFE_INTEGER

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (header === null || header === undefined) return { type: "none" };
  const value = header.trim();
  if (value === "") return { type: "none" };

  const eq = value.indexOf("=");
  if (eq < 0) return { type: "unsatisfiable" };
  const unit = value.slice(0, eq).trim().toLowerCase();
  if (unit !== "bytes") return { type: "none" };

  const specs = value
    .slice(eq + 1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (specs.length === 0) return { type: "unsatisfiable" };
  if (specs.length > 1) return { type: "none" };

  const m = /^(\d*)\s*-\s*(\d*)$/.exec(specs[0]);
  if (!m) return { type: "unsatisfiable" };
  const [, a, b] = m;
  if ((a === "" && b === "") || a.length > MAX_DIGITS || b.length > MAX_DIGITS) return { type: "unsatisfiable" };
  if (!Number.isSafeInteger(size) || size <= 0) return { type: "unsatisfiable" };

  if (a === "") {
    // Suffix range: the last N bytes.
    const n = Number(b);
    if (n === 0) return { type: "unsatisfiable" };
    return { type: "range", start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(a);
  if (start >= size) return { type: "unsatisfiable" };
  if (b === "") return { type: "range", start, end: size - 1 };
  const last = Number(b);
  if (last < start) return { type: "unsatisfiable" };
  return { type: "range", start, end: Math.min(last, size - 1) };
}

/** Value for the Content-Range header of a 206 response. */
export function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/** Value for the Content-Range header of a 416 response. */
export function unsatisfiedRange(size: number): string {
  return `bytes */${size}`;
}
