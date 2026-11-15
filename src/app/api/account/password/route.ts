import {
  assertSameOrigin,
  createSession,
  deleteSessionsForUser,
  getAuthLimiters,
  hashPassword,
  requireUser,
  verifyPassword,
} from "@/lib/auth";
import { findUserById, updatePasswordHash } from "@/lib/auth/users";
import { passwordChangeSchema, WRONG_CURRENT_PASSWORD } from "@/lib/account";
import { transaction } from "@/lib/db";
import { error, handleError, HttpError, json, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/account/password {currentPassword, newPassword} -> 200 {ok: true}
 * Checks the current password, stores the new hash, signs out every session of the account
 * and issues a fresh session (cookie) for this browser. 400 wrong current password | 401 | 429.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const body = await parseJson(req, passwordChangeSchema, { maxBytes: 10_000 });

    // Count the attempt before the (slow) check, so a burst cannot slip past the limit.
    const limit = getAuthLimiters().passwordChange.hit(user.id);
    if (!limit.allowed) {
      return error(429, "Too many password attempts. Try again later.", {
        "retry-after": String(Math.max(1, limit.retryAfterS)),
      });
    }

    const row = findUserById(user.id);
    if (!row) throw new HttpError(401, "Not signed in");
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
      return error(400, WRONG_CURRENT_PASSWORD);
    }

    const hash = await hashPassword(body.newPassword);
    transaction(() => {
      updatePasswordHash(user.id, hash);
      deleteSessionsForUser(user.id);
    });
    await createSession(user.id);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
