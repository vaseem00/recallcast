import { describe, expect, it } from "vitest";
import {
  MAX_PLAYLIST_RUN,
  MAX_VIDEO_RUN,
  freshness,
  playlistAffinity,
  playlistWeight,
  rankFeed,
  sequenceNumber,
  seriesOrder,
  type RankItem,
} from "./feed-rank";

const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;

/** Reels of one playlist: `videos` videos with `perVideo` reels each, ids "<p>-v<n>-<k>". */
function playlist(p: string, videos: number, perVideo: number, extra: Partial<RankItem> = {}): RankItem[] {
  const out: RankItem[] = [];
  for (let v = 0; v < videos; v++) {
    for (let k = 0; k < perVideo; k++) {
      out.push({
        id: `${p}-v${v}-${k}`,
        playlistId: p,
        playlistCreatedAt: NOW - DAY,
        videoId: `${p}-v${v}`,
        seriesIndex: v,
        start: 100 + k * 120,
        end: 160 + k * 120,
        basis: "transcript",
        savedAt: null,
        seenAt: null,
        watchS: 0,
        completions: 0,
        skips: 0,
        shared: false,
        ...extra,
      });
    }
  }
  return out;
}

const playlistOf = (id: string) => id.split("-")[0];
const videoOf = (id: string) => id.split("-").slice(0, 2).join("-");

