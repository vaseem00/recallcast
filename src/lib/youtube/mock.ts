import type { Chapter, PlaylistMeta, VideoMeta } from "@/lib/types";
import { YouTubeError } from "./errors";
import { isValidPlaylistId, isValidVideoId } from "./parse";
import type { YouTubeProvider } from "./provider";

/**
 * Offline YouTube provider (YOUTUBE_PROVIDER=mock). Deterministic: every playlist resolves to
 * the same 3-video series, every video id resolves to a single video with that id.
 *
 * Test hooks (ids are matched case-sensitively and must still be valid ids):
 *   contains "NOTFOUND" -> YouTubeError('not_found')
 *   contains "PRIVATE"  -> YouTubeError('private')
 *   contains "QUOTA"    -> YouTubeError('quota')
 */

export const MOCK_CHANNEL = "Recallcast Sample Lab";
export const MOCK_PLAYLIST_TITLE = "How Memory Works: A Three-Part Series";

// No thumbnail: the mock ids ("mockVid0001"...) are not real videos, so an i.ytimg.com URL for
// them answers 404 and every page that lists a mock playlist logged a failed image load. The UI
// already draws its own fallback (the title's initial / the pine block) for an empty thumbnail.
const NO_THUMBNAIL = "";

export const MOCK_VIDEOS: readonly VideoMeta[] = Object.freeze([
  {
    youtubeVideoId: "mockVid0001",
    title: "The Forgetting Curve, Explained",
    channel: MOCK_CHANNEL,
    durationS: 754,
    thumbnail: NO_THUMBNAIL,
    position: 0,
    chapters: [
      { start: 0, title: "Intro" },
      { start: 42, title: "What Ebbinghaus measured" },
      { start: 190, title: "The shape of the curve" },
      { start: 365, title: "Why each review flattens it" },
      { start: 570, title: "Using it in practice" },
    ],
  },
  {
    youtubeVideoId: "mockVid0002",
    title: "Why Testing Yourself Beats Re-reading",
    channel: MOCK_CHANNEL,
    durationS: 912,
    thumbnail: NO_THUMBNAIL,
    position: 1,
    chapters: [
      { start: 0, title: "Intro" },
      { start: 75, title: "The testing effect" },
      { start: 340, title: "Why re-reading feels better" },
      { start: 620, title: "How to quiz yourself" },
    ],
  },
  {
    youtubeVideoId: "mockVid0003",
    title: "Spacing, Sleep and Long-Term Memory",
    channel: MOCK_CHANNEL,
    durationS: 1088,
    thumbnail: NO_THUMBNAIL,
    position: 2,
    chapters: [],
  },
]);

function copyVideo(v: VideoMeta): VideoMeta {
  return { ...v, chapters: v.chapters?.map((c) => ({ ...c })) };
}

function checkHooks(id: string, thing: "playlist" | "video"): void {
  if (id.includes("NOTFOUND")) {
    throw new YouTubeError("not_found", `YouTube ${thing} not found. It may be private or deleted.`, { status: 404 });
  }
  if (id.includes("PRIVATE")) {
    throw new YouTubeError("private", `YouTube denied access to this ${thing}. It may be private.`, { status: 403 });
  }
  if (id.includes("QUOTA")) {
    throw new YouTubeError("quota", "YouTube API daily quota exceeded. Please try again tomorrow.", {
      status: 403,
      retryable: false,
    });
  }
}

export function createMockYouTubeProvider(opts: { maxVideos?: number } = {}): YouTubeProvider {
  const maxVideos = Math.max(1, Math.floor(opts.maxVideos ?? MOCK_VIDEOS.length));
  return {
    async fetchPlaylist(id: string): Promise<PlaylistMeta> {
      if (!isValidPlaylistId(id)) {
        throw new YouTubeError("bad_request", "That does not look like a valid YouTube playlist ID.");
      }
      checkHooks(id, "playlist");
      const videos = MOCK_VIDEOS.slice(0, maxVideos).map(copyVideo);
      return {
        youtubePlaylistId: id,
        kind: "playlist",
        title: MOCK_PLAYLIST_TITLE,
        channel: MOCK_CHANNEL,
        thumbnail: videos[0].thumbnail,
        videos,
      };
    },

    async fetchVideo(id: string): Promise<PlaylistMeta> {
      if (!isValidVideoId(id)) {
        throw new YouTubeError("bad_request", "That does not look like a valid YouTube video ID.");
      }
      checkHooks(id, "video");
      const known = MOCK_VIDEOS.find((v) => v.youtubeVideoId === id);
      const meta: VideoMeta = known
        ? { ...copyVideo(known), position: 0 }
        : { ...copyVideo(MOCK_VIDEOS[0]), youtubeVideoId: id, thumbnail: NO_THUMBNAIL, position: 0 };
      return {
        youtubePlaylistId: null,
        kind: "video",
        title: meta.title,
        channel: meta.channel,
        thumbnail: meta.thumbnail,
        videos: [meta],
      };
    },

    /** Like fetchVideo: a known id has its own chapters, any other id the first video's. */
    async fetchChapters(ids: string[]): Promise<Map<string, Chapter[]>> {
      const out = new Map<string, Chapter[]>();
      for (const id of ids) {
        if (!isValidVideoId(id)) continue;
        checkHooks(id, "video");
        const known = MOCK_VIDEOS.find((v) => v.youtubeVideoId === id) ?? MOCK_VIDEOS[0];
        out.set(id, copyVideo(known).chapters ?? []);
      }
      return out;
    },
  };
}
