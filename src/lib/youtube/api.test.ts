import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createYouTubeApiProvider, mapApiError, YOUTUBE_API_BASE } from "./api";
import { YouTubeError } from "./errors";

const KEY = "AIzaTEST-secret-key-123";
const PL = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";

const vid = (n: number) => `v${String(n).padStart(10, "0")}`; // 11 chars

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, reason: string, message = "boom"): Response {
  return jsonResponse({ error: { code: status, message, errors: [{ reason, domain: "youtube" }] } }, status);
}

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return handler(url, init ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
}

function callsTo(endpoint: string): URL[] {
  return fetchMock.mock.calls
    .map((c) => new URL(String(c[0])))
    .filter((u) => u.pathname.endsWith(`/youtube/v3/${endpoint}`));
}

interface FakeVideo {
  id: string;
  title?: string;
  privacy?: string;
  duration?: string;
  live?: string;
  channel?: string;
  description?: string;
  missingFromVideosList?: boolean;
}

/** Simulates the Data API for one playlist made of `videos`, served in pages of 50. */
function fakePlaylistApi(videos: FakeVideo[], opts: { playlistExists?: boolean; pageSize?: number } = {}): Handler {
  const pageSize = opts.pageSize ?? 50;
  return (url, init) => {
    const headers = new Headers(init.headers);
    if (headers.get("x-goog-api-key") !== KEY) return errorResponse(400, "keyInvalid", "API key not valid");
    const path = url.pathname.replace("/youtube/v3/", "");
    if (path === "playlists") {
      if (opts.playlistExists === false) return jsonResponse({ items: [] });
      return jsonResponse({
        items: [
          {
            id: url.searchParams.get("id"),
            snippet: {
              title: "Learning How to Learn",
              channelTitle: "Playlist Owner",
              thumbnails: {
                default: { url: "https://i.ytimg.com/pl/default.jpg" },
                high: { url: "https://i.ytimg.com/pl/high.jpg" },
              },
            },
          },
        ],
      });
    }
    if (path === "playlistItems") {
      const token = url.searchParams.get("pageToken");
      const start = token ? Number(token.replace("page", "")) : 0;
      const slice = videos.slice(start, start + pageSize);
      const next = start + pageSize < videos.length ? `page${start + pageSize}` : undefined;
      return jsonResponse({
        nextPageToken: next,
        items: slice.map((v, i) => ({
          snippet: { title: v.title ?? `Video ${v.id}`, position: start + i, resourceId: { videoId: v.id } },
          contentDetails: { videoId: v.id },
          status: { privacyStatus: v.privacy ?? "public" },
        })),
      });
    }
    if (path === "videos") {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      return jsonResponse({
        items: ids
          .map((id) => videos.find((v) => v.id === id))
          .filter((v): v is FakeVideo => !!v && !v.missingFromVideosList)
          .reverse() // API does not guarantee order; provider must restore it
          .map((v) => ({
            id: v.id,
            snippet: {
              title: v.title ?? `Video ${v.id}`,
              channelTitle: v.channel ?? "Creator Channel",
              ...(v.description === undefined ? {} : { description: v.description }),
              liveBroadcastContent: v.live ?? "none",
              thumbnails: {
                medium: { url: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` },
                maxres: { url: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg` },
              },
            },
            contentDetails: { duration: v.duration ?? "PT10M30S" },
            status: { privacyStatus: "public", uploadStatus: "processed" },
          })),
      });
    }
    return jsonResponse({ error: { code: 404 } }, 404);
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("YouTube Data API provider: fetchPlaylist", () => {
  it("maps playlist + videos, keeps order, parses durations and picks the best thumbnails", async () => {
    installFetch(
      fakePlaylistApi([
        { id: vid(1), duration: "PT1H2M3S", title: "Intro" },
        { id: vid(2), duration: "PT45S", channel: "Guest Channel" },
        { id: vid(3) },
      ]),
    );
    const provider = createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 });
    const meta = await provider.fetchPlaylist(PL);

    expect(meta).toMatchObject({
      youtubePlaylistId: PL,
      kind: "playlist",
      title: "Learning How to Learn",
      channel: "Playlist Owner",
      thumbnail: "https://i.ytimg.com/pl/high.jpg",
    });
    expect(meta.videos.map((v) => v.youtubeVideoId)).toEqual([vid(1), vid(2), vid(3)]);
    expect(meta.videos.map((v) => v.position)).toEqual([0, 1, 2]);
    expect(meta.videos[0]).toEqual({
      youtubeVideoId: vid(1),
      title: "Intro",
      channel: "Creator Channel",
      durationS: 3723,
      thumbnail: `https://i.ytimg.com/vi/${vid(1)}/maxresdefault.jpg`,
      position: 0,
    });
    expect(meta.videos[1].durationS).toBe(45);
    expect(meta.videos[1].channel).toBe("Guest Channel");
  });

  it("sends the key in a header, never in the URL, and requests 50 per page", async () => {
    installFetch(fakePlaylistApi([{ id: vid(1) }]));
    await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchPlaylist(PL);
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url.startsWith(YOUTUBE_API_BASE)).toBe(true);
      expect(url).not.toContain(KEY);
      expect(url).not.toContain("key=");
      expect(new Headers((call[1] as RequestInit).headers).get("x-goog-api-key")).toBe(KEY);
    }
    expect(callsTo("playlistItems")[0].searchParams.get("maxResults")).toBe("50");
    expect(callsTo("playlistItems")[0].searchParams.get("playlistId")).toBe(PL);
  });

  it("paginates playlistItems and stops at MAX_VIDEOS_PER_PLAYLIST", async () => {
    const videos = Array.from({ length: 130 }, (_, i) => ({ id: vid(i + 1) }));
    installFetch(fakePlaylistApi(videos));
    const meta = await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 60 }).fetchPlaylist(PL);

    expect(meta.videos).toHaveLength(60);
    expect(meta.videos[59].youtubeVideoId).toBe(vid(60));
    // 2 pages were enough for 60 items; the 3rd page is never requested.
    expect(callsTo("playlistItems")).toHaveLength(2);
    expect(callsTo("playlistItems")[1].searchParams.get("pageToken")).toBe("page50");
    // videos.list in batches of 50: 50 + 10
    const videoCalls = callsTo("videos");
    expect(videoCalls).toHaveLength(2);
    expect(videoCalls[0].searchParams.get("id")!.split(",")).toHaveLength(50);
    expect(videoCalls[1].searchParams.get("id")!.split(",")).toHaveLength(10);
  });

  it("reads all pages when the playlist is smaller than the cap", async () => {
    const videos = Array.from({ length: 7 }, (_, i) => ({ id: vid(i + 1) }));
    installFetch(fakePlaylistApi(videos, { pageSize: 3 }));
    const meta = await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchPlaylist(PL);
    expect(meta.videos).toHaveLength(7);
    expect(callsTo("playlistItems")).toHaveLength(3);
  });

  it("skips private, deleted, duplicate, live/upcoming and vanished videos", async () => {
    installFetch(
      fakePlaylistApi([
        { id: vid(1) },
        { id: vid(2), title: "Private video", privacy: "private" },
        { id: vid(3), title: "Deleted video", privacy: "privacyStatusUnspecified" },
        { id: vid(4), live: "upcoming", duration: "P0D" },
        { id: vid(1) }, // duplicate entry
        { id: vid(5), missingFromVideosList: true },
        { id: vid(6), live: "live" },
        { id: vid(7) },
      ]),
    );
    const meta = await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchPlaylist(PL);
    expect(meta.videos.map((v) => v.youtubeVideoId)).toEqual([vid(1), vid(7)]);
    expect(meta.videos.map((v) => v.position)).toEqual([0, 1]);
  });

  it("throws not_found when playlists.list returns no items", async () => {
    installFetch(fakePlaylistApi([{ id: vid(1) }], { playlistExists: false }));
    await expect(createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchPlaylist(PL)).rejects.toMatchObject({
      name: "YouTubeError",
      code: "not_found",
    });
    expect(callsTo("playlistItems")).toHaveLength(0);
  });

  it("throws unsupported when no public videos remain", async () => {
    installFetch(fakePlaylistApi([{ id: vid(1), privacy: "private", title: "Private video" }]));
    await expect(createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchPlaylist(PL)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("rejects malformed playlist ids without calling the network", async () => {
    installFetch(fakePlaylistApi([]));
    const provider = createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 });
    await expect(provider.fetchPlaylist("WL")).rejects.toMatchObject({ code: "bad_request" });
    await expect(provider.fetchPlaylist("PL&key=evil&x=1234")).rejects.toMatchObject({ code: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("guards against a looping nextPageToken", async () => {
    installFetch((url) => {
      const path = url.pathname.replace("/youtube/v3/", "");
      if (path === "playlists") return jsonResponse({ items: [{ snippet: { title: "Loop", channelTitle: "C" } }] });
      if (path === "playlistItems") {
        return jsonResponse({ nextPageToken: "same", items: [] });
      }
      return jsonResponse({ items: [] });
    });
    await expect(createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchPlaylist(PL)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(callsTo("playlistItems").length).toBeLessThanOrEqual(2);
  });
});

describe("YouTube Data API provider: fetchVideo", () => {
  it("wraps a single video as a one-item PlaylistMeta", async () => {
    installFetch(fakePlaylistApi([{ id: vid(9), title: "Solo", duration: "PT12M", channel: "Solo Channel" }]));
    const meta = await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchVideo(vid(9));
    expect(meta).toEqual({
      youtubePlaylistId: null,
      kind: "video",
      title: "Solo",
      channel: "Solo Channel",
      thumbnail: `https://i.ytimg.com/vi/${vid(9)}/maxresdefault.jpg`,
      videos: [
        {
          youtubeVideoId: vid(9),
          title: "Solo",
          channel: "Solo Channel",
          durationS: 720,
          thumbnail: `https://i.ytimg.com/vi/${vid(9)}/maxresdefault.jpg`,
          position: 0,
        },
      ],
    });
    expect(callsTo("videos")[0].searchParams.get("part")).toBe("snippet,contentDetails,status");
  });

  it("throws not_found for an unknown video", async () => {
    installFetch(fakePlaylistApi([]));
    await expect(createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchVideo(vid(1))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects live streams", async () => {
    installFetch(fakePlaylistApi([{ id: vid(1), live: "live" }]));
    await expect(createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchVideo(vid(1))).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("falls back to the ytimg thumbnail when none is provided", async () => {
    installFetch(() =>
      jsonResponse({
        items: [{ id: vid(1), snippet: { title: "T", channelTitle: "C" }, contentDetails: { duration: "PT1M" } }],
      }),
    );
    const meta = await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchVideo(vid(1));
    expect(meta.thumbnail).toBe(`https://i.ytimg.com/vi/${vid(1)}/hqdefault.jpg`);
  });

  it("rejects malformed video ids", async () => {
    installFetch(fakePlaylistApi([]));
    await expect(createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchVideo("abc")).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("YouTube Data API provider: chapters", () => {
  const description = "Timestamps:\n0:00 Intro\n1:30 The circuit\n7:45 Measurements\nThanks for watching!";

  it("reads the chapter marks from the description that comes with the video details", async () => {
    installFetch(fakePlaylistApi([{ id: vid(1), duration: "PT10M", description }, { id: vid(2), description: "No stamps here." }]));
    const meta = await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchPlaylist(PL);
    expect(meta.videos[0].chapters).toEqual([
      { start: 0, title: "Intro" },
      { start: 90, title: "The circuit" },
      { start: 465, title: "Measurements" },
    ]);
    expect(meta.videos[1].chapters).toEqual([]);
    expect(callsTo("videos")).toHaveLength(1); // no extra call for them
  });

  it("fetchChapters asks videos.list once per 50 ids and skips ids that are not ids", async () => {
    installFetch(fakePlaylistApi([{ id: vid(1), duration: "PT10M", description }, { id: vid(2) }]));
    const map = await createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 }).fetchChapters!([vid(1), vid(2), vid(3), "bad id", vid(1)]);
    expect(map.get(vid(1))).toHaveLength(3);
    expect(map.get(vid(2))).toEqual([]); // no description: no chapters
    expect(map.has(vid(3))).toBe(false); // YouTube does not know it
    const calls = callsTo("videos");
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("id")).toBe(`${vid(1)},${vid(2)},${vid(3)}`);
  });

  it("fetchChapters makes no call for no ids, and maps errors like the other lookups", async () => {
    installFetch(() => errorResponse(403, "quotaExceeded"));
    const provider = createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 });
    expect((await provider.fetchChapters!([])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(provider.fetchChapters!([vid(1)])).rejects.toMatchObject({ code: "quota", retryable: false });
  });
});

describe("YouTube Data API provider: HTTP error mapping", () => {
  const provider = () => createYouTubeApiProvider({ apiKey: KEY, maxVideos: 25 });

  it.each([
    [403, "quotaExceeded", "quota", false, /quota/i],
    [403, "dailyLimitExceeded", "quota", false, /quota/i],
    [403, "rateLimitExceeded", "quota", true, /rate limit/i],
    [429, "", "quota", true, /rate limit/i],
    [400, "keyInvalid", "bad_key", false, /YOUTUBE_API_KEY/],
    [403, "accessNotConfigured", "bad_key", false, /not enabled/i],
    [403, "ipRefererBlocked", "bad_key", false, /restricted/i],
    [403, "playlistItemsNotAccessible", "private", false, /private/i],
    [403, "forbidden", "private", false, /private/i],
    [404, "playlistNotFound", "not_found", false, /not found/i],
    [404, "", "not_found", false, /not found/i],
    [400, "invalidPageToken", "bad_request", false, /rejected/i],
    [500, "backendError", "upstream", true, /trouble/i],
    [503, "", "upstream", true, /trouble/i],
  ] as const)("HTTP %i %s -> %s", async (status, reason, code, retryable, msg) => {
    installFetch(() => (reason ? errorResponse(status, reason, `secret detail key=${KEY}`) : new Response("", { status })));
    const err = await provider()
      .fetchPlaylist(PL)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouTubeError);
    const ytErr = err as YouTubeError;
    expect(ytErr.code).toBe(code);
    expect(ytErr.status).toBe(status);
    expect(ytErr.retryable).toBe(retryable);
    expect(ytErr.message).toMatch(msg);
    expect(ytErr.message).not.toContain(KEY);
  });

  it("maps google RPC-style details reasons", () => {
    const err = mapApiError(
      400,
      { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } },
      "playlist",
    );
    expect(err.code).toBe("bad_key");
  });

  it("maps network failures to a retryable network error", async () => {
    installFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(provider().fetchPlaylist(PL)).rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("treats a non-JSON 200 body as an upstream error", async () => {
    installFetch(() => new Response("<html>captcha</html>", { status: 200 }));
    await expect(provider().fetchVideo(vid(1))).rejects.toMatchObject({ code: "upstream" });
  });

  it("uses the word 'video' for video lookups", async () => {
    installFetch(() => errorResponse(404, "videoNotFound"));
    await expect(provider().fetchVideo(vid(1))).rejects.toThrow(/video not found/i);
  });
});
