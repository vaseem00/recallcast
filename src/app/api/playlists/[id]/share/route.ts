import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, HttpError, json, noContent } from "@/lib/http";
import { sharePlaylist, unsharePlaylist } from "@/lib/reels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

async function idFrom(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "Playlist not found");
  return id;
}

/**
 * POST /api/playlists/[id]/share -> 200 { slug, path }. Makes the playlist's reels a public
 * feed at /r/<slug> that anyone with the link can swipe through without an account.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { slug } = sharePlaylist(user.id, await idFrom(ctx));
    return json({ slug, path: `/r/${slug}` });
  } catch (err) {
    return handleError(err);
  }
}

/** DELETE /api/playlists/[id]/share -> 204. The link stops working at once. */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    unsharePlaylist(user.id, await idFrom(ctx));
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
