import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, HttpError, json, noContent } from "@/lib/http";
import { deletePlaylist } from "@/lib/jobs/commands";
import { getPlaylistDetail } from "@/lib/jobs/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

async function idFrom(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "Playlist not found");
  return id;
}

/** GET /api/playlists/[id] -> { playlist, videos, episodes, progress } (owner only; else 404). */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser();
    const id = await idFrom(ctx);
    const detail = getPlaylistDetail(user.id, id);
    if (!detail) throw new HttpError(404, "Playlist not found");
    return json(detail);
  } catch (err) {
    return handleError(err);
  }
}

/** DELETE /api/playlists/[id] -> 204 (also cancels queued jobs and deletes audio files). */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const id = await idFrom(ctx);
    deletePlaylist(user.id, id);
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
