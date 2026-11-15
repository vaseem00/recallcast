import type { TranscriptSegment } from "@/lib/types";

/**
 * Parsers for YouTube's timedtext caption payloads (used as a fallback when the
 * transcript panel is unavailable). Pure functions; never throw on bad input.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  // Two passes: timedtext XML often double-escapes ("&amp;#39;").
  let out = input;
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
      if (ent[0] === "#") {
        const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
    });
  }
  return out;
}

/** Collapses whitespace and removes zero-width marks. Does not touch angle brackets. */
export function cleanCaptionText(text: string): string {
  return text
    .replace(/[​‎‏]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Parses timedtext `fmt=json3`: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }. */
export function parseJson3(body: unknown): TranscriptSegment[] {
  if (!body || typeof body !== "object") return [];
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const out: TranscriptSegment[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown };
    if (!finite(e.tStartMs) || !Array.isArray(e.segs)) continue;
    const text = cleanCaptionText(
      e.segs.map((s) => (s && typeof s === "object" && typeof s.utf8 === "string" ? s.utf8 : "")).join(""),
    );
    if (!text) continue;
    out.push({
      start: round2(e.tStartMs / 1000),
      dur: round2(finite(e.dDurationMs) ? Math.max(0, e.dDurationMs) / 1000 : 0),
      text,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Parses timedtext XML in either legacy format (`<text start="1.2" dur="3.4">`, seconds)
 * or srv3 format (`<p t="1200" d="3400">`, milliseconds, optional nested `<s>` spans).
 */
export function parseTimedTextXml(xml: string): TranscriptSegment[] {
  if (typeof xml !== "string" || !xml) return [];
  const out: TranscriptSegment[] = [];

  const attr = (attrs: string, name: string): number | null => {
    const m = new RegExp(String.raw`(?:^|\s)${name}="([\d.]+)"`).exec(attrs);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  const legacy = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (let m = legacy.exec(xml); m; m = legacy.exec(xml)) {
    const start = attr(m[1], "start");
    if (start === null) continue;
    // Strip raw markup first, then decode, so encoded "&lt;" text survives as a literal "<".
    const text = cleanCaptionText(decodeEntities(m[2].replace(/<[^>]*>/g, "")));
    if (!text) continue;
    out.push({ start: round2(start), dur: round2(attr(m[1], "dur") ?? 0), text });
  }

  if (out.length === 0) {
    const srv3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    for (let m = srv3.exec(xml); m; m = srv3.exec(xml)) {
      const t = attr(m[1], "t");
      if (t === null) continue;
      const text = cleanCaptionText(decodeEntities(m[2].replace(/<[^>]*>/g, "")));
      if (!text) continue;
      out.push({ start: round2(t / 1000), dur: round2((attr(m[1], "d") ?? 0) / 1000), text });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
