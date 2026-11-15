import { assertSameOrigin, deleteSessionsForUser, destroySession, requireUser } from "@/lib/auth";
import { handleError, noContent } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/account/logout-all -> 204
 * Deletes every session of the signed-in account (all devices, this one too) and clears the
 * cookie. Takes no body; none is read, so there is nothing to cap. 401 when signed out.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    deleteSessionsForUser(user.id);
    await destroySession();
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
