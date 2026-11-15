import "server-only";
import { z } from "zod";
import type { Chapter, PlaylistMeta, VideoMeta } from "@/lib/types";
import { parseChapters } from "./chapters";
import { parseIsoDuration } from "./duration";
import { YouTubeError } from "./errors";
import { isValidPlaylistId, isValidVideoId } from "./parse";
import type { YouTubeProvider } from "./provider";

/**
 * YouTube Data API v3 provider (YOUTUBE_PROVIDER=api).
 *
 * Quota cost per playlist: 1 (playlists.list) + ceil(items/50) (playlistItems.list)
 * + ceil(videos/50) (videos.list). The key is sent in the x-goog-api-key header so it
 * never appears in URLs, logs or error messages.
 */

export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const PAGE_SIZE = 50;
/** Hard stop for pagination so a huge or looping playlist cannot burn quota. */
const MAX_PAGES = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

// ---- response schemas (lenient: only the fields we use, everything optional) ----

const thumbnailSchema = z.object({ url: z.string() }).partial();
const thumbnailsSchema = z.record(z.string(), thumbnailSchema.optional().nullable());

const playlistsResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        snippet: z
          .object({
            title: z.string().optional(),
            channelTitle: z.string().optional(),
            thumbnails: thumbnailsSchema.optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

const playlistItemsResponse = z.object({
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z.object({
        snippet: z
          .object({
            title: z.string().optional(),
            position: z.number().optional(),
            resourceId: z.object({ videoId: z.string().optional() }).optional(),
          })
          .optional(),
        contentDetails: z.object({ videoId: z.string().optional() }).optional(),
        status: z.object({ privacyStatus: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

const videoItemSchema = z.object({
  id: z.string(),
  snippet: z
    .object({
      title: z.string().optional(),
      channelTitle: z.string().optional(),
      description: z.string().optional(),
      thumbnails: thumbnailsSchema.optional(),
      liveBroadcastContent: z.string().optional(),
    })
    .optional(),
  contentDetails: z.object({ duration: z.string().optional() }).optional(),
  status: z.object({ privacyStatus: z.string().optional(), uploadStatus: z.string().optional() }).optional(),
});
type VideoItem = z.infer<typeof videoItemSchema>;

const videosResponse = z.object({ items: z.array(videoItemSchema).default([]) });

const apiErrorBody = z.object({
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
      errors: z.array(z.object({ reason: z.string().optional() }).partial()).optional(),
      details: z.array(z.object({ reason: z.string().optional() }).partial()).optional(),
      status: z.string().optional(),
    })
    .optional(),
});

// ---- helpers ----

const THUMB_ORDER = ["maxres", "standard", "high", "medium", "default"] as const;

export function bestThumbnail(thumbnails: z.infer<typeof thumbnailsSchema> | undefined, fallback: string): string {
  if (thumbnails) {
    for (const key of THUMB_ORDER) {
      const url = thumbnails[key]?.url;
      if (typeof url === "string" && /^https:\/\//i.test(url)) return url;
    }
  }
  return fallback;
}

function videoThumbFallback(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

const UNAVAILABLE_TITLES = new Set(["Private video", "Deleted video"]);

type Subject = "playlist" | "video";

/** Maps a non-2xx Data API response to a user-safe YouTubeError. Exported for tests. */
export function mapApiError(status: number, body: unknown, subject: Subject): YouTubeError {
  const parsed = apiErrorBody.safeParse(body);
  const err = parsed.success ? parsed.data.error : undefined;
  const reasons = new Set<string>();
  for (const e of err?.errors ?? []) if (e.reason) reasons.add(e.reason);
  for (const d of err?.details ?? []) if (d.reason) reasons.add(d.reason);
  const has = (...r: string[]) => r.some((x) => reasons.has(x));
  const thing = subject === "playlist" ? "playlist" : "video";

  if (has("quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg")) {
    return new YouTubeError("quota", "YouTube API daily quota exceeded. Please try again tomorrow.", {
      status,
      retryable: false,
    });
  }
  if (status === 429 || has("rateLimitExceeded", "userRateLimitExceeded")) {
    return new YouTubeError("quota", "YouTube is rate limiting requests. Please try again in a few minutes.", {
      status,
      retryable: true,
    });
  }
  if (has("keyInvalid", "keyExpired", "API_KEY_INVALID", "API_KEY_EXPIRED")) {
    return new YouTubeError("bad_key", "The YouTube API key is invalid or expired. Check YOUTUBE_API_KEY.", {
      status,
      retryable: false,
    });
  }
  if (has("accessNotConfigured", "SERVICE_DISABLED")) {
    return new YouTubeError(
      "bad_key",
      "YouTube Data API v3 is not enabled for this API key's Google Cloud project.",
      { status, retryable: false },
    );
  }
  if (has("ipRefererBlocked", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_SERVICE_BLOCKED")) {
    return new YouTubeError("bad_key", "The YouTube API key is restricted and cannot be used from this server.", {
      status,
      retryable: false,
    });
  }
  if (has("playlistItemsNotAccessible", "playlistForbidden", "forbidden") || status === 403) {
    return new YouTubeError("private", `YouTube denied access to this ${thing}. It may be private.`, {
      status,
      retryable: false,
    });
  }
  if (has("playlistNotFound", "videoNotFound", "notFound") || status === 404) {
    return new YouTubeError("not_found", `YouTube ${thing} not found. It may be private or deleted.`, {
      status,
      retryable: false,
    });
  }
  if (status === 400) {
    return new YouTubeError("bad_request", `YouTube rejected the request for this ${thing}.`, {
      status,
      retryable: false,
    });
  }
  if (status >= 500) {
    return new YouTubeError("upstream", "YouTube is having trouble right now. Please try again later.", {
      status,
      retryable: true,
    });
  }
  return new YouTubeError("upstream", `Unexpected response from YouTube (HTTP ${status}).`, { status });
}

export interface YouTubeApiProviderOptions {
  apiKey: string;
  /** Cap on returned videos (MAX_VIDEOS_PER_PLAYLIST). */
  maxVideos: number;
  /** Defaults to globalThis.fetch resolved at call time (so tests can stub it). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createYouTubeApiProvider(opts: YouTubeApiProviderOptions): YouTubeProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxVideos = Math.max(1, Math.floor(opts.maxVideos));

  async function request<S extends z.ZodType>(
    endpoint: "playlists" | "playlistItems" | "videos",
    params: Record<string, string>,
    schema: S,
    subject: Subject,
  ): Promise<z.infer<S>> {
    const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const doFetch = opts.fetchImpl ?? globalThis.fetch;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json", "x-goog-api-key": opts.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch {
      throw new YouTubeError("network", "Could not reach YouTube. Please try again.", { retryable: true });
    }

    let body: unknown = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!res.ok) throw mapApiError(res.status, body, subject);

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new YouTubeError("upstream", "YouTube returned an unexpected response.", { status: res.status });
    }
    return parsed.data as z.infer<S>;
  }

  /** videos.list in batches of 50; returns items in the order of `ids`, dropping missing ones. */
  async function fetchVideoItems(ids: string[], subject: Subject): Promise<VideoItem[]> {
    const byId = new Map<string, VideoItem>();
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      const batch = ids.slice(i, i + PAGE_SIZE);
      const data = await request(
        "videos",
        { part: "snippet,contentDetails,status", id: batch.join(","), maxResults: String(PAGE_SIZE) },
        videosResponse,
        subject,
      );
      for (const item of data.items) byId.set(item.id, item);
    }
    return ids.map((id) => byId.get(id)).filter((v): v is VideoItem => v !== undefined);
  }

  function isUsableVideo(item: VideoItem): boolean {
    const privacy = item.status?.privacyStatus;
    if (privacy === "private") return false;
    const upload = item.status?.uploadStatus;
    if (upload && upload !== "processed") return false;
    const live = item.snippet?.liveBroadcastContent;
    if (live === "live" || live === "upcoming") return false;
    return true;
  }

  /** The description's chapter marks; undefined when the response carried no description. */
  function chaptersOf(item: VideoItem): Chapter[] | undefined {
    const description = item.snippet?.description;
    return typeof description === "string" ? parseChapters(description, parseIsoDuration(item.contentDetails?.duration) ?? 0) : undefined;
  }

  function toVideoMeta(item: VideoItem, position: number, fallbackChannel: string): VideoMeta {
    return {
      youtubeVideoId: item.id,
      title: item.snippet?.title?.trim() || "Untitled video",
      channel: item.snippet?.channelTitle?.trim() || fallbackChannel,
      durationS: parseIsoDuration(item.contentDetails?.duration) ?? 0,
      thumbnail: bestThumbnail(item.snippet?.thumbnails, videoThumbFallback(item.id)),
      position,
      chapters: chaptersOf(item),
    };
  }

  return {
    async fetchPlaylist(id: string): Promise<PlaylistMeta> {
      if (!isValidPlaylistId(id)) {
        throw new YouTubeError("bad_request", "That does not look like a valid YouTube playlist ID.");
      }

      const pl = await request(
        "playlists",
        { part: "snippet", id, maxResults: "1" },
        playlistsResponse,
        "playlist",
      );
      const plItem = pl.items[0];
      if (!plItem) {
        throw new YouTubeError("not_found", "YouTube playlist not found. It may be private or deleted.", {
          status: 200,
        });
      }

      // 1) Collect playable video IDs in playlist order.
      const ids: string[] = [];
      const seen = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES && ids.length < maxVideos; page++) {
        const params: Record<string, string> = {
          part: "snippet,contentDetails,status",
          playlistId: id,
          maxResults: String(PAGE_SIZE),
        };
        if (pageToken) params.pageToken = pageToken;
        const data = await request("playlistItems", params, playlistItemsResponse, "playlist");

        for (const item of data.items) {
          const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
          if (!videoId || !isValidVideoId(videoId) || seen.has(videoId)) continue;
          const privacy = item.status?.privacyStatus;
          if (privacy === "private" || privacy === "privacyStatusUnspecified") continue;
          if (item.snippet?.title && UNAVAILABLE_TITLES.has(item.snippet.title)) continue;
          seen.add(videoId);
          ids.push(videoId);
          if (ids.length >= maxVideos) break;
        }

        if (!data.nextPageToken || data.nextPageToken === pageToken) break;
        pageToken = data.nextPageToken;
      }

      const playlistChannel = plItem.snippet?.channelTitle?.trim() ?? "";

      // 2) Details (duration, owner channel, thumbnail) in batches of 50.
      const items = (await fetchVideoItems(ids, "playlist")).filter(isUsableVideo);
      const videos = items.map((item, i) => toVideoMeta(item, i, playlistChannel));

      if (videos.length === 0) {
        throw new YouTubeError("unsupported", "This playlist has no public videos we can process.", {
          retryable: false,
        });
      }

      return {
        youtubePlaylistId: id,
        kind: "playlist",
        title: plItem.snippet?.title?.trim() || "Untitled playlist",
        channel: playlistChannel || videos[0].channel,
        thumbnail: bestThumbnail(plItem.snippet?.thumbnails, videos[0].thumbnail),
        videos,
      };
    },

    async fetchVideo(id: string): Promise<PlaylistMeta> {
      if (!isValidVideoId(id)) {
        throw new YouTubeError("bad_request", "That does not look like a valid YouTube video ID.");
      }
      const [item] = await fetchVideoItems([id], "video");
      if (!item) {
        throw new YouTubeError("not_found", "YouTube video not found. It may be private or deleted.", {
          status: 200,
        });
      }
      const live = item.snippet?.liveBroadcastContent;
      if (live === "live" || live === "upcoming") {
        throw new YouTubeError("unsupported", "Live and upcoming streams are not supported. Try again after it ends.");
      }
      if (!isUsableVideo(item)) {
        throw new YouTubeError("private", "This video is private or still processing.");
      }
      const meta = toVideoMeta(item, 0, "");
      return {
        youtubePlaylistId: null,
        kind: "video",
        title: meta.title,
        channel: meta.channel,
        thumbnail: meta.thumbnail,
        videos: [meta],
      };
    },

    /** One videos.list call per 50 ids (1 quota unit each), the same call ingest makes. */
    async fetchChapters(ids: string[]): Promise<Map<string, Chapter[]>> {
      const wanted = [...new Set(ids.filter((id) => isValidVideoId(id)))];
      const out = new Map<string, Chapter[]>();
      if (wanted.length === 0) return out;
      for (const item of await fetchVideoItems(wanted, "video")) out.set(item.id, chaptersOf(item) ?? []);
      return out;
    },
  };
}
