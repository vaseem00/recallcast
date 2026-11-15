import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, HttpError, json } from "@/lib/http";
import { recheckCaptions } from "@/lib/jobs/commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * POST /api/playlists/[id]/recheck -> 202 { rechecked }. Looks for captions again on the
 * videos that had none; 429 when each of them has been checked as often as allowed.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { id } = await ctx.params;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "Playlist not found");
    const { rechecked } = recheckCaptions(user.id, id);
    return json({ rechecked }, 202);
  } catch (err) {
    return handleError(err);
  }
}
