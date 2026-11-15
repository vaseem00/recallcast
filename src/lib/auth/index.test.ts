import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { HttpError } from "@/lib/http";
import * as auth from "./index";
import { hashToken, SESSION_REFRESH_THRESHOLD_MS, SESSION_TTL_MS } from "./session";
import { FakeCookieStore } from "./test-cookies";

const store = vi.hoisted(() => ({ current: null as unknown as FakeCookieStore }));

vi.mock("next/headers", () => ({
  cookies: async () => store.current,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error("NEXT_REDIRECT") as Error & { digest: string };
    err.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw err;
  },
}));

store.current = new FakeCookieStore();

async function makeUser(email = `u${Math.random().toString(36).slice(2)}@example.com`) {
  return auth.createUser(email, "password123");
}

beforeEach(() => {
  store.current.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSession", () => {
  it("sets an httpOnly, SameSite=Lax, path=/ cookie with a 30-day maxAge and stores only the hash", async () => {
    const user = await makeUser();
    await auth.createSession(user.id);
    const set = store.current.lastSet(auth.SESSION_COOKIE)!;
    expect(set.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(set.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false });
    expect(set.options.maxAge).toBe(SESSION_TTL_MS / 1000);
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(set.value))).toBeDefined();
    expect(get("SELECT id FROM sessions WHERE id = ?", set.value)).toBeUndefined();
  });

  it("marks the cookie Secure in production", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    resetEnvCache();
    try {
      const user = await makeUser();
      await auth.createSession(user.id);
      expect(store.current.lastSet(auth.SESSION_COOKIE)!.options.secure).toBe(true);
    } finally {
      env.NODE_ENV = prev;
      resetEnvCache();
    }
  });

  it("revokes the session named by an existing cookie (no fixation)", async () => {
    const user = await makeUser();
    await auth.createSession(user.id);
    const first = store.current.lastSet(auth.SESSION_COOKIE)!.value;
    await auth.createSession(user.id);
    const second = store.current.lastSet(auth.SESSION_COOKIE)!.value;
    expect(second).not.toBe(first);
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(first))).toBeUndefined();
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(second))).toBeDefined();
  });
});

describe("getCurrentUser / requireUser / requireUserPage", () => {
  it("returns null without a cookie or with a bogus one", async () => {
    expect(await auth.getCurrentUser()).toBeNull();
    store.current.jar.set(auth.SESSION_COOKIE, "garbage");
    expect(await auth.getCurrentUser()).toBeNull();
  });

  it("returns the public user (no password hash) for a valid session", async () => {
    const user = await makeUser("Public@Example.com");
    await auth.createSession(user.id);
    const me = await auth.getCurrentUser();
    expect(me).toEqual({ id: user.id, email: "public@example.com", createdAt: user.createdAt });
    expect(Object.keys(me!)).toEqual(["id", "email", "createdAt"]);
  });

  it("requireUser throws HttpError(401) when signed out", async () => {
    await expect(auth.requireUser()).rejects.toBeInstanceOf(HttpError);
    await expect(auth.requireUser()).rejects.toMatchObject({ status: 401 });
  });

  it("requireUserPage redirects to /login, keeping only safe relative next paths", async () => {
    await expect(auth.requireUserPage()).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
    await expect(auth.requireUserPage("/app/p/1")).rejects.toMatchObject({
      digest: expect.stringContaining("/login?next=%2Fapp%2Fp%2F1"),
    });
    await expect(auth.requireUserPage("//evil.example")).rejects.toMatchObject({
      digest: expect.stringContaining(";/login;"),
    });
    const user = await makeUser();
    await auth.createSession(user.id);
    await expect(auth.requireUserPage()).resolves.toMatchObject({ id: user.id });
  });

  it("slides the expiry (DB + cookie) in the second half of the session's life", async () => {
    const user = await makeUser();
    const t0 = Date.now();
    await auth.createSession(user.id);
    const token = store.current.lastSet(auth.SESSION_COOKIE)!.value;
    const setsBefore = store.current.sets.length;

    vi.useFakeTimers({ toFake: ["Date"] });
    const later = t0 + SESSION_TTL_MS - SESSION_REFRESH_THRESHOLD_MS + 60_000;
    vi.setSystemTime(later);
    expect(await auth.getCurrentUser()).not.toBeNull();
    expect(store.current.sets.length).toBe(setsBefore + 1);
    const refreshed = store.current.lastSet(auth.SESSION_COOKIE)!;
    expect(refreshed.value).toBe(token);
    expect(refreshed.options.maxAge).toBe(SESSION_TTL_MS / 1000);
    const row = get<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE id = ?", hashToken(token));
    expect(Number(row!.expires_at)).toBe(later + SESSION_TTL_MS);
  });

  it("does not refresh early in the session's life", async () => {
    const user = await makeUser();
    await auth.createSession(user.id);
    const n = store.current.sets.length;
    await auth.getCurrentUser();
    expect(store.current.sets.length).toBe(n);
  });

  it("skips the refresh (DB untouched) when cookies are read-only, as in a Server Component", async () => {
    const user = await makeUser();
    const t0 = Date.now();
    await auth.createSession(user.id);
    const token = store.current.lastSet(auth.SESSION_COOKIE)!.value;
    const before = get<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE id = ?", hashToken(token));

    store.current.readOnly = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0 + SESSION_TTL_MS - SESSION_REFRESH_THRESHOLD_MS + 60_000);
    expect(await auth.getCurrentUser()).toMatchObject({ id: user.id });
    const after = get<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE id = ?", hashToken(token));
    expect(Number(after!.expires_at)).toBe(Number(before!.expires_at));
  });

  it("rejects an expired session", async () => {
    const user = await makeUser();
    const t0 = Date.now();
    await auth.createSession(user.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0 + SESSION_TTL_MS + 1000);
    expect(await auth.getCurrentUser()).toBeNull();
  });

  it("returns null once the user is deleted", async () => {
    const user = await makeUser();
    await auth.createSession(user.id);
    run("DELETE FROM users WHERE id = ?", user.id);
    expect(await auth.getCurrentUser()).toBeNull();
  });
});

