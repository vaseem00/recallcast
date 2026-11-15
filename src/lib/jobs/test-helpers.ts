/**
 * Test helpers for the jobs module (fixtures and fakes only; no network). Not imported by app code.
 */
import { all, get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { createMockAiProvider } from "@/lib/ai/mock";
import { createMockTranscriptProvider } from "@/lib/transcripts/mock";
import type { PlaylistMeta, VideoMeta } from "@/lib/types";
import type { YouTubeProvider } from "@/lib/youtube/provider";
import { staticProviders, type Providers, type ProviderResolver } from "./providers";

export function seedUser(email = `u${Math.random().toString(36).slice(2)}@example.com`): string {
  const id = newId();
  run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)", id, email, Date.now());
  return id;
}

export function mkVideo(youtubeVideoId: string, position: number, durationS = 600): VideoMeta {
  return {
    youtubeVideoId,
    title: `Video ${position + 1}: ideas about memory`,
    channel: "Test Channel",
    durationS,
    thumbnail: `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`,
    position,
  };
}

/** A YouTube provider that returns exactly these videos for any playlist id. */
export function fakeYouTube(videos: VideoMeta[], opts: { title?: string; channel?: string } = {}): YouTubeProvider & {
  calls: number;
} {
  const p = {
    calls: 0,
    async fetchPlaylist(id: string): Promise<PlaylistMeta> {
      p.calls++;
      return {
        youtubePlaylistId: id,
        kind: "playlist",
        title: opts.title ?? "Test Playlist",
        channel: opts.channel ?? "Test Channel",
        thumbnail: videos[0]?.thumbnail ?? "",
        videos: videos.map((v) => ({ ...v })),
      };
    },
    async fetchVideo(id: string): Promise<PlaylistMeta> {
      p.calls++;
      const v = { ...(videos[0] ?? mkVideo(id, 0)), youtubeVideoId: id, position: 0 };
      return { youtubePlaylistId: null, kind: "video", title: v.title, channel: v.channel, thumbnail: v.thumbnail, videos: [v] };
    },
  };
  return p;
}

/** Wraps the AiProvider with a call counter. */
export function countingAi(base = createMockAiProvider()) {
  const calls = { pickClip: 0, pickMoments: 0 };
  const ai: Providers["ai"] & { calls: typeof calls } = {
    calls,
    async pickClip(i) {
      calls.pickClip++;
      return base.pickClip(i);
    },
    async pickMoments(i) {
      calls.pickMoments++;
      return base.pickMoments(i);
    },
  };
  return ai;
}

export function mockProviders(overrides: Partial<Providers> = {}): ProviderResolver {
  return staticProviders({
    youtube: fakeYouTube([mkVideo("vidAAAAAAA1", 0), mkVideo("vidAAAAAAA2", 1), mkVideo("vidAAAAAAA3", 2)]),
    transcripts: createMockTranscriptProvider(),
    ai: createMockAiProvider(),
    ...overrides,
  });
}

export function playlistRow(id: string) {
  return get<{ status: string; error: string | null; title: string; channel: string }>(
    "SELECT status, error, title, channel FROM playlists WHERE id = ?",
    id,
  );
}

export function videoRows(playlistId: string) {
  return all<{ id: string; youtube_video_id: string; status: string; transcript_status: string; error: string | null }>(
    "SELECT id, youtube_video_id, status, transcript_status, error FROM videos WHERE playlist_id = ? ORDER BY position",
    playlistId,
  );
}

export function episodeRows(playlistId: string) {
  return all<{ id: string; video_id: string | null; kind: string; status: string; audio_path: string | null; created_at: number; error: string | null }>(
    "SELECT id, video_id, kind, status, audio_path, created_at, error FROM episodes WHERE playlist_id = ? ORDER BY created_at",
    playlistId,
  );
}

export function jobRows(status?: string) {
  return status
    ? all<{ id: string; type: string; status: string; payload_json: string; attempts: number; last_error: string | null }>(
        "SELECT * FROM jobs WHERE status = ? ORDER BY created_at",
        status,
      )
    : all<{ id: string; type: string; status: string; payload_json: string; attempts: number; last_error: string | null }>(
        "SELECT * FROM jobs ORDER BY created_at",
      );
}
