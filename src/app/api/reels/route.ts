import { requireUser } from "@/lib/auth";
import { handleError, HttpError, json } from "@/lib/http";
import { loadReelFeed } from "@/lib/reels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * GET /api/reels[?playlist=ID][&saved=1] -> { reels, total, pending, videos, noCaptions }.
 * The caller's feed: reels not seen yet first. `playlist` limits it to one playlist (an id that
 * is not the caller's reads as an empty feed); `saved=1` lists saved reels, newest first.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const playlist = params.get("playlist");
    if (playlist !== null && !ID_RE.test(playlist)) throw new HttpError(400, "That playlist id is not valid.");
    return json(loadReelFeed(user.id, { playlistId: playlist, saved: params.get("saved") === "1" }));
  } catch (err) {
    return handleError(err);
  }
}
