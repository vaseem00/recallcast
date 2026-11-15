import { assertSameOrigin, destroySession } from "@/lib/auth";
import { handleError, noContent } from "@/lib/http";

export const runtime = "nodejs";

/** POST /api/auth/logout -> 204 (idempotent; fine when already signed out) */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    await destroySession();
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
