import "server-only";
import { defaultClip, heuristicClip, videoLength } from "@/lib/ai/clip";
import { AiPermanentError } from "@/lib/ai/errors";
import { heuristicMoments, momentCount, noCaptionMoments } from "@/lib/ai/moments";
import { ClipPlanSchema } from "@/lib/ai/schemas";
import { all, get, now as dbNow, run, transaction } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { newId } from "@/lib/ids";
import { deleteAudio } from "@/lib/storage/audio";
import type {
  Chapter,
  ClipPlan,
  MomentPlan,
  PlaylistKind,
  PlaylistRow,
  PlaylistStatus,
  TranscriptSegment,
  TranscriptSource,
  VideoMeta,
  VideoRow,
  VideoStatus,
} from "@/lib/types";
import { parseChaptersJson } from "@/lib/youtube/chapters";
import { parseYouTubeUrl } from "@/lib/youtube/parse";
import type { YouTubeProvider } from "@/lib/youtube/provider";
import { PipelineError, isRetryable } from "./errors";
import type { Providers } from "./providers";
import { enqueue, hasActiveJob } from "./queue";
import { computePlaylistStatus } from "./status";

/**
 * Pipeline step functions. Each one:
 *  - takes the providers it needs as an argument (dependency injection; tests pass mocks/fakes);
 *  - is idempotent: re-running it replaces its own output (delete-and-replace inside a
 *    transaction), and a stored transcript is reused so a retry doesn't fetch it again;
 *  - quietly does nothing when its row was deleted meanwhile (user deleted the playlist);
 *  - returns the playlist id whose status should be re-computed (or null). The worker calls
 *    settlePlaylist() for it AFTER marking the job done/failed.
 *
 * An episode is a clip: one 3-4 minute window of the video (start/end seconds) that the
 * browser plays through YouTube's embedded player. Nothing is downloaded or re-hosted.
 *
 * Errors: anything with `retryable === true` is retried with backoff by the worker; anything
 * else ends in the matching on*Failed() handler below, which stores a user-readable message.
 */

export interface PipelineLimits {
  maxVideos: number;
  maxVideoSeconds: number;
}

