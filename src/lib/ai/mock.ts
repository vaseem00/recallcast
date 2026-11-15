import { heuristicClip } from "./clip";
import { AiInputError } from "./errors";
import { heuristicMoments } from "./moments";
import type { AiProvider } from "./provider";
import { cleanCaptionText } from "./transcript";

/**
 * Free, offline AiProvider: the heuristic pickers (clip.ts, moments.ts). Deterministic, no API
 * calls, and its output goes through the same normalizers as Claude's.
 */
export function createMockAiProvider(): AiProvider {
  return {
    async pickClip({ video, segments }) {
      const segs = (segments ?? []).filter((s) => cleanCaptionText(s.text).length > 0);
      if (!segs.length) throw new AiInputError("The transcript is empty, so there is nothing to choose from.");
      return heuristicClip({ video, segments: segs });
    },
    async pickMoments({ video, segments, count }) {
      const segs = (segments ?? []).filter((s) => cleanCaptionText(s.text).length > 0);
      if (!segs.length) throw new AiInputError("The transcript is empty, so there is nothing to choose from.");
      const moments = heuristicMoments({ video, segments: segs }, count);
      if (!moments.length) throw new AiInputError("The transcript is too short to cut a reel from.");
      return moments;
    },
  };
}
