import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { all, get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { getAuthLimiters, verifyPassword } from "@/lib/auth";
import { hashToken, insertSession } from "@/lib/auth/session";
import { FakeCookieStore } from "@/lib/auth/test-cookies";
import { createUser, findUserById } from "@/lib/auth/users";
import { newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs/queue";
import { mockProviders } from "@/lib/jobs/test-helpers";
import { runUntilIdle, silentLogger } from "@/lib/jobs/worker";
import { writeAudio } from "@/lib/storage/audio";
import { POST as createPlaylistPOST } from "../playlists/route";
import { DELETE as accountDELETE } from "./route";
import { POST as passwordPOST } from "./password/route";
import { POST as logoutAllPOST } from "./logout-all/route";

const store = vi.hoisted(() => ({ current: null as unknown as FakeCookieStore }));
vi.mock("next/headers", () => ({ cookies: async () => store.current }));
store.current = new FakeCookieStore();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-account-routes-"));
process.env.STORAGE_DIR = dir;
resetEnvCache();
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";

function request(method: "POST" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const changePassword = (body: unknown, headers?: Record<string, string>) =>
  passwordPOST(request("POST", "/api/account/password", body, headers));
const logoutAll = (headers?: Record<string, string>) => logoutAllPOST(request("POST", "/api/account/logout-all", {}, headers));
const deleteAcct = (body: unknown, headers?: Record<string, string>) =>
  accountDELETE(request("DELETE", "/api/account", body, headers));

interface Seeded {
  id: string;
  /** Session token of "this browser" (in the cookie jar). */
  token: string;
  /** Session token of another device. */
  other: string;
}

async function seedUser(): Promise<Seeded> {
  const user = await createUser(`acct-${newId()}@example.com`, PASSWORD);
  const token = insertSession(user.id).token;
  const other = insertSession(user.id).token;
  signIn(token);
  return { id: user.id, token, other };
}

function signIn(token: string | null) {
  store.current.reset();
  if (token) store.current.jar.set("rc_session", token);
}

const sessionExists = (token: string) => get("SELECT id FROM sessions WHERE id = ?", hashToken(token)) !== undefined;
const sessionCount = (userId: string) =>
  Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId)!.n);

beforeEach(() => {
  store.current.reset();
  getAuthLimiters().passwordChange.clear();
});

describe("POST /api/account/password", () => {
  it("changes the password, signs out every other session and issues a new one here", async () => {
    const u = await seedUser();
    const res = await changePassword({ currentPassword: PASSWORD, newPassword: "a brand new secret" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");

    const row = findUserById(u.id)!;
    expect(await verifyPassword("a brand new secret", row.password_hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(false);

    expect(sessionExists(u.token)).toBe(false);
    expect(sessionExists(u.other)).toBe(false);
    const fresh = store.current.jar.get("rc_session");
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(u.token);
    expect(sessionExists(fresh!)).toBe(true);
    expect(sessionCount(u.id)).toBe(1);
    expect(store.current.lastSet("rc_session")!.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("400 with a plain message when the current password is wrong; nothing changes", async () => {
    const u = await seedUser();
    const before = findUserById(u.id)!.password_hash;
    const res = await changePassword({ currentPassword: "not my password", newPassword: "a brand new secret" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Your current password is not right." });
    expect(findUserById(u.id)!.password_hash).toBe(before);
    expect(sessionExists(u.token)).toBe(true);
    expect(sessionExists(u.other)).toBe(true);
  });

  it("validates the new password length and the body", async () => {
    await seedUser();
    const short = await changePassword({ currentPassword: PASSWORD, newPassword: "short" });
    expect(short.status).toBe(400);
    expect((await short.json()).error).toMatch(/at least 8 characters/);
    expect((await changePassword({ currentPassword: PASSWORD, newPassword: "x".repeat(129) })).status).toBe(400);
    expect((await changePassword({ newPassword: "long enough pw" })).status).toBe(400);
    expect((await changePassword("{nope")).status).toBe(400);
    expect((await changePassword("x", { "content-type": "text/plain" })).status).toBe(415);
    expect((await changePassword({ currentPassword: "x".repeat(20_000), newPassword: "y" })).status).toBe(413);
  });

  it("401 signed out, 403 cross-origin", async () => {
    await seedUser();
    expect((await changePassword({ currentPassword: PASSWORD, newPassword: "new password 1" }, { origin: "https://evil.example" })).status).toBe(403);
    signIn(null);
    const res = await changePassword({ currentPassword: PASSWORD, newPassword: "new password 1" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });

  it("rate-limits attempts per user (10 / 15 min), even with the right password", async () => {
    const u = await seedUser();
    for (let i = 0; i < 10; i++) {
      expect((await changePassword({ currentPassword: `wrong-${i}`, newPassword: "new password 1" })).status).toBe(400);
    }
    const blocked = await changePassword({ currentPassword: PASSWORD, newPassword: "new password 1" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await verifyPassword(PASSWORD, findUserById(u.id)!.password_hash)).toBe(true);

    // another account is a different bucket
    await seedUser();
    expect((await changePassword({ currentPassword: PASSWORD, newPassword: "new password 1" })).status).toBe(200);
  });
});

describe("POST /api/account/logout-all", () => {
  it("deletes every session of the account and clears the cookie; others are untouched", async () => {
    const stranger = await seedUser();
    const u = await seedUser();
    const res = await logoutAll();
    expect(res.status).toBe(204);
    expect(sessionCount(u.id)).toBe(0);
    expect(store.current.jar.get("rc_session")).toBeUndefined();
    expect(store.current.lastSet("rc_session")!.options).toMatchObject({ maxAge: 0 });
    expect(sessionCount(stranger.id)).toBe(2);
  });

  it("401 signed out, 403 cross-origin", async () => {
    const u = await seedUser();
    expect((await logoutAll({ origin: "https://evil.example" })).status).toBe(403);
    expect(sessionCount(u.id)).toBe(2);
    signIn(null);
    expect((await logoutAll()).status).toBe(401);
  });
});

describe("DELETE /api/account", () => {
  async function drain() {
    return runUntilIdle({ resolve: mockProviders(), logger: silentLogger });
  }

  it("deletes the user, everything they own, their queued jobs and audio; clears the cookie", async () => {
    const stranger = await seedUser();
    const strangerPl = await (await createPlaylistPOST(request("POST", "/api/playlists", { url: "https://youtu.be/dQw4w9WgXcQ" }))).json();

    const u = await seedUser();
    const created = await createPlaylistPOST(request("POST", "/api/playlists", { url: "https://www.youtube.com/playlist?list=PLaccount0001" }));
    expect(created.status).toBe(201);
    const { id: playlistId } = await created.json();
    await drain();

    const episodes = all<{ id: string; audio_path: string | null }>(
      "SELECT id, audio_path FROM episodes WHERE playlist_id = ?",
      playlistId,
    );
    expect(episodes.length).toBe(3); // one clip per video
    expect(episodes.every((e) => e.audio_path === null)).toBe(true); // clips have no audio file
    // Legacy MP3s from the removed voiced episodes: the account delete still removes them.
    const files = episodes.map((e) => {
      const rel = `audio/${e.id}.mp3`;
      run("UPDATE episodes SET audio_path = ? WHERE id = ?", rel, e.id);
      return writeAudio(rel, new Uint8Array([1, 2, 3]));
    });
    expect(files.every((f) => fs.existsSync(f))).toBe(true);
    // A legacy card + review from the removed review feature: the account delete still cascades them.
    const legacyVideo = get<{ id: string }>("SELECT id FROM videos WHERE playlist_id = ? LIMIT 1", playlistId)!;
    const legacyCard = newId();
    run(
      `INSERT INTO cards (id, user_id, playlist_id, video_id, question, answer, source_start, due_at, interval_days, ease, reps, lapses, created_at)
       VALUES (?, ?, ?, ?, 'q', 'a', 0, 0, 0, 2.5, 0, 0, 0)`,
      legacyCard,
      u.id,
      playlistId,
      legacyVideo.id,
    );
    run("INSERT INTO reviews (id, card_id, rating, reviewed_at) VALUES (?, ?, 'good', 0)", newId(), legacyCard);

    // A legacy file at the canonical path whose audio_path was never stored (voicing was interrupted).
    run("UPDATE episodes SET audio_path = NULL WHERE id = ?", episodes[0].id);
    // Queued work for this account, and for the stranger.
    const video = get<{ id: string }>("SELECT id FROM videos WHERE playlist_id = ? LIMIT 1", playlistId)!;
    enqueue("process_video", { videoId: video.id });
    enqueue("ingest_playlist", { playlistId });
    enqueue("ingest_playlist", { playlistId: strangerPl.id });
    // The stranger's audio must survive.
    const strangerAudio = writeAudio(`audio/${newId()}.mp3`, new Uint8Array([1, 2, 3]));

    const res = await deleteAcct({ password: PASSWORD });
    expect(res.status).toBe(204);

    expect(findUserById(u.id)).toBeUndefined();
    for (const table of ["sessions", "playlists", "cards", "playlist_creations"]) {
      expect(Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, u.id)!.n)).toBe(0);
    }
    expect(get("SELECT id FROM videos WHERE playlist_id = ?", playlistId)).toBeUndefined();
    expect(get("SELECT id FROM episodes WHERE playlist_id = ?", playlistId)).toBeUndefined();
    expect(get("SELECT id FROM reviews WHERE card_id = ?", legacyCard)).toBeUndefined();
    expect(files.every((f) => !fs.existsSync(f))).toBe(true);

    const queued = all<{ payload_json: string }>("SELECT payload_json FROM jobs WHERE status = 'queued'");
    expect(queued.map((j) => JSON.parse(j.payload_json))).toEqual([{ playlistId: strangerPl.id }]);

    expect(store.current.jar.get("rc_session")).toBeUndefined();
    expect(store.current.lastSet("rc_session")!.options).toMatchObject({ maxAge: 0 });

    // The stranger is untouched.
    expect(findUserById(stranger.id)).toBeDefined();
    expect(sessionCount(stranger.id)).toBe(2);
    expect(get("SELECT id FROM playlists WHERE id = ?", strangerPl.id)).toBeDefined();
    expect(fs.existsSync(strangerAudio)).toBe(true);
  });

  it("400 for a wrong or missing password; nothing is deleted", async () => {
    const u = await seedUser();
    const wrong = await deleteAcct({ password: "not my password" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "Your current password is not right." });
    expect((await deleteAcct({})).status).toBe(400);
    expect((await deleteAcct({ password: "" })).status).toBe(400);
    expect((await deleteAcct({ password: "x".repeat(20_000) })).status).toBe(413);
    expect(findUserById(u.id)).toBeDefined();
    expect(sessionExists(u.token)).toBe(true);
  });

  it("401 signed out, 403 cross-origin, 429 after too many password attempts", async () => {
    const u = await seedUser();
    expect((await deleteAcct({ password: PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
    for (let i = 0; i < 10; i++) await deleteAcct({ password: `guess-${i}` });
    const blocked = await deleteAcct({ password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(findUserById(u.id)).toBeDefined();
    signIn(null);
    expect((await deleteAcct({ password: PASSWORD })).status).toBe(401);
  });
});
