import { assertSameOrigin, requireUser } from "@/lib/auth";
import { handleError, HttpError, json, noContent } from "@/lib/http";
import { shareMoment, unshareMoment } from "@/lib/reels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

async function idFrom(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "Reel not found");
  return id;
}

/**
 * POST /api/reels/[id]/share -> 200 { slug, path }. Makes the reel public at /r/<slug> (the
 * same link every time until it is revoked). Anyone with the link can watch that one reel.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { slug } = shareMoment(user.id, await idFrom(ctx));
    return json({ slug, path: `/r/${slug}` });
  } catch (err) {
    return handleError(err);
  }
}

/** DELETE /api/reels/[id]/share -> 204. The link stops working at once. */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    unshareMoment(user.id, await idFrom(ctx));
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
