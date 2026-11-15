import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, get, run } from "@/lib/db";
import { insertSession } from "@/lib/auth/session";
import { FakeCookieStore } from "@/lib/auth/test-cookies";
import { newId } from "@/lib/ids";
import { runUntilIdle, silentLogger } from "@/lib/jobs/worker";
import { fakeYouTube, mkVideo, mockProviders } from "@/lib/jobs/test-helpers";
import { getSharedPage, type ReelFeed } from "@/lib/reels";
import { POST as createPOST } from "../playlists/route";
import { GET as detailGET } from "../playlists/[id]/route";
import { POST as recheckPOST } from "../playlists/[id]/recheck/route";
import { DELETE as feedShareDELETE, POST as feedSharePOST } from "../playlists/[id]/share/route";
import { GET as feedGET } from "./route";
import { PATCH as reelPATCH } from "./[id]/route";
import { DELETE as shareDELETE, POST as sharePOST } from "./[id]/share/route";

const store = vi.hoisted(() => ({ current: null as unknown as FakeCookieStore }));
vi.mock("next/headers", () => ({ cookies: async () => store.current }));
store.current = new FakeCookieStore();

const ORIGIN = "http://localhost:3000";

function seedUser(email: string): { id: string; token: string } {
  const id = newId();
  run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)", id, email, Date.now());
  return { id, token: insertSession(id).token };
}

function signIn(u: { token: string } | null) {
  store.current.reset();
  if (u) store.current.jar.set("rc_session", u.token);
}

