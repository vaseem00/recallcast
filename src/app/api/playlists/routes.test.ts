import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { all, get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { insertSession } from "@/lib/auth/session";
import { FakeCookieStore } from "@/lib/auth/test-cookies";
import { newId } from "@/lib/ids";
import { writeAudio } from "@/lib/storage/audio";
import { runUntilIdle, silentLogger } from "@/lib/jobs/worker";
import { mockProviders } from "@/lib/jobs/test-helpers";
import { GET as listGET, POST as createPOST } from "./route";
import { DELETE as detailDELETE, GET as detailGET } from "./[id]/route";
import { POST as retryPOST } from "./[id]/retry/route";
import { POST as transcriptPOST } from "../videos/[id]/transcript/route";

const store = vi.hoisted(() => ({ current: null as unknown as FakeCookieStore }));
vi.mock("next/headers", () => ({ cookies: async () => store.current }));
store.current = new FakeCookieStore();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-playlist-routes-"));
process.env.STORAGE_DIR = dir;
resetEnvCache();
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ORIGIN = "http://localhost:3000";
const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLroutes00001";

function seedUser(email: string): { id: string; token: string } {
  const id = newId();
  run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)", id, email, Date.now());
  return { id, token: insertSession(id).token };
}

function signIn(u: { token: string } | null) {
  store.current.reset();
  if (u) store.current.jar.set("rc_session", u.token);
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function create(url = PLAYLIST_URL): Promise<Response> {
  return createPOST(post("/api/playlists", { url }));
}

async function drain() {
  return runUntilIdle({ resolve: mockProviders(), logger: silentLogger });
}

let alice: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(() => {
  alice = seedUser(`alice-${newId()}@example.com`);
  bob = seedUser(`bob-${newId()}@example.com`);
  signIn(alice);
});

describe("POST /api/playlists", () => {
  it("401 when signed out", async () => {
    signIn(null);
    const res = await create();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });

  it("403 for cross-origin requests", async () => {
    const res = await createPOST(post("/api/playlists", { url: PLAYLIST_URL }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(all("SELECT id FROM playlists WHERE user_id = ?", alice.id)).toHaveLength(0);
  });

  it("400 for bad bodies and non-YouTube links", async () => {
    for (const body of [{}, { url: "" }, { url: 42 }, { url: "https://vimeo.com/123" }, { url: "dQw4w9WgXcQ" }]) {
      const res = await createPOST(post("/api/playlists", body));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect((await createPOST(post("/api/playlists", "{not json"))).status).toBe(400);
    const wrongType = new Request(`${ORIGIN}/api/playlists`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: ORIGIN },
      body: "x",
    });
    expect((await createPOST(wrongType)).status).toBe(415);
  });

  it("201 { id }, stores a canonical URL and enqueues ingest", async () => {
    const res = await create("  https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLroutes00001&utm=x  ");
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const row = get<{ source_url: string; kind: string; youtube_playlist_id: string; status: string; user_id: string }>(
      "SELECT * FROM playlists WHERE id = ?",
      id,
    )!;
    expect(row).toMatchObject({
      source_url: "https://www.youtube.com/playlist?list=PLroutes00001",
      kind: "playlist",
      youtube_playlist_id: "PLroutes00001",
      status: "queued",
      user_id: alice.id,
    });
    const job = get<{ payload_json: string }>("SELECT payload_json FROM jobs WHERE type = 'ingest_playlist' AND payload_json LIKE ?", `%${id}%`);
    expect(JSON.parse(job!.payload_json)).toEqual({ playlistId: id });

    const v = await create("https://youtu.be/dQw4w9WgXcQ");
    const vrow = get<{ source_url: string; kind: string; youtube_playlist_id: string | null }>(
      "SELECT * FROM playlists WHERE id = ?",
      (await v.json()).id,
    )!;
    expect(vrow).toEqual(expect.objectContaining({ source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "video", youtube_playlist_id: null }));
  });

  it("429 after the daily cap (5 per rolling 24h)", async () => {
    for (let i = 0; i < 5; i++) expect((await create()).status).toBe(201);
    const res = await create();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/up to 5 playlists per day/);
    // older than 24h does not count
    run("UPDATE playlist_creations SET created_at = ? WHERE user_id = ?", Date.now() - 25 * 60 * 60 * 1000, alice.id);
    expect((await create()).status).toBe(201);
    // the cap is per user
    signIn(bob);
    expect((await create()).status).toBe(201);
  });

  // Before the fix the cap counted live playlists rows, so deleting freed the slot again.
  it("deleting playlists does not give daily-cap slots back", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await create();
      expect(res.status).toBe(201);
      ids.push((await res.json()).id);
    }
    for (const id of ids) {
      const del = await detailDELETE(new Request(`${ORIGIN}/api/playlists/${id}`, { method: "DELETE", headers: { origin: ORIGIN } }), ctx(id));
      expect(del.status).toBe(204);
    }
    expect(all("SELECT id FROM playlists WHERE user_id = ?", alice.id)).toHaveLength(0);
    const res = await create();
    expect(res.status).toBe(429);
    run("DELETE FROM jobs");
  });

  it("429 once the site-wide daily cap is reached, across users; deleting does not free a slot", async () => {
    const siteCount = () =>
      Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM playlist_events WHERE created_at > ?", Date.now() - 24 * 60 * 60 * 1000)!.n);
    process.env.MAX_PLAYLISTS_PER_DAY = String(siteCount() + 2);
    resetEnvCache();
    try {
      const a = await create();
      expect(a.status).toBe(201);
      signIn(bob);
      const b = await create();
      expect(b.status).toBe(201);
      const blocked = await create();
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: "RecallCast has reached today's limit for new playlists. Try again later." });
      // a third user with an unused per-user allowance is refused too
      const carol = seedUser(`carol-${newId()}@example.com`);
      signIn(carol);
      expect((await create()).status).toBe(429);
      expect(all("SELECT id FROM playlists WHERE user_id = ?", carol.id)).toHaveLength(0);

      // deleting the playlists does not hand the slots back
      for (const [u, res] of [[alice, a], [bob, b]] as const) {
        signIn(u);
        const { id } = await res.json();
        const del = await detailDELETE(new Request(`${ORIGIN}/api/playlists/${id}`, { method: "DELETE", headers: { origin: ORIGIN } }), ctx(id));
        expect(del.status).toBe(204);
      }
      signIn(alice);
      expect((await create()).status).toBe(429);

      // creations older than 24 h stop counting
      run("UPDATE playlist_creations SET created_at = ?", Date.now() - 25 * 60 * 60 * 1000);
      run("UPDATE playlist_events SET created_at = ?", Date.now() - 25 * 60 * 60 * 1000);
      expect((await create()).status).toBe(201);
    } finally {
      delete process.env.MAX_PLAYLISTS_PER_DAY;
      resetEnvCache();
      run("DELETE FROM jobs");
    }
  });
});

