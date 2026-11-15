import { z } from "zod";
import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, HttpError, json, parseJson } from "@/lib/http";
import { submitManualTranscript } from "@/lib/jobs/commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** ~3 hours of speech is about 200k characters; leave generous headroom. */
const MAX_TRANSCRIPT_CHARS = 1_000_000;

const BodySchema = z.object({
  text: z
    .string()
    .min(1, "Paste the transcript text")
    .max(MAX_TRANSCRIPT_CHARS, "That transcript is too long"),
});

/** POST /api/videos/[id]/transcript { text } -> 202 { videoId, segments }. */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { id } = await ctx.params;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "Video not found");
    const { text } = await parseJson(req, BodySchema, { maxBytes: 4 * MAX_TRANSCRIPT_CHARS });
    const result = submitManualTranscript(user.id, id, text);
    return json(result, 202);
  } catch (err) {
    return handleError(err);
  }
}
