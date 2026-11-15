import {
  assertSameOrigin,
  authenticate,
  clientIp,
  createSession,
  getAuthLimiters,
  loginSchema,
  rememberDevice,
  requestIsKnownDevice,
} from "@/lib/auth";
import { error, handleError, json, parseJson } from "@/lib/http";

export const runtime = "nodejs";

const INVALID = "Invalid email or password";

function tooMany(retryAfterS: number): Response {
  return error(429, "Too many login attempts. Try again later.", { "retry-after": String(Math.max(1, retryAfterS)) });
}

/** POST /api/auth/login {email, password} -> 200 {user} | 401 | 429 */
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const body = await parseJson(req, loginSchema, { maxBytes: 10_000 });

    // Count every attempt BEFORE verifying, so parallel bursts cannot slip past the limit.
    // Order matters: a hit blocked by a narrower limiter is not counted by the wider ones, so
    // one client hammering one account cannot push that account's per-email counter.
    const limiters = getAuthLimiters();
    const ip = clientIp(req);
    const perIp = limiters.loginIp.hit(ip);
    if (!perIp.allowed) return tooMany(perIp.retryAfterS);
    const pairKey = `${ip}|${body.email}`;
    const pair = limiters.loginIpEmail.hit(pairKey);
    if (!pair.allowed) return tooMany(pair.retryAfterS);
    // A browser that signed in to this account before is exempt from the per-email limit, so a
    // stranger failing on purpose cannot lock the owner out.
    if (!(await requestIsKnownDevice(body.email))) {
      const perEmail = limiters.loginEmail.hit(body.email);
      if (!perEmail.allowed) return tooMany(perEmail.retryAfterS);
    }

    const user = await authenticate(body.email, body.password);
    if (!user) return error(401, INVALID);

    limiters.loginIpEmail.reset(pairKey);
    await createSession(user.id);
    await rememberDevice(user.email);
    return json({ user }, 200);
  } catch (err) {
    return handleError(err);
  }
}
