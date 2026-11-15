import type { Chapter, MomentPlan, TranscriptSegment, VideoMeta } from "@/lib/types";
import { clipExcerpt, clipText, scoreWindow, videoLength, type ClipContext } from "./clip";
import { buildTranscriptBlocks, cleanCaptionText, type TranscriptBlock } from "./transcript";

/**
 * Reel windows. Pure, no I/O.
 *
 * A reel is one self-contained moment of the source video, about a minute long. A video gets
 * several, best first. Whatever proposes them (Claude or the heuristic below),
 * normalizeMoments() makes them valid: inside the video, between REEL_MIN_S and REEL_MAX_S
 * long, starting where a caption starts and ending where one ends, and not overlapping.
 */

/** Shortest reel we accept. */
export const REEL_MIN_S = 30;
/** Length the heuristic and the prompt aim for. */
export const REEL_TARGET_S = 60;
/** Longest reel we accept (a minute plus room to finish the sentence). */
export const REEL_MAX_S = 80;
/** One reel per this many seconds of video. */
export const SECONDS_PER_REEL = 300;
/** Upper bound on reels per video, whatever its length (REELS_PER_VIDEO_MAX lowers it). */
export const MAX_REELS_PER_VIDEO = 12;
/** Two reels may share at most this many seconds. */
export const MAX_OVERLAP_S = 8;
/** Transcript block length for reels: short, so a reel can start close to its first sentence. */
export const MOMENT_BLOCK_SECONDS = 10;

export interface MomentInput {
  start: number;
  end: number;
  hook?: string;
  takeaway?: string;
}

const HOOK_MAX = 110;
const TAKEAWAY_MAX = 280;

/** How many reels a video of this length gets: one per five minutes, at least 1, at most `max`. */
export function momentCount(lengthS: number, max: number = 6): number {
  const cap = Math.max(1, Math.min(MAX_REELS_PER_VIDEO, Math.floor(Number(max) || 1)));
  if (!Number.isFinite(lengthS) || lengthS <= REEL_MAX_S) return 1;
  return Math.max(1, Math.min(cap, Math.round(lengthS / SECONDS_PER_REEL)));
}

/** True when the whole video fits in one reel. */
export function isReelLengthVideo(ctx: ClipContext): boolean {
  const len = videoLength(ctx);
  return len > 0 && len <= REEL_MAX_S;
}

function sortedSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((s) => Number.isFinite(s.start) && s.start >= 0 && cleanCaptionText(s.text).length > 0)
    .slice()
    .sort((a, b) => a.start - b.start);
}

/**
 * A headline from the words spoken: the first sentence when the captions are punctuated,
 * otherwise the first few words.
 */
