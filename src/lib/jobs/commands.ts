import "server-only";
import { all, get, now as dbNow, run, transaction } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { newId } from "@/lib/ids";
import { deleteAudio } from "@/lib/storage/audio";
import { parseManualTranscript } from "@/lib/transcripts/manual";
import { captionLimitRemainingMs } from "@/lib/transcripts/youtubei";
import type { JobPayloads, JobType, PlaylistRow, VideoStatus } from "@/lib/types";
import { parseYouTubeUrl } from "@/lib/youtube/parse";
import { settlePlaylist } from "./pipeline";
import { cancelQueuedJobs, enqueue, hasActiveJob } from "./queue";
import { IN_PROGRESS_VIDEO_STATUSES } from "./status";
import { getOwnedPlaylist } from "./views";

/**
 * User-initiated mutations behind the playlist/video API routes. Each checks ownership
 * (missing and not-owned are both 404, so ids cannot be probed) and throws HttpError with a
 * user-readable message. All DB work is synchronous, so check-then-insert sequences (like the
 * daily cap) run inside one transaction with no await in between and cannot race.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_MANUAL_TRANSCRIPT_WORDS = 20;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function canonicalSourceUrl(parsed: NonNullable<ReturnType<typeof parseYouTubeUrl>>): string {
  return parsed.kind === "playlist"
    ? `https://www.youtube.com/playlist?list=${parsed.playlistId}`
    : `https://www.youtube.com/watch?v=${parsed.videoId}`;
}

/**
 * Validates the URL, enforces MAX_PLAYLISTS_PER_USER_PER_DAY and the site-wide
 * MAX_PLAYLISTS_PER_DAY (both rolling 24 hours), inserts the
 * playlist (status 'queued') and enqueues ingest_playlist. The stored source_url is the
 * canonical YouTube URL, never the raw input.
 */
