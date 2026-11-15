import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, resetEnvCache } from "@/lib/env";
import { getYouTubeProvider, YouTubeError } from "./index";
import { MOCK_CHANNEL, MOCK_PLAYLIST_TITLE, MOCK_VIDEOS } from "./mock";

const saved = { ...process.env };
const PL = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
  vi.unstubAllGlobals();
});

describe("getYouTubeProvider factory", () => {
  it("defaults to the mock provider (setup forces mock) and never touches the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const meta = await getYouTubeProvider().fetchPlaylist(PL);
    expect(meta.title).toBe(MOCK_PLAYLIST_TITLE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws a ConfigError at call time when the api provider has no key", () => {
    process.env.YOUTUBE_PROVIDER = "api";
    delete process.env.YOUTUBE_API_KEY;
    resetEnvCache();
    expect(() => getYouTubeProvider()).toThrow(ConfigError);
    expect(() => getYouTubeProvider()).toThrow(/YOUTUBE_API_KEY/);
  });

  it("builds the api provider when a key is set and applies MAX_VIDEOS_PER_PLAYLIST", async () => {
    process.env.YOUTUBE_PROVIDER = "api";
    process.env.YOUTUBE_API_KEY = "test-key";
    process.env.MAX_VIDEOS_PER_PLAYLIST = "1";
    resetEnvCache();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/playlists")) {
        return Response.json({ items: [{ snippet: { title: "P", channelTitle: "C" } }] });
      }
      if (url.pathname.endsWith("/playlistItems")) {
        return Response.json({
          nextPageToken: "next",
          items: [
            { contentDetails: { videoId: "aaaaaaaaaaa" }, status: { privacyStatus: "public" } },
            { contentDetails: { videoId: "bbbbbbbbbbb" }, status: { privacyStatus: "public" } },
          ],
        });
      }
      return Response.json({
        items: (url.searchParams.get("id") ?? "").split(",").map((id) => ({
          id,
          snippet: { title: id, channelTitle: "C" },
          contentDetails: { duration: "PT5M" },
        })),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const meta = await getYouTubeProvider().fetchPlaylist(PL);
    expect(meta.videos.map((v) => v.youtubeVideoId)).toEqual(["aaaaaaaaaaa"]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("mock YouTube provider", () => {
  it("returns a deterministic 3-video playlist", async () => {
    const a = await getYouTubeProvider().fetchPlaylist(PL);
    const b = await getYouTubeProvider().fetchPlaylist(PL);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ youtubePlaylistId: PL, kind: "playlist", channel: MOCK_CHANNEL });
    expect(a.videos).toHaveLength(3);
    expect(a.videos.map((v) => v.position)).toEqual([0, 1, 2]);
    for (const v of a.videos) {
      expect(v.youtubeVideoId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(v.durationS).toBeGreaterThan(0);
      expect(v.durationS).toBeLessThan(10800);
      // No remote thumbnail for fake ids (an i.ytimg.com URL for them is a 404 in the browser).
      expect(v.thumbnail).toBe("");
    }
  });

  it("returns copies, so callers cannot mutate the fixture", async () => {
    const a = await getYouTubeProvider().fetchPlaylist(PL);
    a.videos[0].title = "mutated";
    expect(MOCK_VIDEOS[0].title).not.toBe("mutated");
  });

  it("wraps any video id as a single-video PlaylistMeta", async () => {
    const meta = await getYouTubeProvider().fetchVideo("dQw4w9WgXcQ");
    expect(meta.kind).toBe("video");
    expect(meta.youtubePlaylistId).toBeNull();
    expect(meta.videos).toHaveLength(1);
    expect(meta.videos[0]).toMatchObject({ youtubeVideoId: "dQw4w9WgXcQ", position: 0 });
  });

  it("respects MAX_VIDEOS_PER_PLAYLIST", async () => {
    process.env.MAX_VIDEOS_PER_PLAYLIST = "2";
    resetEnvCache();
    expect((await getYouTubeProvider().fetchPlaylist(PL)).videos).toHaveLength(2);
  });

  it("exposes error hooks for UI and pipeline tests", async () => {
    const p = getYouTubeProvider();
    await expect(p.fetchPlaylist("PLxxNOTFOUNDxx")).rejects.toMatchObject({ code: "not_found" });
    await expect(p.fetchPlaylist("PLxxPRIVATExx")).rejects.toMatchObject({ code: "private" });
    await expect(p.fetchPlaylist("PLxxxQUOTAxxx")).rejects.toBeInstanceOf(YouTubeError);
    await expect(p.fetchVideo("xxNOTFOUNDx")).rejects.toMatchObject({ code: "not_found" });
    await expect(p.fetchVideo("bad")).rejects.toMatchObject({ code: "bad_request" });
  });
});