describe("GET /api/playlists and /api/playlists/[id]", () => {
  it("lists only the caller's playlists, with counts", async () => {
    const { id } = await (await create()).json();
    signIn(bob);
    await create("https://youtu.be/dQw4w9WgXcQ");
    signIn(alice);
    await drain();

    const res = await listGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { playlists } = await res.json();
    expect(playlists).toHaveLength(1);
    expect(playlists[0]).toMatchObject({ id, status: "ready", kind: "playlist" });
    expect(playlists[0].counts).toMatchObject({ total: 3, ready: 3, failed: 0, episodes: 3 });
    expect(playlists[0].counts).not.toHaveProperty("cards");
    expect(playlists[0]).not.toHaveProperty("user_id");
  });

  it("detail: playlist, videos, clip episodes and progress; 404 for others", async () => {
    const { id } = await (await create()).json();
    await drain();
    const res = await detailGET(new Request(`${ORIGIN}/api/playlists/${id}`), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.playlist).toMatchObject({ id, status: "ready" });
    expect(body.videos).toHaveLength(3);
    expect(body.videos[0]).not.toHaveProperty("knowledge");
    expect(body.videos[0].youtubeUrl).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    expect(body.episodes).toHaveLength(3);
    type Ep = { id: string; videoId: string; youtubeVideoId: string; clip: { start: number; end: number; picked: string }; durationS: number; excerpt: string };
    const eps = body.episodes as Ep[];
    // Clips in playlist order, one per video, each pointing at its video.
    expect(eps.map((e) => e.videoId)).toEqual(body.videos.map((v: { id: string }) => v.id));
    expect(eps.map((e) => e.youtubeVideoId)).toEqual(body.videos.map((v: { youtubeVideoId: string }) => v.youtubeVideoId));
    expect(body.videos.map((v: { episodeId: string }) => v.episodeId)).toEqual(eps.map((e) => e.id));
    for (const e of eps) {
      expect(e.clip.picked).toBe("heuristic");
      expect(e.durationS).toBe(e.clip.end - e.clip.start);
      expect(e.excerpt).toEqual(expect.any(String));
      expect(e).not.toHaveProperty("audioUrl");
    }
    expect(body.progress).toMatchObject({ total: 3, ready: 3, failed: 0 });

    signIn(bob);
    const other = await detailGET(new Request(`${ORIGIN}/api/playlists/${id}`), ctx(id));
    expect(other.status).toBe(404);
    expect((await detailGET(new Request(`${ORIGIN}/x`), ctx("../../etc"))).status).toBe(404);
    signIn(null);
    expect((await detailGET(new Request(`${ORIGIN}/x`), ctx(id))).status).toBe(401);
  });
});

