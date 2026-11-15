import { beforeEach, describe, expect, it, vi } from "vitest";
import { get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { getAuthLimiters } from "@/lib/auth";
import { SqliteRateLimiter } from "@/lib/auth/rate-limit";
import { hashToken } from "@/lib/auth/session";
import { PEER_HEADER, peerHeaderValue } from "@/lib/auth/peer";
import { FakeCookieStore } from "@/lib/auth/test-cookies";
import { POST as signup } from "./signup/route";
import { POST as login } from "./login/route";
import { POST as logout } from "./logout/route";
import { GET as me } from "../me/route";

const store = vi.hoisted(() => ({ current: null as unknown as FakeCookieStore }));
vi.mock("next/headers", () => ({ cookies: async () => store.current }));

store.current = new FakeCookieStore();

const ORIGIN = "http://localhost:3000";
/** Headers as installPeerStamp() would set them for a request from TCP peer `ip`. */
const peer = (ip: string) => ({ [PEER_HEADER]: peerHeaderValue(ip) });

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...peer("203.0.113.9"), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const cookieValue = () => store.current.jar.get("rc_session");
const signupEvents = () => Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM signup_events")!.n);

beforeEach(() => {
  store.current.reset();
  const l = getAuthLimiters();
  l.loginIp.clear();
  l.loginIpEmail.clear();
  l.loginEmail.clear();
  l.signupIp.clear();
  l.passwordChange.clear();
});

describe("POST /api/auth/signup", () => {
  it("creates the user, signs them in and returns 201 {user} with a normalised email", async () => {
    const res = await signup(post("/api/auth/signup", { email: "  New.User@Example.COM ", password: "password123" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user).toMatchObject({ email: "new.user@example.com" });
    expect(Object.keys(body.user).sort()).toEqual(["createdAt", "email", "id"]);
    expect(JSON.stringify(body)).not.toMatch(/scrypt|password/);
    expect(cookieValue()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(cookieValue()!))).toBeDefined();
  });

  it("validates email and password length (8-128)", async () => {
    const cases = [
      { email: "not-an-email", password: "password123" },
      { email: "a@example.com", password: "short" },
      { email: "a@example.com", password: "x".repeat(129) },
      { email: "a@example.com" },
      {},
    ];
    for (const c of cases) {
      const res = await signup(post("/api/auth/signup", c));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    const ok = await signup(post("/api/auth/signup", { email: "len@example.com", password: "x".repeat(128) }));
    expect(ok.status).toBe(201);
    expect(cookieValue()).toBeDefined();
  });

  it("rejects duplicates case-insensitively with 409", async () => {
    await signup(post("/api/auth/signup", { email: "dupe@example.com", password: "password123" }));
    const res = await signup(post("/api/auth/signup", { email: "DUPE@example.com", password: "password456" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/);
  });

  it("rejects cross-origin requests and non-JSON bodies", async () => {
    const res = await signup(
      post("/api/auth/signup", { email: "x@example.com", password: "password123" }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    const res2 = await signup(
      post("/api/auth/signup", "email=x", { "content-type": "application/x-www-form-urlencoded" }),
    );
    expect(res2.status).toBe(415);
    const res3 = await signup(post("/api/auth/signup", "{not json"));
    expect(res3.status).toBe(400);
  });

  it("rate-limits sign-ups per IP", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await signup(
        post("/api/auth/signup", { email: `burst${i}@example.com`, password: "password123" }, peer("198.51.100.1")),
      );
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("a duplicate-email 409 still counts against the per-IP sign-up limit and records no sign-up", async () => {
    const ip = peer("198.51.100.42");
    expect((await signup(post("/api/auth/signup", { email: "enum@example.com", password: "password123" }, ip))).status).toBe(201);
    const events = signupEvents();
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await signup(post("/api/auth/signup", { email: "enum@example.com", password: "password123" }, ip))).status);
    }
    expect(codes.slice(0, 9).every((c) => c === 409)).toBe(true);
    expect(codes[9]).toBe(429); // 1 + 9 attempts used the 10 / hour; the probe is now blocked
    expect(signupEvents()).toBe(events);
  });

  it("the site-wide daily sign-up cap returns 429 for new and existing emails alike", async () => {
    await signup(post("/api/auth/signup", { email: "early@example.com", password: "password123" }, peer("192.0.2.150")));
    process.env.MAX_SIGNUPS_PER_DAY = String(signupEvents() + 1);
    resetEnvCache();
    try {
      expect((await signup(post("/api/auth/signup", { email: "last-slot@example.com", password: "password123" }, peer("192.0.2.151")))).status).toBe(201);
      for (const email of ["one-too-many@example.com", "early@example.com"]) {
        const res = await signup(post("/api/auth/signup", { email, password: "password123" }, peer("192.0.2.152")));
        expect(res.status).toBe(429); // not 409: the cap refusal does not reveal that early@ exists
        expect(await res.json()).toEqual({ error: "New sign-ups are paused for today. Try again tomorrow." });
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      expect(get("SELECT id FROM users WHERE email = ?", "one-too-many@example.com")).toBeUndefined();
      // deleting accounts does not free a slot (the ledger is append-only)...
      run("DELETE FROM users WHERE email = ?", "last-slot@example.com");
      expect((await signup(post("/api/auth/signup", { email: "freed@example.com", password: "password123" }, peer("192.0.2.153")))).status).toBe(429);
      // ...but sign-ups older than 24 h stop counting
      run("UPDATE signup_events SET created_at = ?", Date.now() - 25 * 60 * 60 * 1000);
      expect((await signup(post("/api/auth/signup", { email: "next-day@example.com", password: "password123" }, peer("192.0.2.153")))).status).toBe(201);
    } finally {
      delete process.env.MAX_SIGNUPS_PER_DAY;
      resetEnvCache();
    }
  });

  it("per-IP sign-up limits persist across a new limiter instance (restart)", async () => {
    for (let i = 0; i < 10; i++) {
      await signup(post("/api/auth/signup", { email: `restart${i}@example.com`, password: "password123" }, peer("198.51.100.200")));
    }
    const fresh = new SqliteRateLimiter({ bucket: "signupIp", limit: 10, windowMs: 60 * 60 * 1000 });
    expect(fresh.check("198.51.100.200").allowed).toBe(false);
  });

  it("a new X-Forwarded-For per request does not get a fresh sign-up bucket", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await signup(
        post(
          "/api/auth/signup",
          { email: `spoof${i}@example.com`, password: "password123" },
          { ...peer("198.51.100.77"), "x-forwarded-for": `10.9.${i}.${i}`, "x-real-ip": `10.8.${i}.${i}` },
        ),
      );
      codes.push(res.status);
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe("POST /api/auth/login", () => {
  async function seed(email: string, password = "password123") {
    await signup(post("/api/auth/signup", { email, password }));
    store.current.reset();
  }

  it("logs in with the right password (any email case) and sets a fresh cookie", async () => {
    await seed("login@example.com");
    const res = await login(post("/api/auth/login", { email: "LOGIN@example.com", password: "password123" }));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("login@example.com");
    const set = store.current.lastSet("rc_session")!;
    expect(set.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("uses one generic message for wrong password and unknown email", async () => {
    await seed("generic@example.com");
    const wrong = await login(post("/api/auth/login", { email: "generic@example.com", password: "nope-nope" }));
    const unknown = await login(post("/api/auth/login", { email: "ghost@example.com", password: "password123" }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Invalid email or password" });
    expect(await unknown.json()).toEqual({ error: "Invalid email or password" });
    expect(cookieValue()).toBeUndefined();
  });

  it("allows 10 attempts per IP+email per 15 min, then 429 even with the right password", async () => {
    await seed("brute@example.com");
    for (let i = 0; i < 10; i++) {
      const r = await login(post("/api/auth/login", { email: "brute@example.com", password: `wrong-${i}-pw` }));
      expect(r.status).toBe(401);
    }
    const blocked = await login(post("/api/auth/login", { email: "brute@example.com", password: "password123" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(cookieValue()).toBeUndefined();

    // A different IP for the same email is a different bucket.
    const other = await login(
      post("/api/auth/login", { email: "brute@example.com", password: "password123" }, peer("192.0.2.44")),
    );
    expect(other.status).toBe(200);
  });

  it("a successful login resets the IP+email bucket", async () => {
    await seed("reset@example.com");
    for (let i = 0; i < 9; i++) {
      await login(post("/api/auth/login", { email: "reset@example.com", password: "wrong-password" }));
    }
    expect((await login(post("/api/auth/login", { email: "reset@example.com", password: "password123" }))).status).toBe(200);
    expect((await login(post("/api/auth/login", { email: "reset@example.com", password: "wrong-password" }))).status).toBe(401);
  });

  it("hits blocked by the IP+email limit do not count against the account's per-email limit", async () => {
    await seed("hammer@example.com");
    for (let i = 0; i < 60; i++) {
      await login(post("/api/auth/login", { email: "hammer@example.com", password: `wrong-${i}-pw` }));
    }
    const owner = await login(
      post("/api/auth/login", { email: "hammer@example.com", password: "password123" }, peer("192.0.2.200")),
    );
    expect(owner.status).toBe(200);
  });

  it("strangers failing on purpose cannot lock the owner out of a device that signed in before", async () => {
    await seed("victim@example.com");
    const ok = await login(post("/api/auth/login", { email: "victim@example.com", password: "password123" }, peer("192.0.2.1")));
    expect(ok.status).toBe(200);
    const device = store.current.jar.get("rc_device");
    expect(device).toBeTruthy();
    expect(store.current.lastSet("rc_device")!.options).toMatchObject({ httpOnly: true, path: "/api/auth" });

    // 5 attacker IPs x 10 wrong passwords = the per-email cap (50 / 15 min)
    store.current.reset();
    for (let ip = 0; ip < 5; ip++) {
      for (let i = 0; i < 10; i++) {
        await login(post("/api/auth/login", { email: "victim@example.com", password: `guess-${i}-x` }, peer(`198.18.0.${ip}`)));
      }
    }
    // a browser with no history for this account is held back (distributed guessing stays capped)
    const fresh = await login(post("/api/auth/login", { email: "victim@example.com", password: "password123" }, peer("192.0.2.2")));
    expect(fresh.status).toBe(429);
    // the owner's known device still gets in with the right password
    store.current.reset();
    store.current.jar.set("rc_device", device!);
    const owner = await login(post("/api/auth/login", { email: "victim@example.com", password: "password123" }, peer("192.0.2.3")));
    expect(owner.status).toBe(200);
    // a device cookie for another account does not help
    store.current.reset();
    await signup(post("/api/auth/signup", { email: "other@example.com", password: "password123" }, peer("192.0.2.5")));
    const otherDevice = store.current.jar.get("rc_device")!;
    expect(otherDevice).toBeTruthy();
    expect(otherDevice).not.toBe(device);
    store.current.reset();
    store.current.jar.set("rc_device", otherDevice);
    expect(
      (await login(post("/api/auth/login", { email: "victim@example.com", password: "password123" }, peer("192.0.2.4")))).status,
    ).toBe(429);
  });

  it("caps login attempts per IP across many emails (credential stuffing)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 101; i++) {
      const r = await login(post("/api/auth/login", { email: `stuff${i}@example.com`, password: "password123" }, peer("203.0.113.66")));
      codes.push(r.status);
    }
    expect(codes.slice(0, 100).every((c) => c === 401)).toBe(true);
    expect(codes[100]).toBe(429);
    // another IP is unaffected
    expect((await login(post("/api/auth/login", { email: "stuff0@example.com", password: "x" }, peer("203.0.113.67")))).status).toBe(401);
  }, 60_000);

  it("rejects cross-origin login (login CSRF)", async () => {
    await seed("csrf@example.com");
    const res = await login(
      post("/api/auth/login", { email: "csrf@example.com", password: "password123" }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/me and POST /api/auth/logout", () => {
  it("me is 401 signed out, {user} signed in, and 401 again after logout", async () => {
    const out = await me();
    expect(out.status).toBe(401);
    expect(await out.json()).toEqual({ error: "Not signed in" });

    await signup(post("/api/auth/signup", { email: "me@example.com", password: "password123" }));
    const token = cookieValue()!;
    const res = await me();
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("me@example.com");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const lo = await logout(post("/api/auth/logout", undefined));
    expect(lo.status).toBe(204);
    expect(cookieValue()).toBeUndefined();
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(token))).toBeUndefined();
    expect((await me()).status).toBe(401);
  });

  it("logout is idempotent and same-origin protected", async () => {
    expect((await logout(post("/api/auth/logout", undefined))).status).toBe(204);
    expect((await logout(post("/api/auth/logout", undefined, { origin: "https://evil.example" }))).status).toBe(403);
  });
});
