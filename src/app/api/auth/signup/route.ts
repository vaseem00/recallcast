import {
  assertSameOrigin,
  clientIp,
  createSession,
  createUser,
  EmailTakenError,
  getAuthLimiters,
  rememberDevice,
  signupSchema,
} from "@/lib/auth";
import { SignupsPausedError } from "@/lib/auth/users";
import { error, handleError, json, parseJson } from "@/lib/http";

export const runtime = "nodejs";

/** Retry-After for the site-wide cap: the window is a rolling 24 h, so suggest an hour. */
const PAUSED_RETRY_AFTER_S = 60 * 60;

/**
 * POST /api/auth/signup {email, password} -> 201 {user} | 409 (email taken) | 429
 *
 * The 409 reveals that an email is registered (kept: the UI relies on it and there is no email
 * verification). To make enumerating emails costly, every attempt, the 409 ones included, counts
 * against the per-IP limit before anything is checked, and createUser always hashes the password
 * first, so a 409 costs the caller as much as a real sign-up.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const body = await parseJson(req, signupSchema, { maxBytes: 10_000 });

    const limit = getAuthLimiters().signupIp.hit(clientIp(req));
    if (!limit.allowed) {
      return error(429, "Too many sign-up attempts. Try again later.", { "retry-after": String(limit.retryAfterS) });
    }

    let user;
    try {
      user = await createUser(body.email, body.password);
    } catch (err) {
      if (err instanceof SignupsPausedError) {
        return error(429, err.message, { "retry-after": String(PAUSED_RETRY_AFTER_S) });
      }
      if (err instanceof EmailTakenError) return error(409, err.message);
      throw err;
    }
    await createSession(user.id);
    await rememberDevice(user.email);
    return json({ user }, 201);
  } catch (err) {
    return handleError(err);
  }
}
