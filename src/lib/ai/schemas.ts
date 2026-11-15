import { z } from "zod";
import type { ClipPlan } from "@/lib/types";

/**
 * Two layers of schemas.
 *
 * 1. WIRE schema: sent to Claude as output_config.format (structured outputs) and used to parse
 *    the reply. It pins the shape (types, required keys) but no numeric ranges: the API can't
 *    enforce those, so a reply with a 5-minute window would fail parsing and waste the call.
 *    Ranges are enforced by normalizeClip (clip.ts), which clamps and snaps.
 *
 * 2. STRICT domain schema: the final assertion on stored clips (and on stored JSON read back).
 */

const seconds = (what: string) =>
  z
    .number()
    .describe(
      `Whole seconds into the video for ${what}, read from the transcript markers ([01:23] = 83, [1:02:03] = 3723).`,
    );

export const WireClipSchema = z.object({
  start: seconds("the first moment of the part (copy the marker of the line where it begins)"),
  end: seconds("the last moment of the part (the marker of the first line after it ends)"),
  title: z.string().describe("Episode title for this part, at most ~60 characters, different from the video title."),
  summary: z.string().describe("1-2 plain sentences: what the listener hears in this part."),
  reason: z.string().describe("One sentence: why this is the most important part of the video."),
});

export type WireClip = z.infer<typeof WireClipSchema>;

/** Reels: several short moments per video, best first. Ranges are enforced by normalizeMoments. */
export const WireMomentsSchema = z.object({
  moments: z
    .array(
      z.object({
        start: seconds("the first moment of the reel (copy the marker of the line where it begins)"),
        end: seconds("the last moment of the reel (the marker of the first line after it ends)"),
        hook: z.string().describe("Headline for the feed, at most ~70 characters: what the viewer gets from this moment."),
        takeaway: z.string().describe("One plain sentence: the point this moment makes."),
      }),
    )
    .describe("The strongest self-contained moments of the video, best first. Fewer than asked is fine; never pad."),
});

export type WireMoments = z.infer<typeof WireMomentsSchema>;

const text = z.string().trim().min(1);
const whole = z.number().int().min(0);

export const ClipPlanSchema = z
  .object({
    start: whole,
    end: whole,
    title: text,
    summary: text,
    reason: z.string(),
    picked: z.enum(["ai", "heuristic", "whole", "nocaptions"]),
  })
  .refine((c) => c.end > c.start, { message: "end must be after start", path: ["end"] });

// Compile-time guarantee that the strict schema matches the shared contract in types.ts.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _ClipMatches = Assert<Same<z.infer<typeof ClipPlanSchema>, ClipPlan>>;
