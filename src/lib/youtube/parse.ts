export type ParsedYouTubeUrl = { kind: "playlist"; playlistId: string } | { kind: "video"; videoId: string } | null;

/** YouTube video IDs are exactly 11 URL-safe base64 characters. */
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Playlist IDs are URL-safe base64, normally 13-64 chars with a prefix (PL, UU, OL, FL...).
 * We require >= 10 chars, which also rejects the private pseudo-playlists "WL" (watch later)
 * and "LL" (liked videos) that the Data API can never read with an API key.
 */
export const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

const MAX_INPUT_LENGTH = 2048;

const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

/** Path prefixes that carry a video ID as their next segment. */
const VIDEO_PATH_PREFIXES = new Set(["shorts", "embed", "live", "v", "e"]);

export function isValidVideoId(id: string): boolean {
  return VIDEO_ID_RE.test(id);
}

export function isValidPlaylistId(id: string): boolean {
  return PLAYLIST_ID_RE.test(id);
}

/**
 * Auto-generated "mix" playlists (RD...) are per-viewer radio stations: the Data API
 * cannot list them, so a watch URL inside a mix is treated as the single video.
 */
function isMixPlaylist(id: string): boolean {
  return id.startsWith("RD");
}

function pickPlaylist(listParam: string | null): string | null {
  if (!listParam) return null;
  const id = listParam.trim();
  if (!isValidPlaylistId(id) || isMixPlaylist(id)) return null;
  return id;
}

function pickVideo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim();
  return isValidVideoId(id) ? id : null;
}

function result(playlistId: string | null, videoId: string | null): ParsedYouTubeUrl {
  // A playlist reference wins over the video it was opened on (watch?v=..&list=..).
  if (playlistId) return { kind: "playlist", playlistId };
  if (videoId) return { kind: "video", videoId };
  return null;
}

/**
 * Parses a YouTube playlist or video URL.
 *
 * Accepts http(s) URLs on youtube.com / www. / m. / music. / youtube-nocookie.com and youtu.be,
 * with or without the scheme. Recognised forms:
 *   /playlist?list=ID, /watch?v=ID, /watch?v=ID&list=ID (-> playlist), youtu.be/ID[?list=ID],
 *   /shorts/ID, /embed/ID, /embed/videoseries?list=ID, /live/ID, /v/ID.
 * Bare IDs, other schemes (javascript:, data:, ftp:), credentials, custom ports and look-alike
 * hosts (youtube.com.evil.com, evilyoutube.com) are rejected with null.
 */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_INPUT_LENGTH) return null;
  // Whitespace or control characters inside a URL are never legitimate here.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  // Protocol-relative inputs ("//youtube.com/...") are fine; "https:" is prepended.
  const schemeless = hasScheme ? null : trimmed.replace(/^\/\//, "");
  // Scheme-less input needs a dot-containing host before the first slash; this keeps bare IDs out.
  if (schemeless !== null && !/^[^/?#]+\.[^/?#]+/.test(schemeless)) return null;
  const candidate = schemeless === null ? trimmed : `https://${schemeless}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  const listParam = url.searchParams.get("list");

  if (SHORT_HOSTS.has(host)) {
    if (segments.length !== 1) return null;
    return result(pickPlaylist(listParam), pickVideo(segments[0]));
  }

  if (!WATCH_HOSTS.has(host)) return null;

  const first = (segments[0] ?? "").toLowerCase();

  if (first === "playlist" && segments.length === 1) {
    return result(pickPlaylist(listParam), null);
  }

  if (first === "watch" && segments.length === 1) {
    return result(pickPlaylist(listParam), pickVideo(url.searchParams.get("v")));
  }

  if (VIDEO_PATH_PREFIXES.has(first) && segments.length === 2) {
    if (first === "embed" && segments[1] === "videoseries") {
      return result(pickPlaylist(listParam), null);
    }
    return result(first === "embed" ? pickPlaylist(listParam) : null, pickVideo(segments[1]));
  }

  return null;
}