export function hookFromExcerpt(excerpt: string): string {
  // Captions mark a change of speaker with a leading dash or chevrons; a headline has no use for it.
  const text = cleanCaptionText(excerpt).replace(/^(?:[-–—]+|>+)\s*/, "");
  if (!text) return "";
  const sentence = /^(.{12,100}?[.!?])(\s|$)/.exec(text)?.[1];
  if (sentence) return sentence;
  const w = text.split(" ");
  return w.length <= 10 ? text : `${w.slice(0, 10).join(" ")}...`;
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.min(a.end, b.end) - Math.max(a.start, b.start);

/**
 * Makes proposed moments valid for this video, keeping their order (best first). Unusable ones
 * are dropped, never invented. `notes` says what had to change; callers decide what matters.
 */
export function normalizeMoments(
  inputs: readonly MomentInput[],
  ctx: ClipContext,
  picked: MomentPlan["picked"],
  count: number,
): { moments: MomentPlan[]; notes: string[] } {
  const notes: string[] = [];
  const length = videoLength(ctx);
  const segs = sortedSegments(ctx.segments);
  const limit = Math.max(1, Math.min(MAX_REELS_PER_VIDEO, Math.floor(Number(count) || 1)));
  const out: MomentPlan[] = [];

  if (length > 0 && length <= REEL_MAX_S) {
    const first = inputs[0];
    return { moments: [wholeMoment(ctx, first)], notes };
  }

  (inputs ?? []).forEach((input, i) => {
    const label = `moment ${i + 1}`;
    if (out.length >= limit) return;
    let start = Number(input?.start);
    let end = Number(input?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      notes.push(`${label}: start or end was not a number`);
      return;
    }
    if (end < start) [start, end] = [end, start];
    if (start < 0) start = 0;
    if (length > 0 && start > length - REEL_MIN_S) {
      notes.push(`${label}: it started in the last ${REEL_MIN_S} seconds of the video`);
      return;
    }

    // Start on the caption that contains the proposed start (or the last one before it).
    if (segs.length) {
      let snapped = segs[0].start;
      for (const s of segs) {
        if (s.start <= start + 0.5) snapped = s.start;
        else break;
      }
      start = snapped;
    }

    const span = end - start;
    if (span < REEL_MIN_S) {
      notes.push(`${label}: ${Math.round(span)} seconds is shorter than ${REEL_MIN_S}`);
      end = start + REEL_TARGET_S;
    } else if (span > REEL_MAX_S) {
      notes.push(`${label}: ${Math.round(span)} seconds is longer than ${REEL_MAX_S}`);
      end = start + REEL_TARGET_S;
    }

    // End where the caption it falls in ends, but never past REEL_MAX_S. An end that sits
    // exactly on the start of a caption (what the prompt asks for: the first line after the
    // moment) already is a boundary, so that next caption is not pulled in.
    if (segs.length) {
      const containing = [...segs].reverse().find((s) => s.start < end);
      if (containing) {
        const segEnd = containing.start + Math.max(0, containing.dur);
        if (segEnd >= end && segEnd - start <= REEL_MAX_S) end = segEnd;
      }
    }
    if (length > 0) end = Math.min(end, length);

    start = Math.max(0, Math.floor(start));
    end = Math.max(start + 1, Math.ceil(end));
    if (end - start < REEL_MIN_S) {
      notes.push(`${label}: too little of the video was left after it started`);
      return;
    }

    const clash = out.find((m) => overlap(m, { start, end }) > MAX_OVERLAP_S);
    if (clash) {
      notes.push(`${label}: it overlapped an earlier moment`);
      return;
    }

    const excerpt = clipExcerpt(ctx.segments, start, end, 40);
    const hook = clipText(input.hook, HOOK_MAX) || hookFromExcerpt(excerpt) || clipText(ctx.video.title, HOOK_MAX);
    if (!clipText(input.hook, HOOK_MAX)) notes.push(`${label}: the hook was empty`);
    if (!hook) return;
    out.push({ start, end, hook, takeaway: clipText(input.takeaway, TAKEAWAY_MAX), picked });
  });

  return { moments: out, notes };
}

/** The whole video as one reel (videos of about a minute or less). */
export function wholeMoment(ctx: ClipContext, labels?: Pick<MomentInput, "hook" | "takeaway">): MomentPlan {
  const length = Math.max(1, videoLength(ctx));
  return {
    start: 0,
    end: length,
    hook: clipText(labels?.hook, HOOK_MAX) || clipText(ctx.video.title, HOOK_MAX) || "Untitled video",
    takeaway: clipText(labels?.takeaway, TAKEAWAY_MAX) || clipExcerpt(ctx.segments, 0, length, 30),
    picked: "whole",
  };
}

// ---------------------------------------------------------------------------
// Heuristic picker (free): the densest non-overlapping minutes
// ---------------------------------------------------------------------------

/** Fewest spoken words a minute must hold to be offered as a reel. */
const MIN_WINDOW_WORDS = 60;
/** How far the heuristic may move a window's start forward to begin on a sentence. */
const SENTENCE_SEARCH_S = 12;

/**
 * The start of the first sentence at or shortly after `start`: the first caption that follows
 * one ending in a full stop, question mark or exclamation mark. Captions without punctuation
 * (most auto-generated ones) have no such caption, and `start` is returned unchanged.
 */
export function sentenceStart(segments: TranscriptSegment[], start: number, maxShift: number = SENTENCE_SEARCH_S): number {
  const segs = sortedSegments(segments);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.start < start - 0.5) continue;
    if (s.start > start + maxShift) break;
    const prev = segs[i - 1];
    if (!prev || /[.!?]["')\]]*$/.test(cleanCaptionText(prev.text))) return s.start;
  }
  return start;
}

/**
 * Picks up to `count` dense, non-overlapping REEL_TARGET_S windows, best first. Deterministic.
 * Returns [] when the transcript holds no window with enough speech.
 */
export function heuristicMoments(ctx: ClipContext, count: number): MomentPlan[] {
  if (isReelLengthVideo(ctx)) return [wholeMoment(ctx)];
  const length = videoLength(ctx);
  const blocks = buildTranscriptBlocks(ctx.segments, { maxBlockSeconds: MOMENT_BLOCK_SECONDS });
  if (blocks.length === 0) return [];

  const candidates: { start: number; score: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const from = blocks[i].start;
    if (length > 0 && from > length - REEL_MIN_S) break;
    const window: TranscriptBlock[] = [];
    for (let j = i; j < blocks.length && blocks[j].start < from + REEL_TARGET_S; j++) window.push(blocks[j]);
    const score = scoreWindow(window, length, MIN_WINDOW_WORDS);
    if (Number.isFinite(score)) candidates.push({ start: from, score });
  }
  // Best first; ties go to the earlier window so the result is stable.
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);

  const limit = Math.max(1, Math.min(MAX_REELS_PER_VIDEO, Math.floor(Number(count) || 1)));
  const chosen: MomentInput[] = [];
  for (const c of candidates) {
    if (chosen.length >= limit) break;
    // A reel that opens mid-sentence loses the viewer: begin on the next sentence when there is one.
    const from = sentenceStart(ctx.segments, c.start);
    const window = { start: from, end: from + REEL_TARGET_S };
    // Leave a gap as well: two reels that touch feel like one cut in half.
    if (chosen.some((k) => overlap(k, window) > -MOMENT_BLOCK_SECONDS)) continue;
    chosen.push({
      ...window,
      hook: hookFromExcerpt(clipExcerpt(ctx.segments, window.start, window.end, 40)),
      takeaway: "",
    });
  }
  return normalizeMoments(chosen, ctx, "heuristic", limit).moments;
}

