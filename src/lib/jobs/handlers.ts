import "server-only";
import type { JobPayloads, JobType } from "@/lib/types";
import { ingestPlaylist, onIngestFailed, onMomentsFailed, onVideoFailed, pickVideoMoments, processVideo } from "./pipeline";
import type { ProviderResolver } from "./providers";

/**
 * One entry per job type:
 *   run(payload, resolve, ctx)  does the work; returns the playlist id to settle (or null).
 *                               ctx.lastAttempt: the job has no retries left after this run
 *   onFailure(payload, message) the job failed for good; stores `message` (user-readable)
 *                               and returns the playlist id to settle (or null)
 *   fallback                    message used when the error has no user-safe message
 */
export interface JobRunContext {
  lastAttempt: boolean;
}

export interface JobHandler<T extends JobType> {
  run(payload: JobPayloads[T], resolve: ProviderResolver, ctx: JobRunContext): Promise<string | null>;
  onFailure(payload: JobPayloads[T], message: string): string | null;
  fallback: string;
}

export const HANDLERS: { [K in JobType]: JobHandler<K> } = {
  ingest_playlist: {
    async run({ playlistId }, resolve) {
      return ingestPlaylist(playlistId, { youtube: await resolve("youtube") });
    },
    onFailure: ({ playlistId }, message) => onIngestFailed(playlistId, message),
    fallback: "We couldn't read this playlist from YouTube. Please try again.",
  },
  process_video: {
    async run({ videoId }, resolve, ctx) {
      const [transcripts, ai] = await Promise.all([resolve("transcripts"), resolve("ai")]);
      return processVideo(videoId, { transcripts, ai }, ctx);
    },
    onFailure: ({ videoId }, message) => onVideoFailed(videoId, message),
    fallback: "Something went wrong while preparing this episode. Please retry.",
  },
  pick_moments: {
    async run({ videoId }, resolve) {
      // Each provider is resolved only if this video needs it: the AI for a transcript, YouTube
      // for the chapter marks of a video without one.
      return pickVideoMoments(videoId, { ai: () => resolve("ai"), youtube: () => resolve("youtube") });
    },
    // Reels never show a failure: the free heuristic picks instead (see onMomentsFailed).
    onFailure: ({ videoId }) => onMomentsFailed(videoId),
    fallback: "Reels could not be cut for this video.",
  },
};
