import type { MomentBasis } from "@/lib/types";

/**
 * The order of the reels feed. Pure and deterministic (no I/O, no randomness): the same reels
 * and viewing history at the same time give the same order.
 *
 * "mix" (the All feed) works like a short-video feed's ranking, with rules that suit learning
 * from series:
 *
 *  1. Reels not seen yet come first. Seen ones follow, the ones watched longest ago first (so a
 *     finished feed starts over), and reels the viewer swiped away from without finishing last.
 *  2. Each playlist plays as a series: its videos in series order (seriesOrder below: a playlist
 *     that lists Week 11 before Week 1 is played from Week 1), and each video's reels in the
 *     order they occur. A video the viewer swiped away from without finishing any of its reels
 *     moves to the end of its playlist.
 *  3. Playlists are woven together (smooth weighted round-robin), so every playlist shows up
 *     near the top and a strong playlist shows up more often. A playlist's weight rises with
 *     what the viewer does with its reels (watches to the end, saves, shares) and falls with
 *     early swipes; new playlists get a boost that halves every few days; reels cut without
 *     captions (by chapter or position) weigh less than reels cut from what is said.
 *  4. Variety: no more than two reels of one video, or three of one playlist, in a row while
 *     another playlist still has reels.
 *
 * "series" (one playlist's feed): the series order alone, unseen first, then the seen ones.
 */

export interface RankItem {
  id: string;
  playlistId: string;
  /** When the playlist was added (ms). */
  playlistCreatedAt: number;
  videoId: string;
  /** The video's place in its playlist's series order (seriesOrder), 0 = first. */
  seriesIndex: number;
  /** Window, seconds into the video. */
  start: number;
  end: number;
  basis: MomentBasis;
  savedAt: number | null;
  seenAt: number | null;
  /** Seconds of it the viewer has played. */
  watchS: number;
  /** Times played to the end. */
  completions: number;
  /** Times swiped away within the first seconds. */
  skips: number;
  /** The viewer made a public link for it. */
  shared: boolean;
}

export type RankMode = "mix" | "series";

export interface RankOptions {
  now: number;
  mode: RankMode;
}

/** How much a reel is worth by what it was cut from. */
export const BASIS_QUALITY: Readonly<Record<MomentBasis, number>> = Object.freeze({ transcript: 1, chapters: 0.7, position: 0.4 });
/** A new playlist's boost halves every this many days. */
export const FRESH_HALF_LIFE_DAYS = 3;
/** Pretend views with no signal: one save among the first views moves a playlist; one never decides it. */
const AFFINITY_PRIOR = 4;
/** No playlist's weight drops below this, so every playlist keeps a place in the feed. */
const MIN_WEIGHT = 0.15;
export const MAX_VIDEO_RUN = 2;
export const MAX_PLAYLIST_RUN = 3;

const DAY_MS = 86_400_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function viewed(r: RankItem): boolean {
  return r.seenAt !== null || r.watchS > 0 || r.completions > 0 || r.skips > 0;
}

/** Swiped away early and never finished, saved or shared. */
function turnedDown(r: RankItem): boolean {
  return r.skips > 0 && r.completions === 0 && r.savedAt === null && !r.shared;
}

/**
 * The viewer's taste for one playlist, -1 (keeps swiping it away) to 1 (finishes, saves and
 * shares its reels), from that playlist's reels. 0 before any viewing.
 */
export function playlistAffinity(items: readonly RankItem[]): number {
  let signal = 0;
  let views = 0;
  for (const r of items) {
    if (viewed(r)) views++;
    const length = Math.max(1, r.end - r.start);
    signal += 0.5 * Math.min(1, Math.max(0, r.watchS) / length);
    signal += Math.min(3, Math.max(0, r.completions));
    if (r.savedAt !== null) signal += 2;
    if (r.shared) signal += 2;
    signal -= 1.5 * Math.min(3, Math.max(0, r.skips));
  }
  return clamp(signal / (views + AFFINITY_PRIOR), -1, 1);
}

