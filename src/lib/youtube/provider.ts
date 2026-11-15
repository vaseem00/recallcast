import type { Chapter, PlaylistMeta } from "@/lib/types";

export interface YouTubeProvider {
  /** Playlist metadata plus up to MAX_VIDEOS_PER_PLAYLIST public videos, positions 0..n-1. */
  fetchPlaylist(id: string): Promise<PlaylistMeta>;
  /** A single video wrapped as a one-item PlaylistMeta (kind 'video', youtubePlaylistId null). */
  fetchVideo(id: string): Promise<PlaylistMeta>;
  /**
   * The chapter marks in each video's description, keyed by video id ([] for a video without
   * any; ids YouTube does not return are absent). Used for videos ingested before chapters were
   * read. Optional: a provider without it means "no chapters".
   */
  fetchChapters?(ids: string[]): Promise<Map<string, Chapter[]>>;
}
