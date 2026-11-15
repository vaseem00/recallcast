import "server-only";
import { z } from "zod";
import { all, run, transaction } from "@/lib/db";
import { cancelQueuedJobs } from "@/lib/jobs/queue";
import { deleteAudio } from "@/lib/storage/audio";
import type { JobPayloads, JobType } from "@/lib/types";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/auth/password";

/**
 * Account settings: change password, delete the account. Route handlers live under
 * src/app/api/account/. Sessions and cookies are handled by the routes (next/headers),
 * so everything here stays unit-testable.
 */

export const WRONG_CURRENT_PASSWORD = "Your current password is not right.";

export const passwordChangeSchema = z.object({
  currentPassword: z
    .string({ error: "Enter your current password" })
    .min(1, { error: "Enter your current password" })
    .max(PASSWORD_MAX, { error: WRONG_CURRENT_PASSWORD }),
  newPassword: z
    .string({ error: "Enter a new password" })
    .min(PASSWORD_MIN, { error: `The new password must be at least ${PASSWORD_MIN} characters` })
    .max(PASSWORD_MAX, { error: `The new password must be at most ${PASSWORD_MAX} characters` }),
});

export const deleteAccountSchema = z.object({
  password: z
    .string({ error: "Enter your password" })
    .min(1, { error: "Enter your password" })
    .max(PASSWORD_MAX, { error: WRONG_CURRENT_PASSWORD }),
});

/**
 * Deletes a user and everything they own. In one transaction: cancels every queued job for the
 * user's playlists, videos and episodes, then deletes the users row; the schema cascades
 * (ON DELETE CASCADE, migration 1-2) remove sessions, playlists, videos, transcripts, knowledge,
 * episodes, the legacy cards/reviews rows and the playlist-creation ledger. Afterwards the audio files go.
 *
 * Jobs already running cannot be stopped from here; like a playlist delete, they finish as no-ops
 * because every step re-reads its rows.
 * Audio is removed both by the stored audio_path and by the canonical audio/<episodeId>.mp3, so
 * a file whose path was not yet recorded is not left behind.
 * Returns how many audio files were removed.
 */
export function deleteAccount(userId: string): { audioRemoved: number } {
  const audio = new Set<string>();
  const existed = transaction(() => {
    const playlists = all<{ id: string }>("SELECT id FROM playlists WHERE user_id = ?", userId);
    const videos = all<{ id: string }>(
      "SELECT v.id FROM videos v JOIN playlists p ON p.id = v.playlist_id WHERE p.user_id = ?",
      userId,
    );
    const episodes = all<{ id: string; audio_path: string | null }>(
      "SELECT e.id, e.audio_path FROM episodes e JOIN playlists p ON p.id = e.playlist_id WHERE p.user_id = ?",
      userId,
    );
    for (const e of episodes) {
      if (e.audio_path) audio.add(e.audio_path);
      audio.add(`audio/${e.id}.mp3`);
    }
    const jobs: { type: JobType; payload: JobPayloads[JobType] }[] = [
      ...playlists.map((p) => ({ type: "ingest_playlist" as const, payload: { playlistId: p.id } })),
      ...videos.map((v) => ({ type: "process_video" as const, payload: { videoId: v.id } })),
      ...videos.map((v) => ({ type: "pick_moments" as const, payload: { videoId: v.id } })),
    ];
    cancelQueuedJobs(jobs);
    return run("DELETE FROM users WHERE id = ?", userId).changes > 0;
  });
  if (!existed) return { audioRemoved: 0 };
  let audioRemoved = 0;
  for (const a of audio) if (deleteAudio(a)) audioRemoved++;
  return { audioRemoved };
}
