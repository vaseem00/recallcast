import "server-only";
import { randomBytes } from "node:crypto";
import { cleanCaptionText } from "@/lib/ai/transcript";
import { all, get, now as dbNow, run, transaction } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { rankFeed, seriesOrder, type RankItem } from "@/lib/feed-rank";
import { HttpError } from "@/lib/http";
import { cleanSegments, queueMissingMoments } from "@/lib/jobs/pipeline";
import type { MomentBasis, MomentPick, ShareKind, TranscriptSegment } from "@/lib/types";

/**
 * Reels: read models and user actions for the swipe feed, and the public share links.
 *
 * A reel is a row of the moments table: a window of about a minute of one YouTube video, played
 * through the embedded player. Owner queries are scoped by user id (another user's id reads as
 * missing, 404). Public queries are keyed only by the share slug and return nothing that
 * identifies the owner.
 */

/** One caption line inside a reel. `t` is seconds into the video, not into the reel. */
export interface ReelCaption {
  t: number;
  d: number;
  text: string;
}

export interface ReelView {
  id: string;
  /** null on public pages. */
  playlistId: string | null;
  playlistTitle: string;
  youtubeVideoId: string;
  videoTitle: string;
  channel: string;
  thumbnail: string;
  /** Window, whole seconds into the video. */
  start: number;
  end: number;
  hook: string;
  takeaway: string;
  picked: MomentPick;
  /** What the window was cut from: the transcript, a chapter mark, or the position (no captions). */
  basis: MomentBasis;
  saved: boolean;
  seen: boolean;
  /** The reel's public link id, when its owner has shared it. null on public pages. */
  shareSlug: string | null;
  /** What is said inside the window, for the captions under the video. */
  captions: ReelCaption[];
}

export interface ReelFeed {
  reels: ReelView[];
  /** Reels matching the filter, of which `reels` is the first page. */
  total: number;
  /** Videos whose reels are being cut right now. */
  pending: number;
  /** Ready videos in scope, and how many of them have no transcript to cut reels from. */
  videos: number;
  noCaptions: number;
}

export interface ReelFilter {
  playlistId?: string | null;
  saved?: boolean;
  limit?: number;
}

/** Reels sent per request. More arrive when the viewer reaches the end (unseen ones first). */
export const FEED_PAGE = 30;
export const SHARED_FEED_MAX = 60;
const MAX_CAPTION_LINES = 120;
const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;

interface FeedRow {
  id: string;
  playlist_id: string;
  video_id: string;
  start_s: number;
  end_s: number;
  hook: string;
  takeaway: string;
  picked: MomentPick;
  basis: MomentBasis;
  saved_at: number | null;
  seen_at: number | null;
  youtube_video_id: string;
  video_title: string;
  video_channel: string;
  video_thumbnail: string;
  playlist_title: string;
  playlist_channel: string;
  share_slug: string | null;
}

const FEED_COLUMNS = `
  m.id, m.playlist_id, m.video_id, m.start_s, m.end_s, m.hook, m.takeaway, m.picked, m.basis, m.saved_at, m.seen_at,
  v.youtube_video_id, v.title AS video_title, v.channel AS video_channel, v.thumbnail AS video_thumbnail,
  p.title AS playlist_title, p.channel AS playlist_channel`;

const FEED_FROM = `
  FROM moments m
  JOIN videos v ON v.id = m.video_id
  JOIN playlists p ON p.id = m.playlist_id`;

const OWNER_WHERE = `
 WHERE p.user_id = ? AND v.status = 'ready' AND v.moments_status = 'ready'
   AND (? IS NULL OR p.id = ?)
   AND (? = 0 OR m.saved_at IS NOT NULL)`;

const OWNER_SHARE = "(SELECT s.slug FROM shares s WHERE s.moment_id = m.id AND s.kind = 'moment') AS share_slug";

/** Saved reels: newest save first. The feed itself is ordered by rankFeed (src/lib/feed-rank.ts). */
const SAVED_ORDER = "ORDER BY m.saved_at DESC, m.id";

