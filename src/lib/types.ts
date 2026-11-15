/**
 * Shared domain types: the contract every module codes against.
 * Keep this file free of runtime imports so it is safe for client and server.
 */

export interface TranscriptSegment {
  /** Start offset in seconds. */
  start: number;
  /** Duration in seconds. */
  dur: number;
  text: string;
}

export interface VideoMeta {
  youtubeVideoId: string;
  title: string;
  channel: string;
  durationS: number;
  thumbnail: string;
  position: number;
  /**
   * The creator's chapter marks, read from the description's timestamps. [] when it has none;
   * undefined when the provider did not read the description.
   */
  chapters?: Chapter[];
}

/** One chapter mark: where it starts (whole seconds into the video) and its title. */
export interface Chapter {
  start: number;
  title: string;
}

export interface PlaylistMeta {
  youtubePlaylistId: string | null;
  kind: "playlist" | "video";
  title: string;
  channel: string;
  thumbnail: string;
  videos: VideoMeta[];
}

/**
 * How a clip's window was chosen:
 *  - ai:         Claude read the timed transcript and picked the most important part
 *  - heuristic:  the free scoring rule picked it (mock mode, or Claude's answer was unusable)
 *  - whole:      the video is short enough to play in full
 *  - nocaptions: no transcript was available, so a default window was used
 */
export type ClipPick = "ai" | "heuristic" | "whole" | "nocaptions";

/**
 * One episode = one 3-4 minute part of a YouTube video, played through the official embedded
 * player (start/end), never downloaded or re-hosted. Stored as JSON in episodes.script_json.
 */
export interface ClipPlan {
  /** Whole seconds into the video. */
  start: number;
  /** Whole seconds into the video; end > start. */
  end: number;
  /** Short episode title (not the video title). */
  title: string;
  /** 1-2 sentences: what this part covers. */
  summary: string;
  /** One sentence: why this part is the one worth hearing. */
  reason: string;
  picked: ClipPick;
}

/**
 * How a reel's window was chosen:
 *  - ai:        Claude read the timed transcript and picked the moment
 *  - heuristic: the free scoring rule picked it (mock mode, or Claude's answer was unusable)
 *  - whole:     the video is about a minute or less, so it plays in full
 */
export type MomentPick = "ai" | "heuristic" | "whole";

/**
 * What a reel's window was cut from:
 *  - transcript: what is said (Claude or the heuristic read the captions)
 *  - chapters:   no captions; the reel starts at one of the creator's chapter marks
 *  - position:   no captions and no chapters; a minute just after the intro
 * Reels cut without captions are replaced by transcript reels once captions are found.
 */
export type MomentBasis = "transcript" | "chapters" | "position";

/**
 * One reel = one self-contained moment of a YouTube video, about a minute long, played through
 * the official embedded player (start/end). A video has up to a handful of them, best first.
 * Stored one row each in the moments table.
 */
export interface MomentPlan {
  /** Whole seconds into the video. */
  start: number;
  /** Whole seconds into the video; end > start. */
  end: number;
  /** Headline shown in the feed: what the viewer gets from this moment. */
  hook: string;
  /** One sentence: the point of the moment. May be "". */
  takeaway: string;
  picked: MomentPick;
  /** Absent means "transcript". */
  basis?: MomentBasis;
}

// ---- DB enum unions (mirror the CHECK constraints in src/lib/db.ts) ----

export type PlaylistKind = "playlist" | "video";
export type PlaylistStatus = "queued" | "ingesting" | "processing" | "ready" | "partial" | "failed";
export type TranscriptStatus = "pending" | "ok" | "needs_manual" | "failed";
// 'scripting' and 'voicing' are left over from the removed AI-voiced episodes; nothing sets them now.
export type VideoStatus =
  | "pending"
  | "transcribing"
  | "analyzing"
  | "scripting"
  | "voicing"
  | "ready"
  | "failed"
  | "skipped";
export type TranscriptSource = "youtubei" | "manual" | "mock";
// 'recap' episodes and the 'pending'/'scripted' statuses are legacy (removed season recap and
// voicing). A clip episode is written once, complete, with status 'voiced' (= ready to play).
export type EpisodeKind = "video" | "recap";
export type EpisodeStatus = "pending" | "scripted" | "voiced" | "failed";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type JobType = "ingest_playlist" | "process_video" | "pick_moments";
/**
 * Reels of a video: 'none' (not asked for yet, or the video has no transcript), 'pending' (a
 * pick_moments job is queued or running), 'ready' (the moments rows are the result, possibly none).
 */
export type MomentsStatus = "none" | "pending" | "ready";
export type ShareKind = "moment" | "playlist";

export interface JobPayloads {
  ingest_playlist: { playlistId: string };
  process_video: { videoId: string };
  pick_moments: { videoId: string };
}

// ---- DB row shapes (snake_case, exactly as stored) ----

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface PlaylistRow {
  id: string;
  user_id: string;
  source_url: string;
  youtube_playlist_id: string | null;
  kind: PlaylistKind;
  title: string;
  channel: string;
  thumbnail: string;
  status: PlaylistStatus;
  error: string | null;
  /** Playlist-level retries (ingest, recap) the user has used. */
  retry_count: number;
  created_at: number;
  updated_at: number;
}

export interface VideoRow {
  id: string;
  playlist_id: string;
  youtube_video_id: string;
  position: number;
  title: string;
  channel: string;
  duration_s: number;
  thumbnail: string;
  transcript_status: TranscriptStatus;
  status: VideoStatus;
  error: string | null;
  /** Paid re-runs the user has triggered for this video (retry or re-pasted transcript). */
  retry_count: number;
  moments_status: MomentsStatus;
  /** JSON Chapter[] from the description; NULL when it was never read. */
  chapters_json: string | null;
}

export interface MomentRow {
  id: string;
  playlist_id: string;
  video_id: string;
  /** 0 = the strongest moment of its video. */
  ord: number;
  start_s: number;
  end_s: number;
  hook: string;
  takeaway: string;
  picked: MomentPick;
  basis: MomentBasis;
  saved_at: number | null;
  seen_at: number | null;
  /** The owner's viewing: seconds of it played, times played to the end, times swiped away early. */
  watch_s: number;
  completions: number;
  skips: number;
  created_at: number;
}

export interface ShareRow {
  /** Unguessable public id (22 url-safe characters, 128 random bits). */
  slug: string;
  user_id: string;
  kind: ShareKind;
  moment_id: string | null;
  playlist_id: string;
  created_at: number;
}

export interface TranscriptRow {
  video_id: string;
  source: TranscriptSource;
  lang: string;
  /** JSON-encoded TranscriptSegment[] */
  segments_json: string;
}

export interface EpisodeRow {
  id: string;
  playlist_id: string;
  video_id: string | null;
  kind: EpisodeKind;
  title: string;
  /** JSON-encoded ClipPlan (legacy rows hold an old podcast script and are ignored). */
  script_json: string;
  /** Legacy: MP3 of a removed AI-voiced episode. Always NULL for clips. */
  audio_path: string | null;
  duration_s: number | null;
  status: EpisodeStatus;
  error: string | null;
  created_at: number;
}

// The cards/reviews tables (removed review feature) and the knowledge table (removed memory
// cards) still exist in the schema because migrations are append-only; no code reads them, and
// playlist/account deletes cascade to them.

export interface JobRow {
  id: string;
  type: JobType;
  payload_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: number;
  locked_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** Public user shape returned by the API (never includes password_hash). */
export interface PublicUser {
  id: string;
  email: string;
  createdAt: number;
}