describe("DELETE /api/playlists/[id]", () => {
  it("204, removes rows and legacy audio files; 404 for non-owners; 403 cross-origin", async () => {
    const { id } = await (await create()).json();
    await drain();
    // Clips have no audio; give the episodes legacy MP3s (removed voiced episodes) to check cleanup.
    const paths = all<{ id: string }>("SELECT id FROM episodes WHERE playlist_id = ?", id).map((r) => {
      const rel = `audio/${r.id}.mp3`;
      run("UPDATE episodes SET audio_path = ? WHERE id = ?", rel, r.id);
      return writeAudio(rel, new Uint8Array([1, 2, 3]));
    });
    expect(paths.length).toBe(3);
    expect(paths.every((p) => fs.existsSync(p))).toBe(true);

    const del = (headers: Record<string, string> = { origin: ORIGIN }) =>
      detailDELETE(new Request(`${ORIGIN}/api/playlists/${id}`, { method: "DELETE", headers }), ctx(id));

    expect((await del({ origin: "https://evil.example" })).status).toBe(403);
    signIn(bob);
    expect((await del()).status).toBe(404);
    signIn(alice);
    const res = await del();
    expect(res.status).toBe(204);
    expect(get("SELECT 1 AS x FROM playlists WHERE id = ?", id)).toBeUndefined();
    expect(paths.some((p) => fs.existsSync(p))).toBe(false);
    expect((await del()).status).toBe(404);
  });
});

describe("POST /api/playlists/[id]/retry", () => {
  it("202 and re-enqueues failed videos; 404 for non-owners", async () => {
    const { id } = await (await create()).json();
    await drain();
    const vid = get<{ id: string }>("SELECT id FROM videos WHERE playlist_id = ? ORDER BY position LIMIT 1", id)!.id;
    run("UPDATE videos SET status = 'failed', error = 'x' WHERE id = ?", vid);

    signIn(bob);
    expect((await retryPOST(post(`/api/playlists/${id}/retry`, {}), ctx(id))).status).toBe(404);
    signIn(alice);
    const res = await retryPOST(post(`/api/playlists/${id}/retry`, {}), ctx(id));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ retried: 1 });
    expect(get<{ status: string }>("SELECT status FROM videos WHERE id = ?", vid)!.status).toBe("pending");
    expect((await retryPOST(post(`/api/playlists/${id}/retry`, {}, { origin: "https://evil.example" }), ctx(id))).status).toBe(403);
    await drain();
    expect(get<{ status: string }>("SELECT status FROM playlists WHERE id = ?", id)!.status).toBe("ready");
  });

  // Before the fix every retry re-ran the failed (paid) steps with no limit.
  it("429 once every failed video has used its retries", async () => {
    const { id } = await (await create("https://youtu.be/vidRETRYCAP")).json();
    await drain();
    const vid = get<{ id: string }>("SELECT id FROM videos WHERE playlist_id = ?", id)!.id;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      run("UPDATE videos SET status = 'failed', error = 'x' WHERE id = ?", vid);
      const res = await retryPOST(post(`/api/playlists/${id}/retry`, {}), ctx(id));
      codes.push(res.status);
      if (res.status === 429) expect((await res.json()).error).toMatch(/already been retried 3 times/);
      run("DELETE FROM jobs");
    }
    expect(codes).toEqual([202, 202, 202, 429]);
  });
});

