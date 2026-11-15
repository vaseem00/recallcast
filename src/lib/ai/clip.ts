import type { ClipPlan, TranscriptSegment, VideoMeta } from "@/lib/types";
import { buildTranscriptBlocks, cleanCaptionText, transcriptEnd, type TranscriptBlock } from "./transcript";

/**
 * Clip windows. Pure, no I/O.
 *
 * An episode is one 3-4 minute part of the source video. Whatever proposes the window (Claude,
 * the heuristic below, or a default), normalizeClip() makes it valid: inside the video, between
 * CLIP_MIN_S and CLIP_MAX_S long, starting where a caption starts and ending where one ends, so
 * playback never begins or stops mid-sentence.
 */

/** Shortest clip we accept (2.5 min). */
export const CLIP_MIN_S = 150;
/** Length the heuristic and the prompt aim for (3.5 min). */
export const CLIP_TARGET_S = 210;
/** Longest clip we accept (4.25 min: 4 minutes plus room to finish the sentence). */
export const CLIP_MAX_S = 255;
/** Videos up to this long are played in full: no analysis, no AI call. */
export const WHOLE_VIDEO_MAX_S = 270;

export interface ClipInput {
  start: number;
  end: number;
  title?: string;
  summary?: string;
  reason?: string;
}

export interface ClipContext {
  video: VideoMeta;
  segments: TranscriptSegment[];
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);

function firstWords(s: string, n: number): string {
  const w = words(s);
  return w.length <= n ? w.join(" ") : `${w.slice(0, n).join(" ")}...`;
}

/** Text fields: cleaned, single line, capped. */
export function clipText(s: unknown, max: number): string {
  return cleanCaptionText(typeof s === "string" ? s : "").slice(0, max).trim();
}

/** Length of the video in seconds: its stated duration, else where the transcript ends. */
export function videoLength(ctx: ClipContext): number {
  const stated = Number(ctx.video.durationS) || 0;
  const fromTranscript = Math.ceil(transcriptEnd(ctx.segments));
  return Math.max(stated, fromTranscript);
}

/** True when the whole video fits in one episode. */
export function isShortVideo(ctx: ClipContext): boolean {
  const len = videoLength(ctx);
  return len > 0 && len <= WHOLE_VIDEO_MAX_S;
}

function sortedSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((s) => Number.isFinite(s.start) && s.start >= 0 && cleanCaptionText(s.text).length > 0)
    .slice()
    .sort((a, b) => a.start - b.start);
}

/**
 * Makes any proposed window valid for this video. Returns the clip plus notes describing what
 * had to change (empty when the proposal was already fine); callers decide whether a note
 * matters.
 */
export function normalizeClip(
  input: ClipInput,
  ctx: ClipContext,
  picked: ClipPlan["picked"],
): { clip: ClipPlan; notes: string[] } {
  const notes: string[] = [];
  const length = videoLength(ctx);
  const segs = sortedSegments(ctx.segments);

  let start = Number(input.start);
  let end = Number(input.end);
  if (!Number.isFinite(start)) {
    notes.push("start was not a number");
    start = 0;
  }
  if (!Number.isFinite(end)) {
    notes.push("end was not a number");
    end = start + CLIP_TARGET_S;
  }
  if (end < start) {
    notes.push("end was before start");
    [start, end] = [end, start];
  }

  if (length > 0 && length <= WHOLE_VIDEO_MAX_S) {
    start = 0;
    end = length;
  } else {
    if (start < 0) start = 0;
    if (length > 0 && start > length - CLIP_MIN_S) {
      notes.push("start was too close to the end of the video");
      start = Math.max(0, length - CLIP_TARGET_S);
    }

    // Snap start back to the caption that contains it (or the last one before it).
    if (segs.length) {
      let snapped = segs[0].start;
      for (const s of segs) {
        if (s.start <= start + 0.5) snapped = s.start;
        else break;
      }
      start = snapped;
    }

    const span = end - start;
    if (span < CLIP_MIN_S) {
      notes.push(`the window was ${Math.round(span)} seconds, shorter than ${CLIP_MIN_S}`);
      end = start + CLIP_TARGET_S;
    } else if (span > CLIP_MAX_S) {
      notes.push(`the window was ${Math.round(span)} seconds, longer than ${CLIP_MAX_S}`);
      end = start + CLIP_TARGET_S;
    }

    // Snap end forward to the end of the caption it falls in, but never past CLIP_MAX_S.
    if (segs.length) {
      const containing = [...segs].reverse().find((s) => s.start <= end);
      if (containing) {
        const segEnd = containing.start + Math.max(0, containing.dur);
        if (segEnd >= end && segEnd - start <= CLIP_MAX_S) end = segEnd;
      }
    }
    if (length > 0) end = Math.min(end, length);
    if (end - start < CLIP_MIN_S && length > 0) {
      // Pulled back from the end of the video: start on the first caption at or after the
      // target, so the clip still begins at the start of a line.
      const target = Math.max(0, end - CLIP_TARGET_S);
      const next = segs.find((s) => s.start >= target - 0.5);
      start = next && end - next.start >= CLIP_MIN_S ? next.start : target;
    }
  }

  start = Math.max(0, Math.floor(start));
  end = Math.max(start + 1, Math.ceil(end));

  const fallbackTitle = clipText(ctx.video.title, 120) || "Untitled video";
  const title = clipText(input.title, 120) || fallbackTitle;
  const excerpt = clipExcerpt(ctx.segments, start, end, 40);
  const summary = clipText(input.summary, 400) || excerpt || `A part of "${fallbackTitle}".`;
  const reason = clipText(input.reason, 300);
  if (!clipText(input.title, 120)) notes.push("title was empty");

  return { clip: { start, end, title, summary, reason, picked }, notes };
}