describe("destroySession", () => {
  it("deletes the session row and clears the cookie", async () => {
    const user = await makeUser();
    await auth.createSession(user.id);
    const token = store.current.lastSet(auth.SESSION_COOKIE)!.value;
    await auth.destroySession();
    expect(get("SELECT id FROM sessions WHERE id = ?", hashToken(token))).toBeUndefined();
    const cleared = store.current.lastSet(auth.SESSION_COOKIE)!;
    expect(cleared.value).toBe("");
    expect(cleared.options).toMatchObject({ maxAge: 0, httpOnly: true, path: "/" });
    expect(await auth.getCurrentUser()).toBeNull();
  });

  it("is safe when signed out", async () => {
    await expect(auth.destroySession()).resolves.toBeUndefined();
  });

  it("an old cookie replayed after logout does not authenticate", async () => {
    const user = await makeUser();
    await auth.createSession(user.id);
    const token = store.current.lastSet(auth.SESSION_COOKIE)!.value;
    await auth.destroySession();
    store.current.jar.set(auth.SESSION_COOKIE, token);
    expect(await auth.getCurrentUser()).toBeNull();
  });
});

describe("authenticate", () => {
  it("accepts the right password (case-insensitive email) and rejects others", async () => {
    const user = await makeUser("Login@Example.com");
    expect(await auth.authenticate("login@example.com", "password123")).toMatchObject({ id: user.id });
    expect(await auth.authenticate("  LOGIN@example.COM ", "password123")).toMatchObject({ id: user.id });
    expect(await auth.authenticate("login@example.com", "password124")).toBeNull();
    expect(await auth.authenticate("nobody@example.com", "password123")).toBeNull();
  });

  it("does scrypt work for unknown emails too (timing similar to a wrong password)", async () => {
    await makeUser("timing@example.com");
    await auth.authenticate("warmup@example.com", "x"); // build the dummy hash once
    const time = async (fn: () => Promise<unknown>) => {
      const s = performance.now();
      for (let i = 0; i < 3; i++) await fn();
      return performance.now() - s;
    };
    const unknown = await time(() => auth.authenticate("nobody@example.com", "password123"));
    const wrong = await time(() => auth.authenticate("timing@example.com", "wrong-password"));
    // Both do one scrypt derivation; neither path should be an order of magnitude cheaper.
    expect(unknown).toBeGreaterThan(wrong / 5);
    expect(wrong).toBeGreaterThan(unknown / 5);
  });
});

describe("createUser", () => {
  it("normalises the email and rejects duplicates case-insensitively", async () => {
    const u = await auth.createUser("  Dup@Example.COM ", "password123");
    expect(u.email).toBe("dup@example.com");
    await expect(auth.createUser("DUP@example.com", "password123")).rejects.toBeInstanceOf(auth.EmailTakenError);
    const row = get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", u.id);
    expect(row!.password_hash.startsWith("scrypt$16384$8$1$")).toBe(true);
  });
});