/** What the ranking reads for every reel in scope: no text, no transcripts. */
interface RankRow {
  id: string;
  playlist_id: string;
  video_id: string;
  start_s: number;
  end_s: number;
  basis: MomentBasis;
  saved_at: number | null;
  seen_at: number | null;
  watch_s: number;
  completions: number;
  skips: number;
  shared: number;
  position: number;
  video_title: string;
  playlist_created_at: number;
}

const RANK_COLUMNS = `
  m.id, m.playlist_id, m.video_id, m.start_s, m.end_s, m.basis, m.saved_at, m.seen_at, m.watch_s, m.completions, m.skips,
  EXISTS (SELECT 1 FROM shares s WHERE s.moment_id = m.id AND s.kind = 'moment') AS shared,
  v.position, v.title AS video_title, p.created_at AS playlist_created_at`;

/** RankRows -> RankItems, with each playlist's series order worked out from its videos' titles. */
function toRankItems(rows: readonly RankRow[]): RankItem[] {
  const videosByPlaylist = new Map<string, Map<string, { id: string; position: number; title: string }>>();
  for (const r of rows) {
    let videos = videosByPlaylist.get(r.playlist_id);
    if (!videos) videosByPlaylist.set(r.playlist_id, (videos = new Map()));
    if (!videos.has(r.video_id)) videos.set(r.video_id, { id: r.video_id, position: Number(r.position), title: r.video_title });
  }
  const order = new Map<string, number>();
  for (const videos of videosByPlaylist.values()) {
    for (const [id, i] of seriesOrder([...videos.values()])) order.set(id, i);
  }
  return rows.map((r) => ({
    id: r.id,
    playlistId: r.playlist_id,
    playlistCreatedAt: Number(r.playlist_created_at),
    videoId: r.video_id,
    seriesIndex: order.get(r.video_id) ?? Number(r.position),
    start: Number(r.start_s),
    end: Number(r.end_s),
    basis: r.basis,
    savedAt: r.saved_at === null ? null : Number(r.saved_at),
    seenAt: r.seen_at === null ? null : Number(r.seen_at),
    watchS: Number(r.watch_s) || 0,
    completions: Number(r.completions) || 0,
    skips: Number(r.skips) || 0,
    shared: Boolean(Number(r.shared)),
  }));
}

function parseSegments(json: string | null | undefined): TranscriptSegment[] {
  if (!json) return [];
  try {
    return cleanSegments(JSON.parse(json));
  } catch {
    return [];
  }
}

/** The caption lines that start inside [start, end). */
export function captionsFor(segments: TranscriptSegment[], start: number, end: number): ReelCaption[] {
  const out: ReelCaption[] = [];
  for (const s of segments) {
    if (s.start < start - 0.5) continue;
    if (s.start >= end) break;
    const text = cleanCaptionText(s.text).slice(0, 240);
    if (!text) continue;
    out.push({ t: Math.round(s.start * 100) / 100, d: Math.round(s.dur * 100) / 100, text });
    if (out.length >= MAX_CAPTION_LINES) break;
  }
  return out;
}

function toReels(rows: FeedRow[], opts: { isPublic: boolean }): ReelView[] {
  // One transcript per video, parsed once however many of its reels are on the page.
  const transcripts = new Map<string, TranscriptSegment[]>();
  for (const r of rows) {
    if (transcripts.has(r.video_id)) continue;
    const t = get<{ segments_json: string }>("SELECT segments_json FROM transcripts WHERE video_id = ?", r.video_id);
    transcripts.set(r.video_id, parseSegments(t?.segments_json));
  }
  return rows.map((r) => ({
    id: r.id,
    playlistId: opts.isPublic ? null : r.playlist_id,
    playlistTitle: r.playlist_title,
    youtubeVideoId: r.youtube_video_id,
    videoTitle: r.video_title,
    channel: r.video_channel || r.playlist_channel,
    thumbnail: r.video_thumbnail,
    start: Number(r.start_s),
    end: Number(r.end_s),
    hook: r.hook,
    takeaway: r.takeaway,
    picked: r.picked,
    basis: r.basis ?? "transcript",
    saved: !opts.isPublic && r.saved_at !== null,
    seen: !opts.isPublic && r.seen_at !== null,
    shareSlug: opts.isPublic ? null : r.share_slug,
    captions: captionsFor(transcripts.get(r.video_id) ?? [], Number(r.start_s), Number(r.end_s)),
  }));
}

