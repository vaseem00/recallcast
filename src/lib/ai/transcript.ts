import type { TranscriptSegment } from "@/lib/types";

/**
 * Transcript -> prompt text. Pure, no I/O.
 *
 * Captions arrive as many tiny segments (2-5 s each). Putting a marker on every one wastes tokens,
 * so consecutive segments are grouped into short blocks (<= ~20 s / ~400 chars), each line starting
 * with the block's [mm:ss] (or [h:mm:ss]) marker. The model copies those markers into sourceStart
 * values, so every timestamp it returns points at a real passage.
 */

export const MAX_BLOCK_SECONDS = 20;
export const MAX_BLOCK_CHARS = 400;
/** Formatted transcripts longer than this are split into chunks, extracted separately, then merged. */
export const MAX_TRANSCRIPT_CHARS = 400_000;

export interface TranscriptBlock {
  /** Start in whole seconds. */
  start: number;
  text: string;
  /** The formatted line, e.g. "[01:23] some words". */
  line: string;
}

/** 83 -> "01:23", 3723 -> "1:02:03". Negative / non-finite input -> "00:00". */
export function formatTimestamp(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

/**
 * Normalizes caption text for the prompt: decodes common HTML entities, removes angle brackets
 * (so transcript text can never close or open the <transcript> wrapper tag), collapses whitespace.
 */
export function cleanCaptionText(text: string): string {
  return String(text ?? "")
    .replace(/&(?:amp|quot|#39|apos|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits overly long segments (e.g. a pasted wall of text) into pieces with interpolated starts. */
function splitLongSegments(segments: TranscriptSegment[], maxChars: number): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const text = cleanCaptionText(seg.text);
    if (!text) continue;
    const start = Number.isFinite(seg.start) ? Math.max(0, seg.start) : 0;
    const dur = Number.isFinite(seg.dur) ? Math.max(0, seg.dur) : 0;
    if (text.length <= maxChars) {
      out.push({ start, dur, text });
      continue;
    }
    const words = text.split(" ");
    const pieces: string[] = [];
    let buf = "";
    for (const word of words) {
      // A single absurdly long "word" is hard-cut so no piece exceeds maxChars.
      for (let w = word; w.length > 0; w = w.slice(maxChars)) {
        const part = w.slice(0, maxChars);
        if (buf && buf.length + 1 + part.length > maxChars) {
          pieces.push(buf);
          buf = "";
        }
        buf = buf ? `${buf} ${part}` : part;
      }
    }
    if (buf) pieces.push(buf);
    let offset = 0;
    for (const piece of pieces) {
      const frac = offset / text.length;
      out.push({ start: start + dur * frac, dur: dur * (piece.length / text.length), text: piece });
      offset += piece.length + 1;
    }
  }
  return out;
}

/** Groups segments into marker-prefixed blocks, in start order. */
export function buildTranscriptBlocks(
  segments: TranscriptSegment[],
  opts: { maxBlockSeconds?: number; maxBlockChars?: number } = {},
): TranscriptBlock[] {
  const maxSeconds = opts.maxBlockSeconds ?? MAX_BLOCK_SECONDS;
  const maxChars = opts.maxBlockChars ?? MAX_BLOCK_CHARS;
  const sorted = splitLongSegments(segments, maxChars)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.start - b.s.start || a.i - b.i)
    .map(({ s }) => s);

  const blocks: TranscriptBlock[] = [];
  let curStart = 0;
  let curText = "";
  const flush = () => {
    if (!curText) return;
    const start = Math.floor(curStart);
    blocks.push({ start, text: curText, line: `[${formatTimestamp(start)}] ${curText}` });
    curText = "";
  };
  for (const seg of sorted) {
    if (curText && (seg.start - curStart >= maxSeconds || curText.length + 1 + seg.text.length > maxChars)) {
      flush();
    }
    if (!curText) {
      curStart = seg.start;
      curText = seg.text;
    } else {
      curText = `${curText} ${seg.text}`;
    }
  }
  flush();
  return blocks;
}

/**
 * Full transcript as prompt text: one "[mm:ss] text" line per block. Shorter blocks give the
 * model more markers to start and end on, at a few more tokens per minute of video.
 */
export function formatTranscript(
  segments: TranscriptSegment[],
  opts: { maxBlockSeconds?: number; maxBlockChars?: number } = {},
): string {
  return buildTranscriptBlocks(segments, opts)
    .map((b) => b.line)
    .join("\n");
}

export interface TranscriptChunk {
  index: number;
  /** Start of the chunk's first block, whole seconds. */
  start: number;
  /** Start of the chunk's last block, whole seconds. */
  end: number;
  text: string;
}

/**
 * Splits the formatted transcript into chunks of at most `maxChars` characters, on block
 * boundaries. Short transcripts return a single chunk. Empty input returns [].
 */
export function chunkTranscript(segments: TranscriptSegment[], maxChars = MAX_TRANSCRIPT_CHARS): TranscriptChunk[] {
  const blocks = buildTranscriptBlocks(segments, { maxBlockChars: Math.min(MAX_BLOCK_CHARS, Math.max(20, maxChars - 20)) });
  const chunks: TranscriptChunk[] = [];
  let lines: string[] = [];
  let len = 0;
  let start = 0;
  let end = 0;
  const flush = () => {
    if (!lines.length) return;
    chunks.push({ index: chunks.length, start, end, text: lines.join("\n") });
    lines = [];
    len = 0;
  };
  for (const block of blocks) {
    const add = block.line.length + (lines.length ? 1 : 0);
    if (lines.length && len + add > maxChars) flush();
    if (!lines.length) start = block.start;
    lines.push(block.line);
    len += block.line.length + (lines.length > 1 ? 1 : 0);
    end = block.start;
  }
  flush();
  return chunks;
}

/** Last moment the transcript covers (max start+dur), in seconds; 0 for empty input. */
export function transcriptEnd(segments: TranscriptSegment[]): number {
  let max = 0;
  for (const s of segments) {
    const e = (Number.isFinite(s.start) ? s.start : 0) + (Number.isFinite(s.dur) ? s.dur : 0);
    if (e > max) max = e;
  }
  return max;
}