// ---------------------------------------------------------------------------
// No captions: reels from the creator's chapter marks, or from the video's position
// ---------------------------------------------------------------------------

/** Chapters a reel should not open on: the intro, the outro, the sponsor read, the plugs. */
const FILLER_CHAPTER_RE =
  /\b(intro|introduction|outro|ending|end screen|end card|credits|sponsors?|sponsored|ad|ads|advert|patreon|merch|subscribe|thanks|thank you|bloopers|shout ?outs?|channel update|giveaway)\b/i;
/** Where a minute picked by position starts: just after the intro, as the default episode does. */
const POSITION_START_FRACTION = 0.1;

/**
 * Reels for a video with no transcript, cut at the creator's chapter marks: each reel starts
 * where a chapter starts and is titled with it. Long, substantive chapters first; intros,
 * sponsor reads and outros only when nothing else is left. Deterministic. [] when the chapters
 * give no usable window.
 */
export function chapterMoments(video: VideoMeta, chapters: readonly Chapter[], count: number): MomentPlan[] {
  const length = Math.max(0, Number(video.durationS) || 0);
  const marks = chapters
    .filter((c) => Number.isFinite(c.start) && c.start >= 0 && (length === 0 || c.start < length - REEL_MIN_S))
    .slice()
    .sort((a, b) => a.start - b.start);
  if (marks.length === 0) return [];

  const candidates = marks.map((c, i) => {
    const next = marks[i + 1]?.start ?? (length > 0 ? length : c.start + REEL_TARGET_S);
    const span = Math.max(0, next - c.start);
    // 0..1 by length; below 0 for chapters to use only when nothing else is left.
    let score = Math.min(span, 300) / 300;
    if (FILLER_CHAPTER_RE.test(c.title)) score -= 2;
    else if (i === 0 && span < 90) score -= 0.3; // a short first chapter is usually the intro
    const reel = Math.max(REEL_MIN_S, Math.min(REEL_TARGET_S, span));
    const start = Math.floor(c.start);
    const end = Math.ceil(length > 0 ? Math.min(length, start + reel) : start + reel);
    return { start, end, title: c.title, score };
  });
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);

  const limit = Math.max(1, Math.min(MAX_REELS_PER_VIDEO, Math.floor(Number(count) || 1)));
  const out: MomentPlan[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (c.end - c.start < REEL_MIN_S) continue;
    if (c.score < 0 && out.length > 0) continue; // filler only when nothing else was usable
    if (out.some((m) => overlap(m, c) > MAX_OVERLAP_S)) continue;
    const hook = clipText(c.title, HOOK_MAX) || clipText(video.title, HOOK_MAX);
    if (!hook) continue;
    out.push({ start: c.start, end: c.end, hook, takeaway: "", picked: "heuristic", basis: "chapters" });
  }
  return out;
}

/**
 * One reel for a video with neither a transcript nor chapters: a minute from just after the
 * intro (the whole video when it is about a minute long), titled with the video's title.
 */
export function positionMoment(video: VideoMeta): MomentPlan {
  const length = Math.max(0, Number(video.durationS) || 0);
  const hook = clipText(video.title, HOOK_MAX) || "Untitled video";
  if (length > 0 && length <= REEL_MAX_S) {
    return { start: 0, end: length, hook, takeaway: "", picked: "whole", basis: "position" };
  }
  const start = length > 0 ? Math.min(Math.round(length * POSITION_START_FRACTION), Math.max(0, length - REEL_TARGET_S)) : 0;
  const end = length > 0 ? Math.min(length, start + REEL_TARGET_S) : start + REEL_TARGET_S;
  return { start, end, hook, takeaway: "", picked: "heuristic", basis: "position" };
}

/**
 * The reels of a video without a transcript: from its chapter marks when it has usable ones
 * (up to one per five minutes, like transcript reels), otherwise one minute by position.
 * Never empty, so every ready video has at least one reel in the feed.
 */
export function noCaptionMoments(video: VideoMeta, chapters: readonly Chapter[] | null | undefined, max: number = 6): MomentPlan[] {
  const length = Math.max(0, Number(video.durationS) || 0);
  if (length > 0 && length <= REEL_MAX_S) return [positionMoment(video)];
  const fromChapters = chapters && chapters.length >= 2 ? chapterMoments(video, chapters, momentCount(length, max)) : [];
  return fromChapters.length > 0 ? fromChapters : [positionMoment(video)];
}
