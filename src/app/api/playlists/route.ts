import { z } from "zod";
import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, json, parseJson } from "@/lib/http";
import { createPlaylist } from "@/lib/jobs/commands";
import { listPlaylistsForUser } from "@/lib/jobs/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  url: z.string().trim().min(1, "Paste a YouTube playlist or video link").max(2048, "That link is too long"),
});

/** GET /api/playlists -> { playlists: PlaylistListItem[] } (newest first, with counts). */
export async function GET(): Promise<Response> {
  try {
    const user = await requireUser();
    return json({ playlists: listPlaylistsForUser(user.id) });
  } catch (err) {
    return handleError(err);
  }
}

/** POST /api/playlists { url } -> 201 { id }. 400 bad link, 429 daily cap. */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { url } = await parseJson(req, CreateSchema, { maxBytes: 8_192 });
    const { id } = createPlaylist(user.id, url);
    return json({ id }, 201);
  } catch (err) {
    return handleError(err);
  }
}