/** The words spoken inside [start, end], cleaned; at most `maxWords` words (0 = no limit). */
export function clipExcerpt(segments: TranscriptSegment[], start: number, end: number, maxWords = 0): string {
  const text = sortedSegments(segments)
    .filter((s) => s.start >= start - 0.5 && s.start < end)
    .map((s) => cleanCaptionText(s.text))
    .join(" ")
    .trim();
  return maxWords > 0 ? firstWords(text, maxWords) : text;
}

// ---------------------------------------------------------------------------
// Heuristic picker (free): the densest stretch of real content
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does doing for from had has have he her here him his how i if in into is it its " +
    "just like me more most my no not now of on one or our out over really right said say says she so some than that the their them then " +
    "there these they thing things this those to too um uh up us very was we were what when where which while who why will with would yeah " +
    "you your gonna going get got know okay oh well also about because actually all any back even go kind lot make much need only other " +
    "see something sort still take think time way want"
  ).split(" "),
);

/** Phrases that mark sponsor reads, intros and outros: windows containing them score lower. */
const FILLER = /\b(subscribe|sponsor(?:ed)?|patreon|link in the description|smash that|like button|merch|welcome back|thanks for watching|see you next time|today's video is brought)\b/i;

/**
 * Substance score of a run of transcript blocks: higher is denser. -Infinity when it holds fewer
 * than `minWords` spoken words (too little to judge).
 */
export function scoreWindow(blocks: TranscriptBlock[], length: number, minWords = 40): number {
  const all = blocks.flatMap((b) => words(b.text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ")));
  if (all.length < minWords) return -Infinity;
  const content = all.filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const unique = new Set(content).size;
  // Distinct content words per spoken word: rewards explanation, punishes chatter and repetition.
  let score = unique / Math.sqrt(all.length);
  const fillerHits = blocks.filter((b) => FILLER.test(b.text)).length;
  score -= fillerHits * 1.5;
  // Intros and outros rarely hold the core idea.
  if (length > 0) {
    const mid = (blocks[0].start + blocks[blocks.length - 1].start) / 2;
    const pos = mid / length;
    if (pos < 0.08 || pos > 0.92) score *= 0.75;
  }
  return score;
}

/** Picks the densest CLIP_TARGET_S-second window. Deterministic. */
export function heuristicClip(ctx: ClipContext): ClipPlan {
  const length = videoLength(ctx);
  if (isShortVideo(ctx)) return wholeVideoClip(ctx);
  const blocks = buildTranscriptBlocks(ctx.segments);
  if (blocks.length === 0) return defaultClip(ctx);

  let best = { start: blocks[0].start, score: -Infinity };
  for (let i = 0; i < blocks.length; i++) {
    const from = blocks[i].start;
    if (length > 0 && from > length - CLIP_MIN_S) break;
    const window = [];
    for (let j = i; j < blocks.length && blocks[j].start < from + CLIP_TARGET_S; j++) window.push(blocks[j]);
    const score = scoreWindow(window, length);
    if (score > best.score) best = { start: from, score };
  }
  const excerpt = clipExcerpt(ctx.segments, best.start, best.start + CLIP_TARGET_S, 30);
  return normalizeClip(
    {
      start: best.start,
      end: best.start + CLIP_TARGET_S,
      title: clipText(ctx.video.title, 120),
      summary: excerpt,
      reason: "The stretch with the most substance and the least chatter.",
    },
    ctx,
    "heuristic",
  ).clip;
}

/** The whole video as one episode. */
export function wholeVideoClip(ctx: ClipContext): ClipPlan {
  const length = Math.max(1, videoLength(ctx));
  return {
    start: 0,
    end: length,
    title: clipText(ctx.video.title, 120) || "Untitled video",
    summary: clipExcerpt(ctx.segments, 0, length, 40) || `The full video, ${Math.round(length / 60) || 1} minutes.`,
    reason: "The video is short, so it plays in full.",
    picked: "whole",
  };
}

/**
 * No transcript: a window from just after the intro. Not the best part, but something to hear,
 * and pasting the transcript replaces it with a proper pick.
 */
export function defaultClip(ctx: ClipContext): ClipPlan {
  const length = videoLength(ctx);
  if (length > 0 && length <= WHOLE_VIDEO_MAX_S) {
    return { ...wholeVideoClip(ctx), picked: "nocaptions" };
  }
  const start = length > 0 ? Math.min(Math.round(length * 0.1), Math.max(0, length - CLIP_TARGET_S)) : 0;
  const end = length > 0 ? Math.min(length, start + CLIP_TARGET_S) : start + CLIP_TARGET_S;
  return {
    start,
    end,
    title: clipText(ctx.video.title, 120) || "Untitled video",
    summary: "Captions weren't available for this video, so this part starts just after the intro.",
    reason: "Paste the transcript to have RecallCast pick the most important part instead.",
    picked: "nocaptions",
  };
}
