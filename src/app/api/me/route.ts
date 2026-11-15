import { getCurrentUser } from "@/lib/auth";
import { error, handleError, json } from "@/lib/http";

export const runtime = "nodejs";

/** GET /api/me -> {user} | 401 */
export async function GET(): Promise<Response> {
  try {
    const user = await getCurrentUser();
    if (!user) return error(401, "Not signed in");
    return json({ user });
  } catch (err) {
    return handleError(err);
  }
}