/** 1 for a playlist added now, halving every FRESH_HALF_LIFE_DAYS. */
export function freshness(createdAt: number, now: number): number {
  const days = Math.max(0, now - createdAt) / DAY_MS;
  return 0.5 ** (days / FRESH_HALF_LIFE_DAYS);
}

/** A playlist's share of the woven feed (see the module comment). */
export function playlistWeight(items: readonly RankItem[], now: number): number {
  const unseen = items.filter((r) => r.seenAt === null);
  const pool = unseen.length ? unseen : items;
  const quality = pool.reduce((s, r) => s + (BASIS_QUALITY[r.basis] ?? BASIS_QUALITY.position), 0) / Math.max(1, pool.length);
  const fresh = items.length ? freshness(items[0].playlistCreatedAt, now) : 0;
  return Math.max(MIN_WEIGHT, quality * (1 + 0.8 * playlistAffinity(items) + 0.5 * fresh));
}

function seriesSort(a: RankItem, b: RankItem): number {
  return a.seriesIndex - b.seriesIndex || a.start - b.start || byId(a, b);
}

function seenTail(seen: RankItem[]): string[] {
  return seen
    .slice()
    .sort((a, b) => Number(turnedDown(a)) - Number(turnedDown(b)) || (a.seenAt ?? 0) - (b.seenAt ?? 0) || byId(a, b))
    .map((r) => r.id);
}