function maxRun(ids: string[], key: (id: string) => string): number {
  let best = 0;
  let run = 0;
  ids.forEach((id, i) => {
    run = i > 0 && key(ids[i - 1]) === key(id) ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

describe("rankFeed: mix", () => {
  it("weaves every playlist into the top of the feed", () => {
    const items = [...playlist("A", 6, 2), ...playlist("B", 4, 1), ...playlist("C", 3, 2)];
    const order = rankFeed(items, { now: NOW, mode: "mix" });
    expect(order).toHaveLength(items.length);
    expect(new Set(order).size).toBe(items.length);
    expect(new Set(order.slice(0, 3).map(playlistOf))).toEqual(new Set(["A", "B", "C"]));
  });

  it("plays each playlist as a series: videos in series order, each video's reels in time order", () => {
    const items = [...playlist("A", 3, 2), ...playlist("B", 3, 2)];
    // Series order is not the id order: video 2 comes first.
    for (const r of items) if (r.playlistId === "A") r.seriesIndex = (Number(r.videoId.slice(3)) + 1) % 3;
    const order = rankFeed(items, { now: NOW, mode: "mix" });
    expect(order.filter((id) => playlistOf(id) === "A")).toEqual(["A-v2-0", "A-v2-1", "A-v0-0", "A-v0-1", "A-v1-0", "A-v1-1"]);
    expect(order.filter((id) => playlistOf(id) === "B")).toEqual(["B-v0-0", "B-v0-1", "B-v1-0", "B-v1-1", "B-v2-0", "B-v2-1"]);
  });

  it("keeps variety: at most two reels of a video and three of a playlist in a row while others are left", () => {
    const items = [...playlist("A", 5, 4), ...playlist("B", 2, 1, { basis: "position" })];
    const order = rankFeed(items, { now: NOW, mode: "mix" });
    const bLast = Math.max(...order.map((id, i) => (playlistOf(id) === "B" ? i : -1)));
    const head = order.slice(0, bLast + 1);
    expect(maxRun(head, videoOf)).toBeLessThanOrEqual(MAX_VIDEO_RUN);
    expect(maxRun(head, playlistOf)).toBeLessThanOrEqual(MAX_PLAYLIST_RUN);
  });

  it("gives reels cut from what is said more room than reels cut without captions", () => {
    const items = [...playlist("T", 10, 1), ...playlist("P", 10, 1, { basis: "position" })];
    const top = rankFeed(items, { now: NOW, mode: "mix" }).slice(0, 10);
    const t = top.filter((id) => playlistOf(id) === "T").length;
    expect(t).toBeGreaterThan(5);
    expect(t).toBeLessThan(10); // but the other playlist is there too
    expect(top[0].startsWith("T-")).toBe(true);
  });

  it("follows the viewer: a playlist they finish and save rises, one they swipe away sinks", () => {
    const items = [...playlist("A", 8, 1), ...playlist("B", 8, 1)];
    const neutral = rankFeed(items, { now: NOW, mode: "mix" }).slice(0, 8);
    expect(neutral.filter((id) => playlistOf(id) === "A")).toHaveLength(4);

    // Watched: A's first two finished and one saved; B's first two swiped away.
    for (const r of items) {
      if (r.id === "A-v0-0" || r.id === "A-v1-0") Object.assign(r, { seenAt: NOW - 60_000, watchS: 60, completions: 1 });
      if (r.id === "A-v0-0") r.savedAt = NOW - 50_000;
      if (r.id === "B-v0-0" || r.id === "B-v1-0") Object.assign(r, { seenAt: NOW - 60_000, watchS: 1, skips: 1 });
    }
    const order = rankFeed(items, { now: NOW, mode: "mix" });
    const unseenTop = order.slice(0, 8);
    expect(unseenTop.filter((id) => playlistOf(id) === "A").length).toBeGreaterThan(4);
    expect(unseenTop.some((id) => playlistOf(id) === "B")).toBe(true); // still in the feed
    // Seen ones last; the swiped-away ones after the finished ones.
    expect(order.slice(-4)).toEqual(["A-v0-0", "A-v1-0", "B-v0-0", "B-v1-0"]);
  });

  it("moves a video the viewer turned down to the end of its playlist", () => {
    const items = playlist("A", 3, 2);
    Object.assign(items[0], { seenAt: NOW - 1000, skips: 1 }); // A-v0-0 swiped away early
    const order = rankFeed(items, { now: NOW, mode: "mix" });
    expect(order).toEqual(["A-v1-0", "A-v1-1", "A-v2-0", "A-v2-1", "A-v0-1", "A-v0-0"]);
  });

  it("puts seen reels last, the one seen longest ago first, so a finished feed starts over", () => {
    const items = playlist("A", 2, 2);
    items[1].seenAt = NOW - 5000;
    items[0].seenAt = NOW - 1000;
    const order = rankFeed(items, { now: NOW, mode: "mix" });
    expect(order).toEqual(["A-v1-0", "A-v1-1", "A-v0-1", "A-v0-0"]);
  });

  it("is deterministic and boosts new playlists", () => {
    const old = playlist("O", 6, 1, { playlistCreatedAt: NOW - 30 * DAY });
    const fresh = playlist("N", 6, 1, { playlistCreatedAt: NOW - 1000 });
    const a = rankFeed([...old, ...fresh], { now: NOW, mode: "mix" });
    const b = rankFeed([...fresh, ...old].reverse(), { now: NOW, mode: "mix" });
    expect(a).toEqual(b);
    expect(a[0].startsWith("N-")).toBe(true);
    expect(a.slice(0, 6).filter((id) => playlistOf(id) === "N").length).toBeGreaterThan(3);
  });

  it("handles an empty feed", () => {
    expect(rankFeed([], { now: NOW, mode: "mix" })).toEqual([]);
  });
});

describe("rankFeed: series", () => {
  it("is the series order alone, unseen first", () => {
    const items = playlist("A", 3, 2);
    items[2].seenAt = NOW - 10;
    expect(rankFeed(items, { now: NOW, mode: "series" })).toEqual(["A-v0-0", "A-v0-1", "A-v1-1", "A-v2-0", "A-v2-1", "A-v1-0"]);
  });
});

describe("signals", () => {
  it("affinity is 0 before any viewing and stays within -1..1", () => {
    const items = playlist("A", 3, 1);
    expect(playlistAffinity(items)).toBe(0);
    for (const r of items) Object.assign(r, { seenAt: NOW, completions: 9, savedAt: NOW, shared: true, watchS: 999 });
    expect(playlistAffinity(items)).toBeLessThanOrEqual(1);
    for (const r of items) Object.assign(r, { completions: 0, savedAt: null, shared: false, watchS: 0, skips: 9 });
    expect(playlistAffinity(items)).toBeGreaterThanOrEqual(-1);
    expect(playlistWeight(items, NOW)).toBeGreaterThan(0); // never out of the feed
  });

  it("freshness halves every three days", () => {
    expect(freshness(NOW, NOW)).toBe(1);
    expect(freshness(NOW - 3 * DAY, NOW)).toBeCloseTo(0.5);
    expect(freshness(NOW + DAY, NOW)).toBe(1); // a clock skew is not "newer than new"
  });
});

describe("sequenceNumber", () => {
  it("reads the number a title gives its video in a series", () => {
    expect(sequenceNumber("FTC DECODE: Your Week 10 Plan For Success")).toBe(10);
    expect(sequenceNumber("EEVblog 1779 - Amazing LCD Physics! (µTimer Part 4)")).toBe(4);
    expect(sequenceNumber("Lesson 3: Loops")).toBe(3);
    expect(sequenceNumber("Ep. 12 - The finale")).toBe(12);
    expect(sequenceNumber("Podcast #45 with a guest")).toBe(45);
    expect(sequenceNumber("Wiring the board (2 of 5)")).toBe(2);
    expect(sequenceNumber("1. Setting up")).toBe(1);
  });

  it("does not take any number for one", () => {
    expect(sequenceNumber("A 12 Week FTC Season Plan That Actually Works")).toBeNull();
    expect(sequenceNumber("How to Win Your Next FTC Competition")).toBeNull();
    expect(sequenceNumber("Buzz Huddle Test: 4 Humans, 2 AI Agents")).toBeNull();
    expect(sequenceNumber("I Gave My 10 AI Agents One Brain")).toBeNull();
    expect(sequenceNumber("Open 24/7 diner tour")).toBeNull();
    expect(sequenceNumber("2024: the year in review")).toBeNull();
    expect(sequenceNumber("")).toBeNull();
  });
});

describe("seriesOrder", () => {
  it("plays a newest-first series from its first part, with the unnumbered overview first", () => {
    const titles = [
      "How to Win Your Next FTC Competition",
      "FTC DECODE: Your Week 3 Plan For Success",
      "FTC DECODE: Your Week 2 Plan For Success",
      "FTC DECODE: What To Do In Week 1",
      "A 12 Week FTC Season Plan That Actually Works",
    ];
    const order = seriesOrder(titles.map((title, position) => ({ id: `v${position}`, position, title })));
    expect([...order.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual(["v4", "v3", "v2", "v1", "v0"]);
  });

  it("keeps the playlist's own order when it already runs forward, or has no numbers", () => {
    const forward = seriesOrder(["Part 1", "Part 2", "Part 3"].map((title, position) => ({ id: `f${position}`, position, title })));
    expect(forward.get("f0")).toBe(0);
    expect(forward.get("f2")).toBe(2);
    const plain = seriesOrder(["Cats", "Dogs", "Birds"].map((title, position) => ({ id: `p${position}`, position, title })));
    expect([plain.get("p0"), plain.get("p1"), plain.get("p2")]).toEqual([0, 1, 2]);
  });

  it("needs most of the playlist numbered before it reverses anything", () => {
    const mostlyPlain = ["Cats", "Dogs", "Birds", "Part 2", "Part 1"].map((title, position) => ({ id: `m${position}`, position, title }));
    expect(seriesOrder(mostlyPlain).get("m0")).toBe(0);
  });
});
