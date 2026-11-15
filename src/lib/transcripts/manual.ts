import type { TranscriptSegment } from "@/lib/types";

/**
 * Pasted-transcript parser. Pure and dependency-free.
 *
 * Supported inputs:
 *  1. Lines prefixed with timestamps: "1:23 text", "01:02:03 - text", "[00:01:02] text", "(4:05) text",
 *     including YouTube's "Show transcript" copy format where the timestamp sits on its own line
 *     and the text follows on the next line(s).
 *  2. SRT / WebVTT cue blocks ("00:00:01,000 --> 00:00:04,000").
 *  3. Plain paragraphs: start times are synthesized at ~150 words per minute.
 */

export const WORDS_PER_MINUTE = 150;
const SECONDS_PER_WORD = 60 / WORDS_PER_MINUTE;
/** Target words per synthesized segment for plain text. */
const PLAIN_TARGET_WORDS = 30;
/** Hard cap so an unpunctuated wall of text still gets split. */
const PLAIN_MAX_WORDS = 60;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Parses "m:ss", "mm:ss", "h:mm:ss" (optionally with ".mmm" / ",mmm" fractions) into seconds.
 * Returns null when the value is malformed (e.g. seconds >= 60).
 */
export function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  const hours = h === undefined ? 0 : Number(h);
  const minutes = Number(mm);
  const seconds = Number(ss);
  if (seconds >= 60) return null;
  // With an hour part, minutes must be < 60; without one, "75:30" is a valid 75-minute mark.
  if (h !== undefined && minutes >= 60) return null;
  const fraction = frac === undefined ? 0 : Number(`0.${frac}`);
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function estimateDuration(text: string): number {
  return round2(Math.max(1, wordCount(text) * SECONDS_PER_WORD));
}

function normalize(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/ /g, " ");
}

// ---- timestamp-prefixed lines ----

/**
 * A leading timestamp, optionally wrapped in [] or (), followed by an optional separator.
 * Group 1 = timestamp; the text after the whole match is the rest of the line.
 *
 * ReDoS guard: the pattern runs on line.trimStart() (so there is no `^\s*` before the optional
 * bracket: two adjacent `\s*` around an optional token make a long run of whitespace quadratic)
 * and only on the first TS_HEAD_MAX characters, because a timestamp prefix is always near the
 * start. Matching cost is therefore bounded per line whatever the pasted text looks like.
 */
const LEADING_TS_RE =
  /^[[(]?\s*((?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?)\s*[\])]?(?:\s*(?:[-–—|>:]\s*)|\s+|$)/;
const TS_HEAD_MAX = 256;

interface TsLine {
  start: number;
  rest: string;
}

function matchLeadingTimestamp(line: string): TsLine | null {
  const trimmed = line.trimStart();
  const m = LEADING_TS_RE.exec(trimmed.slice(0, TS_HEAD_MAX));
  if (!m) return null;
  const start = parseTimestamp(m[1]);
  if (start === null) return null;
  return { start, rest: trimmed.slice(m[0].length) };
}

function finalizeTimed(raw: Array<{ start: number; text: string; end?: number }>): TranscriptSegment[] {
  const items = raw
    .map((r) => ({ ...r, text: cleanText(r.text) }))
    .filter((r) => r.text.length > 0)
    // Stable sort keeps original order for equal starts.
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.start - b.start || a.i - b.i);

  return items.map((item, idx) => {
    const next = items[idx + 1];
    let dur: number;
    if (item.end !== undefined && item.end > item.start) dur = item.end - item.start;
    else if (next) dur = Math.max(0, next.start - item.start);
    else dur = estimateDuration(item.text);
    return { start: round2(item.start), dur: round2(dur), text: item.text };
  });
}

function parseTimestampedLines(lines: string[]): TranscriptSegment[] {
  const out: Array<{ start: number; text: string }> = [];
  let current: { start: number; text: string } | null = null;
  for (const line of lines) {
    const ts = matchLeadingTimestamp(line);
    if (ts) {
      current = { start: ts.start, text: ts.rest };
      out.push(current);
    } else if (line.trim()) {
      if (!current) {
        // Preamble before the first timestamp belongs to the start of the video.
        current = { start: 0, text: "" };
        out.push(current);
      }
      current.text += ` ${line}`;
    }
  }
  return finalizeTimed(out);
}

