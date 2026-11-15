import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, HttpError, json } from "@/lib/http";
import { retryPlaylist } from "@/lib/jobs/commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** POST /api/playlists/[id]/retry -> 202 { retried } (re-enqueues failed videos / ingest / recap). */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { id } = await ctx.params;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "Playlist not found");
    const { retried } = retryPlaylist(user.id, id);
    return json({ retried }, 202);
  } catch (err) {
    return handleError(err);
  }
}
