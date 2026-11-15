import type { ClipPlan, MomentPlan, TranscriptSegment, VideoMeta } from "@/lib/types";

export interface AiProvider {
  /**
   * Picks the most important 3-4 minute part of a long video from its timed transcript.
   * The result is already normalized (inside the video, snapped to caption boundaries).
   */
  pickClip(input: { video: VideoMeta; segments: TranscriptSegment[] }): Promise<ClipPlan>;
  /**
   * Picks up to `count` self-contained moments of about a minute each (the reels), best first.
   * The result is already normalized (inside the video, snapped to caption boundaries, not
   * overlapping) and never empty: when nothing usable comes back it throws an AiPermanentError.
   */
  pickMoments(input: { video: VideoMeta; segments: TranscriptSegment[]; count: number }): Promise<MomentPlan[]>;
}
