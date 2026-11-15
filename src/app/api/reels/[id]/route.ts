import { z } from "zod";
import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, HttpError, json, parseJson } from "@/lib/http";
import { MAX_WATCH_REPORT_S, setReelState } from "@/lib/reels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const PatchSchema = z
  .object({
    saved: z.boolean().optional(),
    /** Only `true`: a reel cannot be marked unseen. */
    seen: z.literal(true).optional(),
    /** A viewing report: seconds played since the last report, played to the end, swiped away early. */
    watched: z.number().finite().min(0).max(MAX_WATCH_REPORT_S).optional(),
    completed: z.literal(true).optional(),
    skipped: z.literal(true).optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "Nothing to change" });

/**
 * PATCH /api/reels/[id] { saved?: boolean, seen?: true, watched?: seconds, completed?: true,
 * skipped?: true } -> { saved, seen } (owner only; else 404). The viewing fields feed the
 * ranking of the owner's own feed and nothing else.
 */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { id } = await ctx.params;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "Reel not found");
    const patch = await parseJson(req, PatchSchema, { maxBytes: 1_024 });
    return json(setReelState(user.id, id, patch));
  } catch (err) {
    return handleError(err);
  }
}
