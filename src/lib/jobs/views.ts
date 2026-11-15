import "server-only";
import { clipExcerpt } from "@/lib/ai/clip";
import { all, get } from "@/lib/db";
import type {
  ClipPlan,
  EpisodeRow,
  PlaylistKind,
  PlaylistRow,
  PlaylistStatus,
  TranscriptSegment,
  TranscriptStatus,
  VideoRow,
  VideoStatus,
} from "@/lib/types";
import { cleanSegments, parseStoredClip } from "./pipeline";

/**
 * Read models for the playlist API routes (and for server components that want the same data
 * without an HTTP round trip). Every query is scoped by user id: callers never get another
 * user's rows, and a playlist that is not the user's is reported as missing.
 */

export interface PlaylistCounts {
  total: number;
  ready: number;
  failed: number;
  skipped: number;
  processing: number;
  episodes: number;
}

export interface PlaylistView {
  id: string;
  sourceUrl: string;
  youtubePlaylistId: string | null;
  kind: PlaylistKind;
  title: string;
  channel: string;
  thumbnail: string;
  status: PlaylistStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistListItem extends PlaylistView {
  counts: PlaylistCounts;
}

export interface VideoView {
  id: string;
  youtubeVideoId: string;
  youtubeUrl: string;
  position: number;
  title: string;
  channel: string;
  durationS: number;
  thumbnail: string;
  transcriptStatus: TranscriptStatus;
  status: VideoStatus;
  error: string | null;
  episodeId: string | null;
}

/** One playable clip: a window of a YouTube video, played through the embedded player. */
export interface EpisodeView {
  id: string;
  playlistId: string;
  videoId: string;
  youtubeVideoId: string;
  title: string;
  clip: ClipPlan;
  /** What is said inside the clip (from the transcript), or "" without one. Capped. */
  excerpt: string;
  durationS: number;
  createdAt: number;
}

export interface PlaylistDetail {
  playlist: PlaylistView;
  videos: VideoView[];
  /** Playable clips in playlist order. */
  episodes: EpisodeView[];
  /** total excludes skipped videos. */
  progress: { total: number; ready: number; failed: number; skipped: number; processing: number };
  /** Reels cut from this playlist so far, and how many videos are still being cut. */
  reels: { ready: number; pending: number };
  /** The id of the playlist's public feed link (/r/<slug>), or null when it is not shared. */
  shareSlug: string | null;
}

/** Longest excerpt sent to the browser per episode. */
export const MAX_EXCERPT_WORDS = 700;

function parse<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function toPlaylistView(p: PlaylistRow): PlaylistView {
  return {
    id: p.id,
    sourceUrl: p.source_url,
    youtubePlaylistId: p.youtube_playlist_id,
    kind: p.kind,
    title: p.title,
    channel: p.channel,
    thumbnail: p.thumbnail,
    status: p.status,
    error: p.error,
    createdAt: Number(p.created_at),
    updatedAt: Number(p.updated_at),
  };
}

type ListRow = PlaylistRow & {
  c_total: number;
  c_ready: number;
  c_failed: number;
  c_skipped: number;
};

/** The user's playlists, newest first, with progress counts. Every ready video has one episode. */
export function listPlaylistsForUser(userId: string, limit = 200): PlaylistListItem[] {
  const rows = all<ListRow>(
    `SELECT p.*,
       (SELECT COUNT(*) FROM videos v WHERE v.playlist_id = p.id) AS c_total,
       (SELECT COUNT(*) FROM videos v WHERE v.playlist_id = p.id AND v.status = 'ready') AS c_ready,
       (SELECT COUNT(*) FROM videos v WHERE v.playlist_id = p.id AND v.status = 'failed') AS c_failed,
       (SELECT COUNT(*) FROM videos v WHERE v.playlist_id = p.id AND v.status = 'skipped') AS c_skipped
     FROM playlists p
     WHERE p.user_id = ?
     ORDER BY p.created_at DESC
     LIMIT ?`,
    userId,
    Math.max(1, Math.min(500, Math.floor(limit))),
  );
  return rows.map((r) => {
    const total = Number(r.c_total);
    const ready = Number(r.c_ready);
    const failed = Number(r.c_failed);
    const skipped = Number(r.c_skipped);
    return {
      ...toPlaylistView(r),
      counts: {
        total,
        ready,
        failed,
        skipped,
        processing: Math.max(0, total - ready - failed - skipped),
        episodes: ready,
      },
    };
  });
}

/** The playlist row if it belongs to the user, else undefined. */
export function getOwnedPlaylist(userId: string, playlistId: string): PlaylistRow | undefined {
  return get<PlaylistRow>("SELECT * FROM playlists WHERE id = ? AND user_id = ?", playlistId, userId);
}

type VideoDetailRow = VideoRow & { tjson: string | null };

/** Full playlist detail for its owner, or null when missing / not owned. */
export function getPlaylistDetail(userId: string, playlistId: string): PlaylistDetail | null {
  const p = getOwnedPlaylist(userId, playlistId);
  if (!p) return null;

  const videoRows = all<VideoDetailRow>(
    `SELECT v.*, t.segments_json AS tjson
       FROM videos v LEFT JOIN transcripts t ON t.video_id = v.id
      WHERE v.playlist_id = ?
      ORDER BY v.position`,
    playlistId,
  );
  const episodeRows = all<EpisodeRow>(
    `SELECT e.* FROM episodes e
      WHERE e.playlist_id = ? AND e.kind = 'video' AND e.status = 'voiced' AND e.video_id IS NOT NULL
      ORDER BY e.created_at DESC`,
    playlistId,
  );

  // One clip per ready video (the newest); legacy podcast episodes don't parse as clips and are skipped.
  const clipByVideo = new Map<string, EpisodeRow & { clip: ClipPlan }>();
  for (const e of episodeRows) {
    if (!e.video_id || clipByVideo.has(e.video_id)) continue;
    const clip = parseStoredClip(e.script_json);
    if (clip) clipByVideo.set(e.video_id, { ...e, clip });
  }

  const episodes: EpisodeView[] = [];
  const videos: VideoView[] = videoRows.map((v) => {
    const ep = v.status === "ready" ? clipByVideo.get(v.id) : undefined;
    if (ep) {
      const segments: TranscriptSegment[] = cleanSegments(parse(v.tjson));
      episodes.push({
        id: ep.id,
        playlistId: ep.playlist_id,
        videoId: v.id,
        youtubeVideoId: v.youtube_video_id,
        title: ep.clip.title,
        clip: ep.clip,
        excerpt: segments.length ? clipExcerpt(segments, ep.clip.start, ep.clip.end, MAX_EXCERPT_WORDS) : "",
        durationS: ep.clip.end - ep.clip.start,
        createdAt: Number(ep.created_at),
      });
    }
    return {
      id: v.id,
      youtubeVideoId: v.youtube_video_id,
      youtubeUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(v.youtube_video_id)}`,
      position: Number(v.position),
      title: v.title,
      channel: v.channel,
      durationS: Number(v.duration_s),
      thumbnail: v.thumbnail,
      transcriptStatus: v.transcript_status,
      status: v.status,
      error: v.error,
      episodeId: ep?.id ?? null,
    };
  });

  const skipped = videos.filter((v) => v.status === "skipped").length;
  const ready = videos.filter((v) => v.status === "ready").length;
  const failed = videos.filter((v) => v.status === "failed").length;
  const total = videos.length - skipped;
  const reels = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM moments m JOIN videos v ON v.id = m.video_id
      WHERE m.playlist_id = ? AND v.status = 'ready' AND v.moments_status = 'ready'`,
    playlistId,
  );
  const share = get<{ slug: string }>("SELECT slug FROM shares WHERE playlist_id = ? AND kind = 'playlist'", playlistId);
  return {
    playlist: toPlaylistView(p),
    videos,
    episodes,
    progress: { total, ready, failed, skipped, processing: Math.max(0, total - ready - failed) },
    reels: {
      ready: Number(reels?.n ?? 0),
      pending: videoRows.filter((v) => v.status === "ready" && v.moments_status === "pending").length,
    },
    shareSlug: share?.slug ?? null,
  };
}
