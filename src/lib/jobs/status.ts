import type { PlaylistStatus, VideoStatus } from "@/lib/types";

/**
 * Pure playlist status roll-up. No DB access, so every rule is unit-testable.
 *
 *  - any non-skipped video still in progress -> processing
 *  - every video skipped                     -> failed
 *  - no video ready                          -> failed
 *  - some videos failed                      -> partial
 *  - otherwise                               -> ready
 */

export const TERMINAL_VIDEO_STATUSES: readonly VideoStatus[] = ["ready", "failed", "skipped"];
// 'scripting' and 'voicing' are legacy statuses; they still count as in progress.
export const IN_PROGRESS_VIDEO_STATUSES: readonly VideoStatus[] = [
  "pending",
  "transcribing",
  "analyzing",
  "scripting",
  "voicing",
];

export interface RollupInput {
  videoStatuses: VideoStatus[];
}

export interface RollupResult {
  status: PlaylistStatus;
  error: string | null;
}

export function isVideoTerminal(s: VideoStatus): boolean {
  return TERMINAL_VIDEO_STATUSES.includes(s);
}

/** Returns null when there are no videos yet (ingest has not finished; keep the current status). */
export function computePlaylistStatus(input: RollupInput): RollupResult | null {
  const { videoStatuses } = input;
  if (videoStatuses.length === 0) return null;

  const active = videoStatuses.filter((s) => s !== "skipped");
  if (active.length === 0) {
    return { status: "failed", error: "Every video is longer than the length limit, so nothing could be processed." };
  }
  if (active.some((s) => !isVideoTerminal(s))) return { status: "processing", error: null };

  const ready = active.filter((s) => s === "ready").length;
  const failed = active.length - ready;
  if (ready === 0) {
    return {
      status: "failed",
      error: active.length === 1 ? "This video could not be processed." : "None of the videos could be processed.",
    };
  }
  if (failed > 0) return { status: "partial", error: `${failed} of ${active.length} videos could not be processed.` };
  return { status: "ready", error: null };
}