describe("POST /api/videos/[id]/transcript", () => {
  const TEXT = "Spaced repetition works because each review interrupts forgetting at the right moment. ".repeat(5);

  async function needsManualVideo(): Promise<{ playlistId: string; videoId: string }> {
    const { id } = await (await create("https://youtu.be/NOCAPvid001")).json();
    await drain();
    const v = get<{ id: string; transcript_status: string }>("SELECT id, transcript_status FROM videos WHERE playlist_id = ?", id)!;
    expect(v.transcript_status).toBe("needs_manual");
    return { playlistId: id, videoId: v.id };
  }

  it("202, stores a manual transcript and the video gets processed", async () => {
    const { playlistId, videoId } = await needsManualVideo();
    // Without captions the video still plays a default window, so it is ready.
    expect(get<{ status: string }>("SELECT status FROM videos WHERE id = ?", videoId)!.status).toBe("ready");
    expect(get<{ status: string }>("SELECT status FROM playlists WHERE id = ?", playlistId)!.status).toBe("ready");
    const res = await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: TEXT }), ctx(videoId));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ videoId, segments: expect.any(Number) });
    expect(get<{ source: string }>("SELECT source FROM transcripts WHERE video_id = ?", videoId)!.source).toBe("manual");
    expect(get<{ status: string }>("SELECT status FROM playlists WHERE id = ?", playlistId)!.status).toBe("processing");

    // while processing, a second paste is rejected
    const again = await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: TEXT }), ctx(videoId));
    expect(again.status).toBe(409);

    await drain();
    expect(get<{ status: string }>("SELECT status FROM videos WHERE id = ?", videoId)!.status).toBe("ready");
    expect(get<{ status: string }>("SELECT status FROM playlists WHERE id = ?", playlistId)!.status).toBe("ready");
  });

  it("validates input, ownership and origin", async () => {
    const { videoId } = await needsManualVideo();
    const send = (body: unknown, headers?: Record<string, string>) =>
      transcriptPOST(post(`/api/videos/${videoId}/transcript`, body, headers), ctx(videoId));

    expect((await send({ text: "" })).status).toBe(400);
    expect((await send({ text: "too short" })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    expect((await send({ text: TEXT }, { origin: "https://evil.example" })).status).toBe(403);
    signIn(bob);
    expect((await send({ text: TEXT })).status).toBe(404);
    signIn(null);
    expect((await send({ text: TEXT })).status).toBe(401);
    signIn(alice);
    const bad = await transcriptPOST(post(`/api/videos/x/transcript`, { text: TEXT }), ctx("not/valid"));
    expect(bad.status).toBe(404);
  });

  // Before the fix a ready video accepted a new paste, and each one re-ran the paid pipeline
  // (the clip pick) with no limit.
  it("409 for a video that is ready; one paste per needs_manual video", async () => {
    const { videoId } = await needsManualVideo();
    expect((await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: TEXT }), ctx(videoId))).status).toBe(202);
    await drain();
    expect(get<{ status: string }>("SELECT status FROM videos WHERE id = ?", videoId)!.status).toBe("ready");
    const again = await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: TEXT }), ctx(videoId));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already has a transcript/);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'")!.n).toBe(0);
  });

  it("re-pasting over a failed video's transcript uses up its retries", async () => {
    const { videoId } = await needsManualVideo();
    expect((await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: TEXT }), ctx(videoId))).status).toBe(202);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      run("DELETE FROM jobs");
      run("UPDATE videos SET status = 'failed' WHERE id = ?", videoId); // e.g. the AI refused this input
      codes.push((await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: TEXT }), ctx(videoId))).status);
    }
    expect(codes).toEqual([202, 202, 202, 429]);
    run("DELETE FROM jobs");
  });

  it("an unowned video id is refused before the text is parsed", async () => {
    const { videoId } = await needsManualVideo();
    signIn(bob);
    // too short for the parser, but ownership is checked first: 404, not 400
    expect((await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: "short" }), ctx(videoId))).status).toBe(404);
  });

  it("409 for skipped videos", async () => {
    const { videoId } = await needsManualVideo();
    run("UPDATE videos SET status = 'skipped' WHERE id = ?", videoId);
    const res = await transcriptPOST(post(`/api/videos/${videoId}/transcript`, { text: TEXT }), ctx(videoId));
    expect(res.status).toBe(409);
  });
});