/** Reel ids in feed order. */
export function rankFeed(items: readonly RankItem[], opts: RankOptions): string[] {
  const unseen = items.filter((r) => r.seenAt === null);
  const seen = items.filter((r) => r.seenAt !== null);

  if (opts.mode === "series") {
    const head = unseen
      .slice()
      .sort((a, b) => b.playlistCreatedAt - a.playlistCreatedAt || (a.playlistId < b.playlistId ? -1 : a.playlistId > b.playlistId ? 1 : 0) || seriesSort(a, b))
      .map((r) => r.id);
    return [...head, ...seenTail(seen)];
  }

  // Per playlist: its weight (from all its reels, seen ones carry the signals) and its queue.
  const byPlaylist = new Map<string, RankItem[]>();
  for (const r of items) {
    const list = byPlaylist.get(r.playlistId);
    if (list) list.push(r);
    else byPlaylist.set(r.playlistId, [r]);
  }

  const weight = new Map<string, number>();
  const created = new Map<string, number>();
  const queues = new Map<string, RankItem[]>();
  for (const [pid, list] of byPlaylist) {
    weight.set(pid, playlistWeight(list, opts.now));
    created.set(pid, list[0].playlistCreatedAt);
    // A video the viewer turned down (an early swipe, nothing finished) waits at the end.
    const cold = new Set<string>();
    const warm = new Set<string>();
    for (const r of list) {
      if (r.completions > 0 || r.savedAt !== null || r.shared) warm.add(r.videoId);
      else if (turnedDown(r)) cold.add(r.videoId);
    }
    const queue = list
      .filter((r) => r.seenAt === null)
      .sort((a, b) => {
        const ca = cold.has(a.videoId) && !warm.has(a.videoId) ? 1 : 0;
        const cb = cold.has(b.videoId) && !warm.has(b.videoId) ? 1 : 0;
        return ca - cb || seriesSort(a, b);
      });
    if (queue.length) queues.set(pid, queue);
  }

  // Smooth weighted round-robin over the playlists, with the variety rule.
  const credit = new Map<string, number>([...queues.keys()].map((p) => [p, 0]));
  const out: string[] = [];
  let lastVideo = "";
  let videoRun = 0;
  let lastPlaylist = "";
  let playlistRun = 0;
  for (;;) {
    const live = [...queues.entries()].filter(([, q]) => q.length > 0).map(([p]) => p);
    if (live.length === 0) break;
    let total = 0;
    for (const p of live) {
      const w = weight.get(p)!;
      total += w;
      credit.set(p, credit.get(p)! + w);
    }
    const ranked = live.sort(
      (a, b) =>
        credit.get(b)! - credit.get(a)! ||
        weight.get(b)! - weight.get(a)! ||
        created.get(b)! - created.get(a)! ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    const allowed = (p: string) => {
      const head = queues.get(p)![0];
      if (head.videoId === lastVideo && videoRun >= MAX_VIDEO_RUN) return false;
      if (p === lastPlaylist && playlistRun >= MAX_PLAYLIST_RUN) return false;
      return true;
    };
    const pick = ranked.find(allowed) ?? ranked[0];
    credit.set(pick, credit.get(pick)! - total);
    const item = queues.get(pick)!.shift()!;
    out.push(item.id);
    videoRun = item.videoId === lastVideo ? videoRun + 1 : 1;
    lastVideo = item.videoId;
    playlistRun = pick === lastPlaylist ? playlistRun + 1 : 1;
    lastPlaylist = pick;
  }
  return [...out, ...seenTail(seen)];
}

// ---------------------------------------------------------------------------
// Series order
// ---------------------------------------------------------------------------

export interface SeriesVideo {
  id: string;
  /** Place in the YouTube playlist, 0 first. */
  position: number;
  title: string;
}

const KEYWORD_RE =
  /\b(?:part|pt|episode|ep|week|day|lesson|lecture|chapter|module|session|class|unit|step|level|stage|round|vol|volume)\.?\s*#?\s*(\d{1,4})\b/i;
const HASH_RE = /(?:^|[\s([])#(\d{1,4})\b/;
const OF_RE = /\b(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})\b/i;
const LEADING_RE = /^\s*(\d{1,3})\s*[.):\-–—]\s+\S/;

/**
 * The number a title gives its video within a series ("Week 10", "Part 4", "Ep. 3", "#12",
 * "3 of 10", "1. Setup"), or null.
 */
export function sequenceNumber(title: string): number | null {
  if (typeof title !== "string" || !title) return null;
  const kw = KEYWORD_RE.exec(title);
  if (kw) return Number(kw[1]);
  const hash = HASH_RE.exec(title);
  if (hash) return Number(hash[1]);
  const of = OF_RE.exec(title);
  if (of && Number(of[1]) >= 1 && Number(of[1]) <= Number(of[2]) && Number(of[2]) >= 2) return Number(of[1]);
  const lead = LEADING_RE.exec(title);
  if (lead) return Number(lead[1]);
  return null;
}

/**
 * Series order of a playlist's videos: video id -> place, 0 first. The playlist's own order,
 * reversed when its titles number the videos the other way round (many channels list a series
 * newest first: "Week 11" ... "Week 1"). Videos without a number keep their place relative to
 * the others, so an overview listed last in a newest-first playlist plays first.
 */
export function seriesOrder(videos: readonly SeriesVideo[]): Map<string, number> {
  const numbered = videos
    .map((v) => ({ v, n: sequenceNumber(v.title) }))
    .filter((x): x is { v: SeriesVideo; n: number } => x.n !== null);
  let reversed = false;
  // Only when more than half of the titles carry a number, and they run clearly backwards.
  if (numbered.length >= 2 && numbered.length * 2 > videos.length) {
    let concordant = 0;
    let discordant = 0;
    for (let i = 0; i < numbered.length; i++) {
      for (let j = i + 1; j < numbered.length; j++) {
        const d = Math.sign(numbered[j].v.position - numbered[i].v.position) * Math.sign(numbered[j].n - numbered[i].n);
        if (d > 0) concordant++;
        else if (d < 0) discordant++;
      }
    }
    reversed = concordant + discordant > 0 && (concordant - discordant) / (concordant + discordant) <= -0.5;
  }
  const ordered = videos
    .slice()
    .sort((a, b) => (reversed ? b.position - a.position : a.position - b.position) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(ordered.map((v, i) => [v.id, i]));
}