function defaultLimits(): PipelineLimits {
  const env = getEnv();
  return { maxVideos: env.MAX_VIDEOS_PER_PLAYLIST, maxVideoSeconds: env.MAX_VIDEO_SECONDS };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface VideoCtx extends VideoRow {
  user_id: string;
  playlist_kind: PlaylistKind;
}

function loadVideo(videoId: string): VideoCtx | undefined {
  return get<VideoCtx>(
    `SELECT v.*, p.user_id AS user_id, p.kind AS playlist_kind
       FROM videos v JOIN playlists p ON p.id = v.playlist_id
      WHERE v.id = ?`,
    videoId,
  );
}

function videoExists(videoId: string): boolean {
  return get("SELECT 1 AS x FROM videos WHERE id = ?", videoId) !== undefined;
}

export function toVideoMeta(v: Pick<VideoRow, "youtube_video_id" | "title" | "channel" | "duration_s" | "thumbnail" | "position">): VideoMeta {
  return {
    youtubeVideoId: v.youtube_video_id,
    title: v.title,
    channel: v.channel,
    durationS: Number(v.duration_s) || 0,
    thumbnail: v.thumbnail,
    position: Number(v.position) || 0,
  };
}

function setVideoStatus(videoId: string, status: VideoStatus): void {
  run("UPDATE videos SET status = ?, error = NULL WHERE id = ? AND status <> 'skipped'", status, videoId);
}

function safeJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function cleanSegments(segments: unknown): TranscriptSegment[] {
  if (!Array.isArray(segments)) return [];
  const out: TranscriptSegment[] = [];
  for (const s of segments as Partial<TranscriptSegment>[]) {
    if (!s || typeof s.text !== "string" || !s.text.trim()) continue;
    const start = Number(s.start);
    const dur = Number(s.dur);
    if (!Number.isFinite(start) || start < 0) continue;
    out.push({ start, dur: Number.isFinite(dur) && dur >= 0 ? dur : 0, text: s.text });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Parses a stored clip; null for anything else (including legacy podcast scripts). */
export function parseStoredClip(json: string | null | undefined): ClipPlan | null {
  const parsed = ClipPlanSchema.safeParse(safeJson(json));
  return parsed.success ? parsed.data : null;
}

function loadTranscriptSegments(videoId: string): TranscriptSegment[] | null {
  const row = get<{ segments_json: string }>("SELECT segments_json FROM transcripts WHERE video_id = ?", videoId);
  if (!row) return null;
  const segs = cleanSegments(safeJson(row.segments_json));
  return segs.length ? segs : null;
}

function upsertTranscript(videoId: string, source: TranscriptSource, lang: string, segments: TranscriptSegment[]): void {
  run(
    `INSERT INTO transcripts (video_id, source, lang, segments_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET source = excluded.source, lang = excluded.lang, segments_json = excluded.segments_json`,
    videoId,
    source,
    lang,
    JSON.stringify(segments),
  );
}

function normalizeSource(s: unknown): TranscriptSource {
  return s === "mock" || s === "manual" || s === "youtubei" ? s : "youtubei";
}

function finiteOr(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

/** Re-computes and stores the playlist status. Returns the new status (or the current one if unchanged / no videos yet). */
export function rollupPlaylist(playlistId: string): PlaylistStatus | null {
  const p = get<Pick<PlaylistRow, "status" | "error">>("SELECT status, error FROM playlists WHERE id = ?", playlistId);
  if (!p) return null;
  const statuses = all<{ status: VideoStatus }>("SELECT status FROM videos WHERE playlist_id = ?", playlistId).map(
    (r) => r.status,
  );
  const result = computePlaylistStatus({ videoStatuses: statuses });
  if (!result) return p.status;
  if (result.status !== p.status || result.error !== p.error) {
    run(
      "UPDATE playlists SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      result.status,
      result.error,
      dbNow(),
      playlistId,
    );
  }
  return result.status;
}

/** Status roll-up. Called by the worker after each job finishes. */
export function settlePlaylist(playlistId: string): PlaylistStatus | null {
  return rollupPlaylist(playlistId);
}

// ---------------------------------------------------------------------------
// Step: ingest_playlist
// ---------------------------------------------------------------------------

function formatLimit(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * Fetches playlist/video metadata, inserts the videos (capped at maxVideos, de-duplicated,
 * longer than maxVideoSeconds -> 'skipped') and enqueues process_video for each one, all in
 * one transaction. If videos already exist (the job is re-run after it already succeeded) it
 * only makes sure each unfinished video has a job.
 */
export async function ingestPlaylist(
  playlistId: string,
  deps: Pick<Providers, "youtube">,
  limits: PipelineLimits = defaultLimits(),
): Promise<string | null> {
  const p = get<PlaylistRow>("SELECT * FROM playlists WHERE id = ?", playlistId);
  if (!p) return null;

  const existing = all<{ id: string; status: VideoStatus }>("SELECT id, status FROM videos WHERE playlist_id = ?", playlistId);
  if (existing.length > 0) {
    transaction(() => {
      for (const v of existing) {
        if (v.status === "pending") enqueue("process_video", { videoId: v.id }, { unique: true });
      }
    });
    return playlistId;
  }

  run("UPDATE playlists SET status = 'ingesting', error = NULL, updated_at = ? WHERE id = ?", dbNow(), playlistId);

  let meta;
  if (p.kind === "playlist") {
    const listId = p.youtube_playlist_id ?? (() => {
      const parsed = parseYouTubeUrl(p.source_url);
      return parsed?.kind === "playlist" ? parsed.playlistId : null;
    })();
    if (!listId) throw new PipelineError("This playlist link could not be read.");
    meta = await deps.youtube.fetchPlaylist(listId);
  } else {
    const parsed = parseYouTubeUrl(p.source_url);
    if (!parsed || parsed.kind !== "video") throw new PipelineError("This video link could not be read.");
    meta = await deps.youtube.fetchVideo(parsed.videoId);
  }

  const seen = new Set<string>();
  const videos = [...(meta.videos ?? [])]
    .sort((a, b) => a.position - b.position)
    .filter((v) => {
      if (!v || typeof v.youtubeVideoId !== "string" || seen.has(v.youtubeVideoId)) return false;
      seen.add(v.youtubeVideoId);
      return true;
    })
    .slice(0, Math.max(1, limits.maxVideos));

  if (videos.length === 0) {
    throw new PipelineError(
      p.kind === "playlist"
        ? "This playlist has no public videos we can process."
        : "This video is not available.",
    );
  }

  const tooLong = `Longer than ${formatLimit(limits.maxVideoSeconds)}, so it was skipped.`;
  const at = dbNow();
  const inserted = transaction(() => {
    if (!get("SELECT 1 AS x FROM playlists WHERE id = ?", playlistId)) return false;
    if (get("SELECT 1 AS x FROM videos WHERE playlist_id = ? LIMIT 1", playlistId)) return true; // raced; already ingested
    run(
      `UPDATE playlists SET title = ?, channel = ?, thumbnail = ?, youtube_playlist_id = COALESCE(?, youtube_playlist_id),
              status = 'processing', error = NULL, updated_at = ?
        WHERE id = ?`,
      (meta.title || videos[0].title || "Untitled").slice(0, 500),
      (meta.channel || videos[0].channel || "").slice(0, 200),
      meta.thumbnail || videos[0].thumbnail || "",
      meta.youtubePlaylistId ?? null,
      at,
      playlistId,
    );
    videos.forEach((v, i) => {
      const durationS = Math.max(0, Math.round(finiteOr(v.durationS, 0)));
      const skipped = durationS > limits.maxVideoSeconds;
      const videoId = newId();
      run(
        `INSERT INTO videos (id, playlist_id, youtube_video_id, position, title, channel, duration_s, thumbnail,
                             transcript_status, status, error, chapters_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        videoId,
        playlistId,
        v.youtubeVideoId,
        i,
        (v.title || "Untitled video").slice(0, 500),
        (v.channel || meta.channel || "").slice(0, 200),
        durationS,
        v.thumbnail || "",
        skipped ? "skipped" : "pending",
        skipped ? tooLong : null,
        // Read with the rest of the metadata; reels of a video without captions are cut at them.
        Array.isArray(v.chapters) ? JSON.stringify(v.chapters) : null,
      );
      if (!skipped) enqueue("process_video", { videoId }, { unique: true });
    });
    return true;
  });
  return inserted ? playlistId : null;
}

// ---------------------------------------------------------------------------
// Step: process_video  (transcript -> pick the clip -> store the episode)
// ---------------------------------------------------------------------------

/**
 * Writes the video's one clip episode (replacing any older one) and marks the video ready.
 * In the same transaction it drops the reels cut before (from the previous transcript, or
 * without one) and queues pick_moments to cut new ones: from the transcript when there is one,
 * otherwise from the chapter marks or the video's position, so every ready video has reels.
 * Reels are a separate job so that a rate limit on that second Claude call never re-runs (and
 * re-bills) the clip pick.
 */
function storeClip(v: VideoCtx, clip: ClipPlan, transcriptStatus: "ok" | "needs_manual"): boolean {
  const removed: (string | null)[] = [];
  const ok = transaction(() => {
    if (!videoExists(v.id)) return false;
    run("DELETE FROM moments WHERE video_id = ?", v.id);
    run("UPDATE videos SET moments_status = 'pending' WHERE id = ?", v.id);
    enqueue("pick_moments", { videoId: v.id }, { unique: true });
    const old = all<{ audio_path: string | null }>("SELECT audio_path FROM episodes WHERE video_id = ? AND kind = 'video'", v.id);
    removed.push(...old.map((o) => o.audio_path));
    run("DELETE FROM episodes WHERE video_id = ? AND kind = 'video'", v.id);
    run(
      `INSERT INTO episodes (id, playlist_id, video_id, kind, title, script_json, audio_path, duration_s, status, error, created_at)
       VALUES (?, ?, ?, 'video', ?, ?, NULL, ?, 'voiced', NULL, ?)`,
      newId(),
      v.playlist_id,
      v.id,
      clip.title.slice(0, 300),
      JSON.stringify(clip),
      clip.end - clip.start,
      dbNow(),
    );
    run("UPDATE videos SET status = 'ready', error = NULL, transcript_status = ? WHERE id = ?", transcriptStatus, v.id);
    run("UPDATE playlists SET updated_at = ? WHERE id = ?", dbNow(), v.playlist_id);
    return true;
  });
  // Legacy rows may still point at an MP3 from the removed voiced episodes.
  removed.forEach((p) => deleteAudio(p));
  return ok;
}

export async function processVideo(
  videoId: string,
  deps: Pick<Providers, "transcripts" | "ai">,
  opts: { /** The job has no retries left after this run. */ lastAttempt?: boolean } = {},
): Promise<string | null> {
  const v = loadVideo(videoId);
  if (!v) return null;
  if (v.status === "skipped") return v.playlist_id;
  const meta = toVideoMeta(v);

  // 1. Transcript (reuse a stored one: manual paste or an earlier fetch).
  let segments = loadTranscriptSegments(videoId);
  if (!segments) {
    setVideoStatus(videoId, "transcribing");
    let result: Awaited<ReturnType<Providers["transcripts"]["fetch"]>> = null;
    try {
      result = await deps.transcripts.fetch(v.youtube_video_id);
    } catch (err) {
      // YouTube is limiting caption downloads: back to the queue. When the job is out of
      // retries the video plays a default window instead of failing, and "Check captions
      // again" re-runs it once YouTube answers.
      if (isRetryable(err) && !opts.lastAttempt) throw err;
      console.warn("[jobs] transcript fetch failed; using a default window", videoId, (err as Error)?.message);
      result = null;
    }
    const fetched = result;
    const segs = cleanSegments(fetched?.segments);
    if (!fetched || segs.length === 0) {
      // No captions: still give the listener something (a window after the intro), and offer
      // the manual paste to get a proper pick.
      return storeClip(v, defaultClip({ video: meta, segments: [] }), "needs_manual") ? v.playlist_id : null;
    }
    const stored = transaction(() => {
      if (!videoExists(videoId)) return false;
      upsertTranscript(videoId, normalizeSource(fetched.source), (fetched.lang || "und").slice(0, 32), segs);
      run("UPDATE videos SET transcript_status = 'ok' WHERE id = ?", videoId);
      return true;
    });
    if (!stored) return null;
    segments = segs;
  }

  // 2. Pick the clip. Claude's answer is preferred; if it can't give a usable one (refusal,
  //    invalid output, input too long) the free heuristic picks instead. Retryable errors
  //    (rate limits, overload, network) go back to the queue.
  setVideoStatus(videoId, "analyzing");
  let clip: ClipPlan;
  try {
    clip = await deps.ai.pickClip({ video: meta, segments });
  } catch (err) {
    // Only a known AI outcome (refusal, unusable output, input too long) falls back. Anything
    // else is a bug or an outage and must fail the job visibly, not hide behind the heuristic.
    if (isRetryable(err) || !(err instanceof AiPermanentError)) throw err;
    console.warn("[jobs] clip pick failed; using the heuristic", videoId, (err as Error)?.message);
    clip = heuristicClip({ video: meta, segments });
  }
  return storeClip(v, clip, "ok") ? v.playlist_id : null;
}

// ---------------------------------------------------------------------------
// Step: pick_moments  (transcript -> the video's reels)
// ---------------------------------------------------------------------------

/** Replaces the video's reels and marks them ready. False when the video is gone. */
function storeMoments(videoId: string, playlistId: string, moments: MomentPlan[]): boolean {
  return transaction(() => {
    if (!videoExists(videoId)) return false;
    run("DELETE FROM moments WHERE video_id = ?", videoId);
    const at = dbNow();
    moments.forEach((m, i) => {
      run(
        `INSERT INTO moments (id, playlist_id, video_id, ord, start_s, end_s, hook, takeaway, picked, basis, saved_at, seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        newId(),
        playlistId,
        videoId,
        i,
        m.start,
        m.end,
        m.hook.slice(0, 300),
        m.takeaway.slice(0, 600),
        m.picked,
        m.basis ?? "transcript",
        at,
      );
    });
    run("UPDATE videos SET moments_status = 'ready' WHERE id = ?", videoId);
    return true;
  });
}

/** A provider, or a function that resolves it only when it is needed. */
export type LazyProvider<T> = T | (() => Promise<T>);

async function provide<T extends object>(p: LazyProvider<T> | undefined): Promise<T | undefined> {
  return typeof p === "function" ? (p as () => Promise<T>)() : p;
}

/**
 * The video's chapter marks: the stored ones, or (for videos ingested before chapters were read)
 * one YouTube Data API call, whose answer is stored so it is asked once. A retryable error
 * (network, rate limit) goes back to the queue; any other error means "no chapters" for now.
 */
async function videoChapters(v: VideoCtx, youtube: LazyProvider<YouTubeProvider> | undefined): Promise<Chapter[]> {
  const stored = parseChaptersJson(v.chapters_json);
  if (stored) return stored;
  let yt: YouTubeProvider | undefined;
  try {
    yt = await provide(youtube);
  } catch (err) {
    console.warn("[jobs] no YouTube provider for chapters", v.id, (err as Error)?.message);
    return [];
  }
  if (!yt?.fetchChapters) return [];
  let chapters: Chapter[];
  try {
    chapters = (await yt.fetchChapters([v.youtube_video_id])).get(v.youtube_video_id) ?? [];
  } catch (err) {
    if (isRetryable(err)) throw err;
    console.warn("[jobs] could not read chapters; cutting by position", v.id, (err as Error)?.message);
    return [];
  }
  run("UPDATE videos SET chapters_json = ? WHERE id = ?", JSON.stringify(chapters), v.id);
  return chapters;
}

/**
 * Cuts the video's reels. With a transcript: up to one per five minutes (momentCount), from one
 * Claude call on it; like the clip pick, an unusable answer falls back to the free heuristic and
 * a retryable error goes back to the queue. Without one: free, from the creator's chapter marks,
 * or one minute by position (noCaptionMoments), so the video is still in the feed; captions
 * found later replace these (storeClip drops them). A video whose reels are already 'ready' is
 * left alone, so a re-run never replaces rows the user has saved or shared.
 */
export async function pickVideoMoments(
  videoId: string,
  deps: { ai?: LazyProvider<Providers["ai"]>; youtube?: LazyProvider<Providers["youtube"]> },
  maxPerVideo: number = getEnv().REELS_PER_VIDEO_MAX,
): Promise<string | null> {
  const v = loadVideo(videoId);
  if (!v || v.moments_status === "ready") return null;
  const segments = loadTranscriptSegments(videoId);
  if (!segments) {
    const chapters = await videoChapters(v, deps.youtube);
    storeMoments(videoId, v.playlist_id, noCaptionMoments(toVideoMeta(v), chapters, maxPerVideo));
    return null;
  }
  const ctx = { video: toVideoMeta(v), segments };
  const count = momentCount(videoLength(ctx), maxPerVideo);
  const ai = await provide(deps.ai);
  if (!ai) throw new Error("pick_moments needs the AI provider");
  let moments: MomentPlan[];
  try {
    moments = await ai.pickMoments({ ...ctx, count });
  } catch (err) {
    if (isRetryable(err) || !(err instanceof AiPermanentError)) throw err;
    console.warn("[jobs] moment pick failed; using the heuristic", videoId, (err as Error)?.message);
    moments = heuristicMoments(ctx, count);
  }
  storeMoments(videoId, v.playlist_id, moments);
  return null;
}

/**
 * pick_moments failed for good (retries used up, missing key, a bug). Reels are an extra, so
 * the video does not fail: the heuristic's picks are stored instead (without a transcript, the
 * stored chapters or the position). Synchronous and never throws (it runs inside the worker's
 * failure transaction).
 */
export function onMomentsFailed(videoId: string): string | null {
  try {
    const v = loadVideo(videoId);
    if (!v) return null;
    const segments = loadTranscriptSegments(videoId);
    if (!segments) {
      storeMoments(videoId, v.playlist_id, noCaptionMoments(toVideoMeta(v), parseChaptersJson(v.chapters_json), getEnv().REELS_PER_VIDEO_MAX));
      return null;
    }
    const ctx = { video: toVideoMeta(v), segments };
    storeMoments(videoId, v.playlist_id, heuristicMoments(ctx, momentCount(videoLength(ctx), getEnv().REELS_PER_VIDEO_MAX)));
  } catch (err) {
    console.error("[jobs] could not store heuristic reels", videoId, err);
    try {
      run("UPDATE videos SET moments_status = 'none' WHERE id = ?", videoId);
    } catch {
      // the next visit to the feed queues the video again
    }
  }
  return null;
}

/**
 * Queues pick_moments for the user's ready videos that have no reels yet: videos processed
 * before reels existed or before videos without captions got reels, and any left 'pending'
 * without a job. Each video is picked once (pickVideoMoments leaves 'ready' ones alone), so this
 * cannot be used to re-bill the same video. Returns how many videos were queued.
 */
export function queueMissingMoments(userId: string, playlistId?: string | null): number {
  return transaction(() => {
    const rows = all<{ id: string; moments_status: string }>(
      `SELECT v.id, v.moments_status
         FROM videos v JOIN playlists p ON p.id = v.playlist_id
        WHERE p.user_id = ? AND v.status = 'ready' AND v.moments_status IN ('none','pending')
          AND (? IS NULL OR p.id = ?)`,
      userId,
      playlistId ?? null,
      playlistId ?? null,
    );
    let queued = 0;
    for (const r of rows) {
      if (r.moments_status === "pending" && hasActiveJob("pick_moments", { videoId: r.id })) continue;
      run("UPDATE videos SET moments_status = 'pending' WHERE id = ?", r.id);
      enqueue("pick_moments", { videoId: r.id }, { unique: true });
      queued++;
    }
    return queued;
  });
}

// ---------------------------------------------------------------------------
// Permanent-failure handlers (job failed for good; store a user-readable message)
// ---------------------------------------------------------------------------

export function onIngestFailed(playlistId: string, message: string): string | null {
  run("UPDATE playlists SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", message, dbNow(), playlistId);
  // Videos are inserted in the same transaction that ends ingest, so a failed ingest has none:
  // there is nothing to roll up.
  return null;
}

export function onVideoFailed(videoId: string, message: string): string | null {
  const v = get<{ playlist_id: string }>("SELECT playlist_id FROM videos WHERE id = ?", videoId);
  if (!v) return null;
  run("UPDATE videos SET status = 'failed', error = ? WHERE id = ? AND status <> 'skipped'", message, videoId);
  return v.playlist_id;
}