function send(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const feed = async (query = ""): Promise<ReelFeed> => (await feedGET(send("GET", `/api/reels${query}`))).json();

/** A ready playlist of two videos with captions and one without, processed with the mock providers. */
async function playlist(): Promise<string> {
  const res = await createPOST(send("POST", "/api/playlists", { url: "https://www.youtube.com/playlist?list=PLreelroute01" }));
  const { id } = await res.json();
  const videos = [mkVideo("vidROUTE001", 0), mkVideo("vidROUTE002", 1), mkVideo("NOCAProute1", 2)];
  await runUntilIdle({ resolve: mockProviders({ youtube: fakeYouTube(videos, { title: "Route Series" }) }), logger: silentLogger });
  return id;
}

let alice: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(() => {
  alice = seedUser(`alice-${newId()}@example.com`);
  bob = seedUser(`bob-${newId()}@example.com`);
  signIn(alice);
});

describe("GET /api/reels", () => {
  it("401 when signed out", async () => {
    signIn(null);
    expect((await feedGET(send("GET", "/api/reels"))).status).toBe(401);
  });

  it("returns only the caller's reels; filters by playlist and by saved", async () => {
    const id = await playlist();
    const mine = await feed();
    expect(mine.reels.length).toBeGreaterThanOrEqual(2);
    expect(mine).toMatchObject({ total: mine.reels.length, pending: 0, videos: 3, noCaptions: 1 });
    expect(mine.reels.every((r) => r.playlistId === id && r.playlistTitle === "Route Series")).toBe(true);
    expect((await feed(`?playlist=${id}`)).total).toBe(mine.total);
    expect((await feed(`?playlist=${newId()}`)).total).toBe(0);
    expect((await feed("?saved=1")).total).toBe(0);
    expect((await feedGET(send("GET", "/api/reels?playlist=../x"))).status).toBe(400);

    signIn(bob);
    expect(await feed()).toMatchObject({ reels: [], total: 0, videos: 0 });
    expect((await feed(`?playlist=${id}`)).total).toBe(0);
  });
});

describe("PATCH /api/reels/[id]", () => {
  it("saves, unsaves and marks seen", async () => {
    await playlist();
    const reel = (await feed()).reels[0];
    let res = await reelPATCH(send("PATCH", `/api/reels/${reel.id}`, { saved: true }), ctx(reel.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, seen: false });
    expect((await feed("?saved=1")).reels.map((r) => r.id)).toEqual([reel.id]);

    res = await reelPATCH(send("PATCH", `/api/reels/${reel.id}`, { seen: true }), ctx(reel.id));
    expect(await res.json()).toEqual({ saved: true, seen: true });
    expect((await feed()).reels.at(-1)!.id).toBe(reel.id); // seen moves to the back

    res = await reelPATCH(send("PATCH", `/api/reels/${reel.id}`, { saved: false }), ctx(reel.id));
    expect(await res.json()).toEqual({ saved: false, seen: true });
  });

  it("takes a viewing report: seconds played, played to the end, swiped away early", async () => {
    await playlist();
    const [a, b] = (await feed()).reels;
    let res = await reelPATCH(send("PATCH", `/api/reels/${a.id}`, { watched: 42.6, completed: true }), ctx(a.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: false, seen: true });
    res = await reelPATCH(send("PATCH", `/api/reels/${b.id}`, { skipped: true }), ctx(b.id));
    expect(res.status).toBe(200);
    const row = (id: string) => get<{ watch_s: number; completions: number; skips: number }>("SELECT watch_s, completions, skips FROM moments WHERE id = ?", id)!;
    expect(row(a.id)).toEqual({ watch_s: 43, completions: 1, skips: 0 });
    expect(row(b.id)).toEqual({ watch_s: 0, completions: 0, skips: 1 });
    for (const body of [{ watched: -1 }, { watched: 601 }, { watched: "10" }, { completed: false }, { skipped: 1 }]) {
      expect((await reelPATCH(send("PATCH", `/api/reels/${a.id}`, body), ctx(a.id))).status).toBe(400);
    }
    signIn(bob);
    expect((await reelPATCH(send("PATCH", `/api/reels/${a.id}`, { watched: 10 }), ctx(a.id))).status).toBe(404);
    expect(row(a.id).watch_s).toBe(43);
  });

  it("401 signed out, 403 cross-origin, 400 bad body, 404 for another user's reel or a bad id", async () => {
    await playlist();
    const reel = (await feed()).reels[0];
    const path = `/api/reels/${reel.id}`;
    for (const body of [{}, { seen: false }, { saved: "yes" }, { saved: true, extra: 1 }, "{not json"]) {
      expect((await reelPATCH(send("PATCH", path, body), ctx(reel.id))).status).toBe(400);
    }
    expect((await reelPATCH(send("PATCH", path, { saved: true }, { origin: "https://evil.example" }), ctx(reel.id))).status).toBe(403);
    expect((await reelPATCH(send("PATCH", "/api/reels/x", { saved: true }), ctx("../etc"))).status).toBe(404);
    expect((await reelPATCH(send("PATCH", "/api/reels/x", { saved: true }), ctx(newId()))).status).toBe(404);

    signIn(bob);
    const res = await reelPATCH(send("PATCH", path, { saved: true }), ctx(reel.id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Reel not found" });
    signIn(null);
    expect((await reelPATCH(send("PATCH", path, { saved: true }), ctx(reel.id))).status).toBe(401);
    expect(get<{ saved_at: number | null }>("SELECT saved_at FROM moments WHERE id = ?", reel.id)!.saved_at).toBeNull();
  });
});

describe("share links", () => {
  it("POST makes a reel public at /r/<slug>, DELETE revokes it", async () => {
    await playlist();
    const reel = (await feed()).reels[0];
    const res = await sharePOST(send("POST", `/api/reels/${reel.id}/share`, {}), ctx(reel.id));
    expect(res.status).toBe(200);
    const { slug, path } = await res.json();
    expect(slug).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(path).toBe(`/r/${slug}`);
    expect(getSharedPage(slug)?.reels[0].id).toBe(reel.id);
    expect((await feed()).reels.find((r) => r.id === reel.id)!.shareSlug).toBe(slug);

    const again = await (await sharePOST(send("POST", `/api/reels/${reel.id}/share`, {}), ctx(reel.id))).json();
    expect(again.slug).toBe(slug);

    expect((await shareDELETE(send("DELETE", `/api/reels/${reel.id}/share`), ctx(reel.id))).status).toBe(204);
    expect(getSharedPage(slug)).toBeNull();
  });

  it("POST /api/playlists/[id]/share makes the playlist's reels a public feed; the detail reports it", async () => {
    const id = await playlist();
    const total = (await feed()).total;
    let detail = await (await detailGET(send("GET", `/api/playlists/${id}`), ctx(id))).json();
    expect(detail.shareSlug).toBeNull();
    expect(detail.reels).toEqual({ ready: total, pending: 0 });

    const { slug, path } = await (await feedSharePOST(send("POST", `/api/playlists/${id}/share`, {}), ctx(id))).json();
    expect(path).toBe(`/r/${slug}`);
    expect(getSharedPage(slug)).toMatchObject({ kind: "playlist", title: "Route Series" });
    expect(getSharedPage(slug)!.reels).toHaveLength(total);
    detail = await (await detailGET(send("GET", `/api/playlists/${id}`), ctx(id))).json();
    expect(detail.shareSlug).toBe(slug);

    expect((await feedShareDELETE(send("DELETE", `/api/playlists/${id}/share`), ctx(id))).status).toBe(204);
    expect(getSharedPage(slug)).toBeNull();
  });

  it("401 signed out, 403 cross-origin, 404 for someone else's reel or playlist", async () => {
    const id = await playlist();
    const reel = (await feed()).reels[0];
    expect((await sharePOST(send("POST", "/x", {}, { origin: "https://evil.example" }), ctx(reel.id))).status).toBe(403);
    expect((await feedSharePOST(send("POST", "/x", {}, { origin: "https://evil.example" }), ctx(id))).status).toBe(403);
    signIn(bob);
    expect((await sharePOST(send("POST", "/x", {}), ctx(reel.id))).status).toBe(404);
    expect((await shareDELETE(send("DELETE", "/x"), ctx(reel.id))).status).toBe(404);
    expect((await feedSharePOST(send("POST", "/x", {}), ctx(id))).status).toBe(404);
    expect((await feedShareDELETE(send("DELETE", "/x"), ctx(id))).status).toBe(404);
    signIn(null);
    expect((await sharePOST(send("POST", "/x", {}), ctx(reel.id))).status).toBe(401);
    expect((await feedSharePOST(send("POST", "/x", {}), ctx(id))).status).toBe(401);
    expect(all("SELECT slug FROM shares")).toHaveLength(0);
  });
});

describe("POST /api/playlists/[id]/recheck", () => {
  it("202 { rechecked } queues the videos that had no captions; owner only", async () => {
    const id = await playlist();
    const res = await recheckPOST(send("POST", `/api/playlists/${id}/recheck`, {}), ctx(id));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ rechecked: 1 });
    const queued = all<{ type: string }>("SELECT type FROM jobs WHERE status = 'queued'");
    expect(queued.map((j) => j.type)).toEqual(["process_video"]);

    expect((await recheckPOST(send("POST", "/x", {}, { origin: "https://evil.example" }), ctx(id))).status).toBe(403);
    signIn(bob);
    expect((await recheckPOST(send("POST", "/x", {}), ctx(id))).status).toBe(404);
    signIn(null);
    expect((await recheckPOST(send("POST", "/x", {}), ctx(id))).status).toBe(401);
  });
});
