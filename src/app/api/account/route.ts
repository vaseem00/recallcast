import { assertSameOrigin, destroySession, getAuthLimiters, requireUser, verifyPassword } from "@/lib/auth";
import { findUserById } from "@/lib/auth/users";
import { deleteAccount, deleteAccountSchema, WRONG_CURRENT_PASSWORD } from "@/lib/account";
import { error, handleError, HttpError, noContent, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/account {password} -> 204
 * Confirms the password, cancels the account's queued jobs, deletes the user (the schema
 * cascades remove sessions, playlists, videos, episodes, legacy cards/reviews...), removes the audio
 * files and clears the cookie. 400 wrong password | 401 | 429 (shares the password limiter).
 */
export async function DELETE(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const body = await parseJson(req, deleteAccountSchema, { maxBytes: 10_000 });

    const limit = getAuthLimiters().passwordChange.hit(user.id);
    if (!limit.allowed) {
      return error(429, "Too many password attempts. Try again later.", {
        "retry-after": String(Math.max(1, limit.retryAfterS)),
      });
    }

    const row = findUserById(user.id);
    if (!row) throw new HttpError(401, "Not signed in");
    if (!(await verifyPassword(body.password, row.password_hash))) {
      return error(400, WRONG_CURRENT_PASSWORD);
    }

    deleteAccount(user.id);
    await destroySession();
    return noContent();
  } catch (err) {
    return handleError(err);
  }
}
