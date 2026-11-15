/**
 * Client-safe UI helpers: time formatting, status labels, polling rules, clip timing,
 * URL feedback for the paste box and redirect-path sanitising. No runtime imports beyond
 * other client-safe modules, so both server and client components can use them.
 */
import type { PlaylistStatus, VideoStatus } from "@/lib/types";
import { parseYouTubeUrl } from "@/lib/youtube/parse";

export type Tone = "work" | "ok" | "warn" | "error" | "quiet";

/** 0:07, 4:32, 1:02:03. Negative or non-finite input reads 0:00. */
export function formatClock(seconds: number | null | undefined): string {
  const s = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** "4 min", "under 1 min", "1 h 12 min". */
export function formatMinutes(seconds: number | null | undefined): string {
  const s = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (s < 60) return "under 1 min";
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${totalMin} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------- statuses ----------

const PLAYLIST_LABELS: Record<PlaylistStatus, [string, Tone]> = {
  queued: ["Queued", "work"],
  ingesting: ["Reading the playlist", "work"],
  processing: ["Making episodes", "work"],
  ready: ["Ready", "ok"],
  partial: ["Partly ready", "warn"],
  failed: ["Failed", "error"],
};

const VIDEO_LABELS: Record<VideoStatus, [string, Tone]> = {
  pending: ["Waiting", "quiet"],
  transcribing: ["Getting the transcript", "work"],
  analyzing: ["Finding the key part", "work"],
  scripting: ["Working", "work"],
  voicing: ["Working", "work"],
  ready: ["Ready", "ok"],
  failed: ["Failed", "error"],
  skipped: ["Skipped", "quiet"],
};

export function playlistStatus(status: PlaylistStatus): { label: string; tone: Tone } {
  const [label, tone] = PLAYLIST_LABELS[status] ?? ["Unknown", "quiet"];
  return { label, tone };
}

export function videoStatus(status: VideoStatus, transcriptStatus?: string): { label: string; tone: Tone } {
  if (transcriptStatus === "needs_manual" && status !== "ready" && status !== "skipped") {
    return { label: "Needs a transcript", tone: "warn" };
  }
  const [label, tone] = VIDEO_LABELS[status] ?? ["Unknown", "quiet"];
  return { label, tone };
}

const SETTLED_PLAYLIST: ReadonlySet<PlaylistStatus> = new Set(["ready", "partial", "failed"]);
const ACTIVE_VIDEO: ReadonlySet<VideoStatus> = new Set(["pending", "transcribing", "analyzing", "scripting", "voicing"]);

export function isPlaylistSettled(status: PlaylistStatus): boolean {
  return SETTLED_PLAYLIST.has(status);
}

/**
 * Whether a playlist page should keep polling. It polls while the playlist itself is not
 * settled, or while any video is still moving through the pipeline (a video waiting for a
 * pasted transcript is not moving).
 */
export function shouldPollDetail(detail: {
  playlist: { status: PlaylistStatus };
  videos: { status: VideoStatus; transcriptStatus: string }[];
}): boolean {
  if (!isPlaylistSettled(detail.playlist.status)) return true;
  return detail.videos.some((v) => ACTIVE_VIDEO.has(v.status) && v.transcriptStatus !== "needs_manual");
}

export function shouldPollList(items: { status: PlaylistStatus }[]): boolean {
  return items.some((p) => !isPlaylistSettled(p.status));
}

/** Fraction 0..1 of finished (ready or failed) videos out of the non-skipped total. */
export function progressFraction(p: { total: number; ready: number; failed: number }): number {
  if (!p.total || p.total <= 0) return 0;
  const f = (p.ready + p.failed) / p.total;
  return Math.max(0, Math.min(1, f));
}

// ---------- clips ----------

/** Position inside a clip (0 at its start), clamped to [0, clip length]. */
export function clipPosition(videoTime: number, clip: { start: number; end: number }): number {
  const len = Math.max(0, clip.end - clip.start);
  const t = Number.isFinite(videoTime) ? videoTime - clip.start : 0;
  return Math.max(0, Math.min(len, t));
}

/** "From 12:04 to 15:40 of the video". */
export function clipRangeLabel(clip: { start: number; end: number }): string {
  return `${formatClock(clip.start)} to ${formatClock(clip.end)}`;
}

/** Link that opens the video on YouTube at the clip's start. */
export function youtubeAt(youtubeVideoId: string, seconds: number): string {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  return `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeVideoId)}${t > 0 ? `&t=${t}s` : ""}`;
}

// ---------- paste box ----------

export type UrlFeedback =
  | { state: "empty"; message: string }
  | { state: "ok"; kind: "playlist" | "video"; message: string }
  | { state: "invalid"; message: string };

export function describeUrl(input: string): UrlFeedback {
  const value = input.trim();
  if (!value) return { state: "empty", message: "A playlist link, or a link to one video." };
  const parsed = parseYouTubeUrl(value);
  if (!parsed) {
    if (/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
      return { state: "invalid", message: "Paste the whole link, not only the ID." };
    }
    if (/[?&]list=(WL|LL)\b/.test(value)) {
      return { state: "invalid", message: "Watch later and Liked videos are private. Make a public or unlisted playlist." };
    }
    return { state: "invalid", message: "That is not a YouTube playlist or video link." };
  }
  if (parsed.kind === "playlist") return { state: "ok", kind: "playlist", message: "Playlist link. Each video becomes an episode." };
  return { state: "ok", kind: "video", message: "Video link. It becomes one episode." };
}

// ---------- redirects ----------

/** A same-origin path to go to after sign-in; anything else falls back to /app. */
export function safeNextPath(raw: string | string[] | null | undefined, fallback = "/app"): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const u = new URL(value, "http://localhost");
    if (u.origin !== "http://localhost") return fallback;
    if (u.pathname === "/login" || u.pathname === "/signup") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** Speeds offered by the player. */
export const SPEEDS = [1, 1.25, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export function isSpeed(n: unknown): n is Speed {
  return typeof n === "number" && (SPEEDS as readonly number[]).includes(n);
}

export function speedLabel(s: number): string {
  return `${s}x`;
}

/** Keys the global player shortcuts must ignore: typing in fields, or keys a focused control owns. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof el !== "object") return false;
  const node = el as { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null };
  if (node.isContentEditable) return true;
  const tag = (node.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (node.getAttribute?.("type") ?? "text").toLowerCase();
    // Checkbox / radio / button inputs do not take text; range owns its arrows (handled by caller).
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return false;
}
