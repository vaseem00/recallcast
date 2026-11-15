import type { Chapter } from "@/lib/types";

/**
 * Chapter marks from a video description: the lines that begin (or end) with a timestamp, as
 * creators write them for YouTube's chapters ("0:00 Intro", "12:34 - Wiring", "(1:02:03) Q&A",
 * "Wiring - 12:34"). Pure, no I/O.
 *
 * Only an ascending run counts (a second list further down, or a tracklist of durations, is
 * mostly skipped by that), marks at or past the end of the video are dropped, and fewer than two
 * marks is no chapters at all.
 */

const MAX_CHAPTERS = 100;
const TITLE_MAX = 110;
const LINE_MAX = 300;

const STAMP = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})`;
/** Anything that is not a letter or a digit, before the stamp: bullets, brackets, emoji. */
const LEAD_RE = new RegExp(String.raw`^[^\p{L}\p{N}]*${STAMP}(?![\d:])(.*)$`, "u");
const TRAIL_RE = new RegExp(String.raw`^(.*?)(?<![\d:])${STAMP}[^\p{L}\p{N}]*$`, "u");

function seconds(h: string | undefined, m: string, s: string): number | null {
  const hh = h === undefined ? 0 : Number(h);
  const mm = Number(m);
  const ss = Number(s);
  if (![hh, mm, ss].every(Number.isInteger) || ss >= 60) return null;
  if (h !== undefined && mm >= 60) return null;
  return hh * 3600 + mm * 60 + ss;
}

function cleanTitle(text: string): string {
  const t = text
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:|•·.,)\]>»]+/u, "")
    .replace(/[\s\-–—:|•·,(\[<«]+$/u, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t) || /^https?:\/\//i.test(t)) return "";
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 3).trimEnd()}...` : t;
}

function readLine(line: string): Chapter | null {
  const lead = LEAD_RE.exec(line);
  if (lead) {
    const start = seconds(lead[1], lead[2], lead[3]);
    const title = cleanTitle(lead[4]);
    return start === null || !title ? null : { start, title };
  }
  const trail = TRAIL_RE.exec(line);
  if (trail) {
    const start = seconds(trail[2], trail[3], trail[4]);
    const title = cleanTitle(trail[1]);
    return start === null || !title ? null : { start, title };
  }
  return null;
}

export function parseChapters(description: string | null | undefined, durationS: number = 0): Chapter[] {
  if (typeof description !== "string" || !description) return [];
  const out: Chapter[] = [];
  let last = -1;
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > LINE_MAX) continue;
    const ch = readLine(line);
    if (!ch) continue;
    if (durationS > 0 && ch.start >= durationS) continue;
    if (ch.start <= last) continue;
    out.push(ch);
    last = ch.start;
    if (out.length >= MAX_CHAPTERS) break;
  }
  return out.length >= 2 ? out : [];
}

/** Reads stored chapters (videos.chapters_json). null when nothing was stored or it is unreadable. */
export function parseChaptersJson(json: string | null | undefined): Chapter[] | null {
  if (typeof json !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: Chapter[] = [];
  for (const c of value as Partial<Chapter>[]) {
    const start = Number(c?.start);
    if (!Number.isFinite(start) || start < 0 || typeof c?.title !== "string" || !c.title.trim()) continue;
    out.push({ start: Math.floor(start), title: c.title.trim().slice(0, TITLE_MAX) });
  }
  return out.sort((a, b) => a.start - b.start);
}