/**
 * The signed-in user's feed: all their playlists woven together by rankFeed (one playlist in
 * series order when `playlistId` is given; saved reels newest first). As a side effect it queues
 * reels for videos that have none yet (queueMissingMoments), which is how playlists added before
 * reels existed, and videos without captions from before they got reels, get theirs.
 */
export function loadReelFeed(userId: string, filter: ReelFilter = {}, now: number = Date.now()): ReelFeed {
  const playlistId = filter.playlistId ?? null;
  const saved = filter.saved ? 1 : 0;
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? FEED_PAGE)));
  if (!saved) queueMissingMoments(userId, playlistId);

  let rows: FeedRow[];
  let total: number;
  if (saved) {
    rows = all<FeedRow>(
      `SELECT ${FEED_COLUMNS}, ${OWNER_SHARE} ${FEED_FROM} ${OWNER_WHERE} ${SAVED_ORDER} LIMIT ?`,
      userId,
      playlistId,
      playlistId,
      saved,
      limit,
    );
    total = Number(get<{ n: number }>(`SELECT COUNT(*) AS n ${FEED_FROM} ${OWNER_WHERE}`, userId, playlistId, playlistId, saved)?.n ?? 0);
  } else {
    const candidates = all<RankRow>(`SELECT ${RANK_COLUMNS} ${FEED_FROM} ${OWNER_WHERE}`, userId, playlistId, playlistId, saved);
    const order = rankFeed(toRankItems(candidates), { now, mode: playlistId ? "series" : "mix" });
    const page = order.slice(0, limit);
    const place = new Map(page.map((id, i) => [id, i]));
    rows = page.length
      ? all<FeedRow>(`SELECT ${FEED_COLUMNS}, ${OWNER_SHARE} ${FEED_FROM} WHERE m.id IN (${page.map(() => "?").join(", ")})`, ...page)
      : [];
    rows.sort((a, b) => place.get(a.id)! - place.get(b.id)!);
    total = candidates.length;
  }
  const scope = get<{ videos: number; pending: number; no_captions: number }>(
    `SELECT COUNT(*) AS videos,
            COALESCE(SUM(CASE WHEN v.moments_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM transcripts t WHERE t.video_id = v.id) THEN 0 ELSE 1 END), 0) AS no_captions
       FROM videos v JOIN playlists p ON p.id = v.playlist_id
      WHERE p.user_id = ? AND v.status = 'ready' AND (? IS NULL OR p.id = ?)`,
    userId,
    playlistId,
    playlistId,
  );
  return {
    reels: toReels(rows, { isPublic: false }),
    total,
    pending: Number(scope?.pending ?? 0),
    videos: Number(scope?.videos ?? 0),
    noCaptions: Number(scope?.no_captions ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Owner actions
// ---------------------------------------------------------------------------

interface OwnedMoment {
  id: string;
  playlist_id: string;
  saved_at: number | null;
  seen_at: number | null;
}

function ownedMoment(userId: string, momentId: string): OwnedMoment {
  const m = get<OwnedMoment>(
    `SELECT m.id, m.playlist_id, m.saved_at, m.seen_at
       FROM moments m JOIN playlists p ON p.id = m.playlist_id
      WHERE m.id = ? AND p.user_id = ?`,
    momentId,
    userId,
  );
  if (!m) throw new HttpError(404, "Reel not found");
  return m;
}

/** Most seconds one report may add: a reel is at most REEL_MAX_S long, replays included. */
export const MAX_WATCH_REPORT_S = 600;

export interface ReelStatePatch {
  saved?: boolean;
  seen?: boolean;
  /** Seconds of the reel played since the last report (0..MAX_WATCH_REPORT_S). */
  watched?: number;
  /** It was played to the end. */
  completed?: boolean;
  /** The viewer swiped away within its first seconds. */
  skipped?: boolean;
}

/**
 * Saves or unsaves a reel, marks it seen (which moves it behind the unseen ones), and/or adds
 * a viewing report (seconds played, played to the end, swiped away early), which the feed's
 * ranking reads. Any viewing report also marks the reel seen.
 */
export function setReelState(userId: string, momentId: string, patch: ReelStatePatch, at: number = dbNow()): { saved: boolean; seen: boolean } {
  return transaction(() => {
    const m = ownedMoment(userId, momentId);
    let savedAt = m.saved_at;
    let seenAt = m.seen_at;
    const watched = Math.round(Math.max(0, Math.min(MAX_WATCH_REPORT_S, Number(patch.watched) || 0)));
    const viewed = watched > 0 || patch.completed === true || patch.skipped === true;
    if (patch.saved !== undefined) savedAt = patch.saved ? (m.saved_at ?? at) : null;
    if (patch.seen || viewed) seenAt = at;
    run(
      `UPDATE moments SET saved_at = ?, seen_at = ?, watch_s = watch_s + ?, completions = completions + ?, skips = skips + ?
        WHERE id = ?`,
      savedAt,
      seenAt,
      watched,
      patch.completed === true ? 1 : 0,
      patch.skipped === true && patch.completed !== true ? 1 : 0,
      momentId,
    );
    return { saved: savedAt !== null, seen: seenAt !== null };
  });
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

/** 128 random bits, url-safe: the only credential of a public link. */
export function newShareSlug(): string {
  return randomBytes(16).toString("base64url");
}

export function isShareSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

function createShare(userId: string, kind: ShareKind, playlistId: string, momentId: string | null): string {
  const cap = getEnv().MAX_SHARES_PER_USER;
  const used = get<{ n: number }>("SELECT COUNT(*) AS n FROM shares WHERE user_id = ?", userId);
  if (Number(used?.n ?? 0) >= cap) {
    throw new HttpError(429, `You have ${cap} public links already. Stop sharing one to make room.`);
  }
  const slug = newShareSlug();
  run(
    "INSERT INTO shares (slug, user_id, kind, moment_id, playlist_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    slug,
    userId,
    kind,
    momentId,
    playlistId,
    dbNow(),
  );
  return slug;
}

/** Returns the reel's public link id, creating it on first use. */
export function shareMoment(userId: string, momentId: string): { slug: string } {
  return transaction(() => {
    const m = ownedMoment(userId, momentId);
    const existing = get<{ slug: string }>("SELECT slug FROM shares WHERE moment_id = ? AND kind = 'moment'", momentId);
    return { slug: existing?.slug ?? createShare(userId, "moment", m.playlist_id, momentId) };
  });
}

/** Revokes the reel's public link. The old address stops working at once. */
export function unshareMoment(userId: string, momentId: string): void {
  transaction(() => {
    ownedMoment(userId, momentId);
    run("DELETE FROM shares WHERE moment_id = ? AND kind = 'moment' AND user_id = ?", momentId, userId);
  });
}

function ownedPlaylistId(userId: string, playlistId: string): string {
  const p = get<{ id: string }>("SELECT id FROM playlists WHERE id = ? AND user_id = ?", playlistId, userId);
  if (!p) throw new HttpError(404, "Playlist not found");
  return p.id;
}

/** The playlist's public feed link id, or null when it is not shared. */
export function getPlaylistShare(userId: string, playlistId: string): string | null {
  const s = get<{ slug: string }>(
    "SELECT slug FROM shares WHERE playlist_id = ? AND kind = 'playlist' AND user_id = ?",
    playlistId,
    userId,
  );
  return s?.slug ?? null;
}

/** Returns the public link id of the playlist's reels, creating it on first use. */
export function sharePlaylist(userId: string, playlistId: string): { slug: string } {
  return transaction(() => {
    ownedPlaylistId(userId, playlistId);
    return { slug: getPlaylistShare(userId, playlistId) ?? createShare(userId, "playlist", playlistId, null) };
  });
}

export function unsharePlaylist(userId: string, playlistId: string): void {
  transaction(() => {
    ownedPlaylistId(userId, playlistId);
    run("DELETE FROM shares WHERE playlist_id = ? AND kind = 'playlist' AND user_id = ?", playlistId, userId);
  });
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

export interface SharedPage {
  kind: ShareKind;
  /** The reel's hook, or the playlist's title. */
  title: string;
  channel: string;
  thumbnail: string;
  reels: ReelView[];
}

interface ShareTarget {
  kind: ShareKind;
  moment_id: string | null;
  playlist_id: string;
}

function shareTarget(slug: string): ShareTarget | null {
  if (!isShareSlug(slug)) return null;
  return get<ShareTarget>("SELECT kind, moment_id, playlist_id FROM shares WHERE slug = ?", slug) ?? null;
}

/** The reels a public link plays: its one reel, or the playlist's reels in feed order, capped. */
function sharedRows<T>(share: ShareTarget, columns: string): T[] {
  return share.kind === "moment"
    ? all<T>(`SELECT ${columns} ${FEED_FROM} WHERE m.id = ? AND v.status = 'ready' AND v.moments_status = 'ready'`, share.moment_id)
    : all<T>(
        `SELECT ${columns} ${FEED_FROM}
          WHERE m.playlist_id = ? AND v.status = 'ready' AND v.moments_status = 'ready'
          ORDER BY m.ord, v.position, m.start_s LIMIT ?`,
        share.playlist_id,
        SHARED_FEED_MAX,
      );
}

/**
 * What a public link shows, or null when the slug is unknown or revoked, or there is nothing
 * left to play. No account data: no owner, no email, no saved/seen state, no internal playlist id.
 */
export function getSharedPage(slug: string): SharedPage | null {
  const share = shareTarget(slug);
  if (!share) return null;
  const rows = sharedRows<FeedRow>(share, `${FEED_COLUMNS}, NULL AS share_slug`);
  if (rows.length === 0) return null;
  const reels = toReels(rows, { isPublic: true });
  const first = reels[0];
  return {
    kind: share.kind,
    title: share.kind === "moment" ? first.hook : first.playlistTitle || "Reels",
    channel: share.kind === "moment" ? first.channel : rows[0].playlist_channel || first.channel,
    thumbnail: first.thumbnail,
    reels,
  };
}

/** How many of the sample's hooks the landing page lists. */
export const SAMPLE_HOOKS = 3;

export interface SampleFeed {
  slug: string;
  /** The playlist's title (or the one reel's video title). */
  title: string;
  channel: string;
  /** Reels the link plays. */
  count: number;
  /** The first few hooks, in the order the link plays them. */
  hooks: string[];
}

/**
 * The shared feed the landing page offers without an account: the link named by SAMPLE_FEED.
 * null when the setting is empty or the link was revoked, deleted or has nothing left to play,
 * so the landing page never points at a dead address. Reads hooks only, no transcripts.
 */
export function getSampleFeed(): SampleFeed | null {
  const slug = getEnv().SAMPLE_FEED;
  if (!slug) return null;
  const share = shareTarget(slug);
  if (!share) return null;
  const rows = sharedRows<{ hook: string; video_title: string; video_channel: string; playlist_title: string; playlist_channel: string }>(
    share,
    "m.hook, v.title AS video_title, v.channel AS video_channel, p.title AS playlist_title, p.channel AS playlist_channel",
  );
  if (rows.length === 0) return null;
  const first = rows[0];
  return {
    slug,
    title: (share.kind === "moment" ? first.video_title : first.playlist_title) || "Reels",
    channel: share.kind === "moment" ? first.video_channel || first.playlist_channel : first.playlist_channel || first.video_channel,
    count: rows.length,
    hooks: rows.slice(0, SAMPLE_HOOKS).map((r) => r.hook),
  };
}