// ---- SRT / VTT ----

const CUE_TIME = String.raw`((?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?)`;
const CUE_RE = new RegExp(String.raw`^\s*${CUE_TIME}\s*-->\s*${CUE_TIME}`);

function isCueFormat(lines: string[]): boolean {
  return lines.some((l) => CUE_RE.test(l));
}

function parseCues(lines: string[]): TranscriptSegment[] {
  const out: Array<{ start: number; end?: number; text: string }> = [];
  let current: { start: number; end?: number; text: string } | null = null;
  let inNote = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      current = null;
      inNote = false;
      continue;
    }
    if (inNote) continue;
    if (/^WEBVTT\b/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) {
      inNote = !/^WEBVTT\b/.test(line);
      continue;
    }
    const cue = CUE_RE.exec(line);
    if (cue) {
      const start = parseTimestamp(cue[1]);
      const end = parseTimestamp(cue[2]);
      if (start === null) {
        current = null;
        continue;
      }
      current = { start, end: end ?? undefined, text: "" };
      out.push(current);
      continue;
    }
    // SRT sequence number or VTT cue identifier directly before a timing line.
    if (!current && i + 1 < lines.length && CUE_RE.test(lines[i + 1])) continue;
    if (current) {
      // Strip VTT inline tags (<c>, <v Speaker>, <00:00:01.000>) and SRT formatting tags.
      // [^<>] (not [^>]) keeps this linear on a long run of "<" with no closing ">".
      current.text += ` ${line.replace(/<[^<>]*>/g, "")}`;
    }
  }
  // Auto-generated VTT repeats rolling lines; drop consecutive duplicates.
  const deduped = out.filter((c, i) => i === 0 || cleanText(c.text) !== cleanText(out[i - 1].text));
  return finalizeTimed(deduped);
}

// ---- plain text ----

function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…]["')\]]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePlain(text: string): TranscriptSegment[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => cleanText(p))
    .filter(Boolean);

  const chunks: string[] = [];
  for (const para of paragraphs) {
    let buf: string[] = [];
    let bufWords = 0;
    const flush = () => {
      if (buf.length) chunks.push(buf.join(" "));
      buf = [];
      bufWords = 0;
    };
    for (const sentence of splitSentences(para)) {
      const words = sentence.split(/\s+/);
      // Break overly long sentences into PLAIN_MAX_WORDS pieces.
      for (let i = 0; i < words.length; i += PLAIN_MAX_WORDS) {
        const piece = words.slice(i, i + PLAIN_MAX_WORDS);
        if (bufWords > 0 && bufWords + piece.length > PLAIN_MAX_WORDS) flush();
        buf.push(piece.join(" "));
        bufWords += piece.length;
        if (bufWords >= PLAIN_TARGET_WORDS) flush();
      }
    }
    flush(); // segments never span paragraphs
  }

  let cursor = 0;
  return chunks.map((chunk) => {
    const dur = round2(wordCount(chunk) * SECONDS_PER_WORD);
    const seg = { start: round2(cursor), dur, text: chunk };
    cursor += dur;
    return seg;
  });
}

// ---- entry point ----

/**
 * Parses a pasted transcript: plain text, or lines prefixed with timestamps like 1:23 / 01:02:03.
 * Returns [] for empty input. Segments are sorted by start time and have non-empty text.
 */
export function parseManualTranscript(text: string): TranscriptSegment[] {
  if (typeof text !== "string") return [];
  const normalized = normalize(text);
  if (!normalized.trim()) return [];
  const lines = normalized.split("\n");

  if (isCueFormat(lines)) {
    const cues = parseCues(lines);
    if (cues.length) return cues;
  }

  // Timestamp mode needs real evidence: two or more timestamped lines, or a transcript that
  // opens with one. A stray "3:16 is my favourite verse" in prose stays plain text.
  const nonEmpty = lines.filter((l) => l.trim());
  const tsCount = nonEmpty.reduce((n, l) => n + (matchLeadingTimestamp(l) ? 1 : 0), 0);
  const startsWithTs = nonEmpty.length > 0 && matchLeadingTimestamp(nonEmpty[0]) !== null;
  if (tsCount >= 2 || (tsCount === 1 && startsWithTs)) {
    const timed = parseTimestampedLines(lines);
    if (timed.length) return timed;
  }

  return parsePlain(normalized);
}