export function createPlaylist(userId: string, url: string, at: number = dbNow()): { id: string } {
  const parsed = parseYouTubeUrl(url);
  if (!parsed) {
    throw new HttpError(400, "That doesn't look like a YouTube playlist or video link.");
  }
  const { MAX_PLAYLISTS_PER_USER_PER_DAY: cap, MAX_PLAYLISTS_PER_DAY: siteCap } = getEnv();
  return transaction(() => {
    // Both caps count the append-only creation ledger, not live playlists: deleting a playlist
    // must not hand the slot (and its paid processing) back. Rows older than 2 days never count
    // again, so they are pruned for every user (keeps the site-wide COUNT small: the table has
    // no index on created_at alone).
    run("DELETE FROM playlist_creations WHERE created_at <= ?", at - 2 * DAY_MS);
    run("DELETE FROM playlist_events WHERE created_at <= ?", at - 2 * DAY_MS);
    const used = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM playlist_creations WHERE user_id = ? AND created_at > ?",
      userId,
      at - DAY_MS,
    );
    if (Number(used?.n ?? 0) >= cap) {
      throw new HttpError(429, `You can add up to ${cap} playlists per day. Please try again tomorrow.`);
    }
    // Site-wide cap (MAX_PLAYLISTS_PER_DAY): bounds the bill when many throwaway accounts each
    // use their own per-user allowance. Same transaction as the insert, so it cannot overshoot.
    // It counts playlist_events (no user foreign key), so deleting an account frees nothing.
    const siteUsed = get<{ n: number }>("SELECT COUNT(*) AS n FROM playlist_events WHERE created_at > ?", at - DAY_MS);
    if (Number(siteUsed?.n ?? 0) >= siteCap) {
      throw new HttpError(429, "RecallCast has reached today's limit for new playlists. Try again later.");
    }
    run("INSERT INTO playlist_creations (user_id, created_at) VALUES (?, ?)", userId, at);
    run("INSERT INTO playlist_events (created_at) VALUES (?)", at);
    const id = newId();
    run(
      `INSERT INTO playlists (id, user_id, source_url, youtube_playlist_id, kind, title, channel, thumbnail, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', '', '', 'queued', NULL, ?, ?)`,
      id,
      userId,
      canonicalSourceUrl(parsed),
      parsed.kind === "playlist" ? parsed.playlistId : null,
      parsed.kind,
      at,
      at,
    );
    enqueue("ingest_playlist", { playlistId: id });
    return { id };
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes the playlist (cascades to videos, transcripts, knowledge, episodes, and the legacy cards/reviews tables),
 * cancels its queued jobs and removes any legacy audio files. Jobs already running finish as
 * no-ops (every step checks its row still exists).
 */
export function deletePlaylist(userId: string, playlistId: string): void {
  const audio: (string | null)[] = [];
  transaction(() => {
    const p = getOwnedPlaylist(userId, playlistId);
    if (!p) throw new HttpError(404, "Playlist not found");
    const videos = all<{ id: string }>("SELECT id FROM videos WHERE playlist_id = ?", playlistId);
    const episodes = all<{ id: string; audio_path: string | null }>(
      "SELECT id, audio_path FROM episodes WHERE playlist_id = ?",
      playlistId,
    );
    audio.push(...episodes.map((e) => e.audio_path));
    const jobs: { type: JobType; payload: JobPayloads[JobType] }[] = [
      { type: "ingest_playlist", payload: { playlistId } },
      ...videos.map((v) => ({ type: "process_video" as const, payload: { videoId: v.id } })),
      ...videos.map((v) => ({ type: "pick_moments" as const, payload: { videoId: v.id } })),
    ];
    cancelQueuedJobs(jobs);
    run("DELETE FROM playlists WHERE id = ? AND user_id = ?", playlistId, userId);
  });
  for (const a of audio) deleteAudio(a);
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * How many times a user may re-run paid work for one video (Retry, or pasting a transcript over
 * an existing one) and for the playlist-level ingest. Without a cap, input that
 * fails on purpose (refusal, invalid output) can be re-billed forever. Deleting the playlist and
 * adding it again counts against the daily playlist cap instead.
 */
export const MAX_USER_RETRIES = 3;

const RETRY_LIMIT_MESSAGE =
  `This has already been retried ${MAX_USER_RETRIES} times. Remove the playlist and add it again to start over.`;

/**
 * Re-enqueues what failed: the ingest (playlist failed before any video was stored), every
 * failed video (a stored transcript is reused), each at most MAX_USER_RETRIES times. Returns how many things were re-queued
 * (0 when nothing had failed); throws 429 when everything that failed is out of retries.
 */
export function retryPlaylist(userId: string, playlistId: string): { retried: number } {
  const retried = transaction(() => {
    const p = getOwnedPlaylist(userId, playlistId);
    if (!p) throw new HttpError(404, "Playlist not found");
    const at = dbNow();
    const playlistRetries = Number(p.retry_count ?? 0);

    const videos = all<{
      id: string;
      status: VideoStatus;
      transcript_status: string;
      has_transcript: number;
      retry_count: number;
    }>(
      `SELECT v.id, v.status, v.transcript_status, v.retry_count,
              (SELECT COUNT(*) FROM transcripts t WHERE t.video_id = v.id) AS has_transcript
         FROM videos v WHERE v.playlist_id = ?`,
      playlistId,
    );

    if (videos.length === 0) {
      if (p.status !== "failed" || hasActiveJob("ingest_playlist", { playlistId })) return 0;
      if (playlistRetries >= MAX_USER_RETRIES) throw new HttpError(429, RETRY_LIMIT_MESSAGE);
      run(
        "UPDATE playlists SET status = 'queued', error = NULL, retry_count = retry_count + 1, updated_at = ? WHERE id = ?",
        at,
        playlistId,
      );
      enqueue("ingest_playlist", { playlistId }, { unique: true });
      return 1;
    }

    let count = 0;
    let capped = 0;
    for (const v of videos) {
      if (v.status !== "failed") continue;
      if (Number(v.retry_count ?? 0) >= MAX_USER_RETRIES) {
        capped++;
        continue;
      }
      const transcriptStatus =
        v.transcript_status === "needs_manual" && Number(v.has_transcript) === 0 ? "pending" : v.transcript_status;
      run(
        "UPDATE videos SET status = 'pending', error = NULL, transcript_status = ?, retry_count = retry_count + 1 WHERE id = ?",
        transcriptStatus,
        v.id,
      );
      enqueue("process_video", { videoId: v.id }, { unique: true });
      count++;
    }

    if (count === 0 && capped > 0) throw new HttpError(429, RETRY_LIMIT_MESSAGE);
    run("UPDATE playlists SET updated_at = ? WHERE id = ?", at, playlistId);
    settlePlaylist(playlistId);
    return count;
  });
  return { retried };
}

// ---------------------------------------------------------------------------
// Check for captions again
// ---------------------------------------------------------------------------

/**
 * Re-runs the videos of a playlist that are playing a default window because no captions were
 * found (ready, transcript_status 'needs_manual', nothing pasted). Captions that could not be
 * fetched one day can often be fetched the next: YouTube changes what it lets servers read.
 * Finding captions leads to a paid clip pick, so each run uses one of the video's
 * MAX_USER_RETRIES. Returns how many videos were queued (0 when none is waiting for captions);
 * throws 429 when every such video is out of retries.
 */
export function recheckCaptions(userId: string, playlistId: string): { rechecked: number } {
  const rechecked = transaction(() => {
    const p = getOwnedPlaylist(userId, playlistId);
    if (!p) throw new HttpError(404, "Playlist not found");
    // While YouTube is refusing this server's caption requests a re-check cannot find anything;
    // say so instead of spending one of the video's few re-checks.
    const limitedMs = captionLimitRemainingMs();
    if (limitedMs > 0) {
      const minutes = Math.max(1, Math.ceil(limitedMs / 60_000));
      throw new HttpError(429, `YouTube is limiting caption requests right now. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
    }
    const videos = all<{ id: string; retry_count: number }>(
      `SELECT v.id, v.retry_count FROM videos v
        WHERE v.playlist_id = ? AND v.status = 'ready' AND v.transcript_status = 'needs_manual'
          AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.video_id = v.id)`,
      playlistId,
    );
    let count = 0;
    let capped = 0;
    for (const v of videos) {
      if (Number(v.retry_count ?? 0) >= MAX_USER_RETRIES) {
        capped++;
        continue;
      }
      run(
        "UPDATE videos SET status = 'pending', error = NULL, transcript_status = 'pending', retry_count = retry_count + 1 WHERE id = ?",
        v.id,
      );
      enqueue("process_video", { videoId: v.id }, { unique: true });
      count++;
    }
    if (count === 0 && capped > 0) {
      throw new HttpError(429, `Captions have already been checked ${MAX_USER_RETRIES} more times for these videos. Paste a transcript instead.`);
    }
    if (count > 0) {
      run("UPDATE playlists SET updated_at = ? WHERE id = ?", dbNow(), playlistId);
      settlePlaylist(playlistId);
    }
    return count;
  });
  return { rechecked };
}

// ---------------------------------------------------------------------------
// Manual transcript
// ---------------------------------------------------------------------------

interface OwnedVideo {
  id: string;
  playlist_id: string;
  status: VideoStatus;
  transcript_status: string;
  retry_count: number;
  has_transcript: number;
  user_id: string;
}

/**
 * Stores a pasted transcript (source 'manual'), clears everything built from the old one
 * (knowledge, episode) so the pipeline re-analyses it, and re-enqueues process_video.
 *
 * Accepted only where a paste is the way forward: the video had no captions (it is playing a
 * default window and needs a transcript for a proper pick), or it failed. A ready video with a
 * transcript is refused (otherwise each paste re-bills the clip pick, outside every cap). The first paste for a video without a transcript
 * is free; pasting over an existing transcript uses one of the video's MAX_USER_RETRIES.
 * Ownership and status are checked before the text is parsed, so a stranger's request costs no CPU.
 */
export function submitManualTranscript(
  userId: string,
  videoId: string,
  text: string,
): { videoId: string; segments: number } {
  const removedAudio: (string | null)[] = [];
  const out = transaction(() => {
    const v = get<OwnedVideo>(
      `SELECT v.id, v.playlist_id, v.status, v.transcript_status, v.retry_count, p.user_id,
              (SELECT COUNT(*) FROM transcripts t WHERE t.video_id = v.id) AS has_transcript
         FROM videos v JOIN playlists p ON p.id = v.playlist_id
        WHERE v.id = ? AND p.user_id = ?`,
      videoId,
      userId,
    );
    if (!v) throw new HttpError(404, "Video not found");
    if (v.status === "skipped") throw new HttpError(409, "This video is too long to process.");
    if (IN_PROGRESS_VIDEO_STATUSES.includes(v.status)) {
      throw new HttpError(409, "This video is still being processed. Try again when it has finished.");
    }
    if (v.transcript_status !== "needs_manual" && v.status !== "failed") {
      throw new HttpError(409, "This video already has a transcript.");
    }
    const replacing = Number(v.has_transcript) > 0;
    if (replacing && Number(v.retry_count ?? 0) >= MAX_USER_RETRIES) {
      throw new HttpError(429, RETRY_LIMIT_MESSAGE);
    }

    const segments = parseManualTranscript(text);
    const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    if (segments.length === 0 || words < MIN_MANUAL_TRANSCRIPT_WORDS) {
      throw new HttpError(400, `The transcript is too short. Paste at least ${MIN_MANUAL_TRANSCRIPT_WORDS} words.`);
    }

    run(
      `INSERT INTO transcripts (video_id, source, lang, segments_json) VALUES (?, 'manual', 'und', ?)
       ON CONFLICT(video_id) DO UPDATE SET source = excluded.source, lang = excluded.lang, segments_json = excluded.segments_json`,
      videoId,
      JSON.stringify(segments),
    );
    // Invalidate everything derived from the old transcript. Leaving the old episode
    // behind let a retried process_video (knowledge already re-made) reuse them as if current.
    const episodes = all<{ audio_path: string | null }>(
      "SELECT audio_path FROM episodes WHERE video_id = ? AND kind = 'video'",
      videoId,
    );
    removedAudio.push(...episodes.map((e) => e.audio_path));
    run("DELETE FROM episodes WHERE video_id = ? AND kind = 'video'", videoId);
    run("DELETE FROM knowledge WHERE video_id = ?", videoId);
    run(
      `UPDATE videos SET transcript_status = 'ok', status = 'pending', error = NULL,
              retry_count = retry_count + ? WHERE id = ?`,
      replacing ? 1 : 0,
      videoId,
    );
    enqueue("process_video", { videoId }, { unique: true });
    run("UPDATE playlists SET updated_at = ? WHERE id = ?", dbNow(), v.playlist_id);
    settlePlaylist(v.playlist_id);
    return { videoId, segments: segments.length };
  });
  for (const a of removedAudio) deleteAudio(a);
  return out;
}

/** Re-export for routes that only need the owner check. */
export function requireOwnedPlaylist(userId: string, playlistId: string): PlaylistRow {
  const p = getOwnedPlaylist(userId, playlistId);
  if (!p) throw new HttpError(404, "Playlist not found");
  return p;
}
