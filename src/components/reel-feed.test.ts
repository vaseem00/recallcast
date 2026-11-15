import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, activeLineIndex, mergeReels, nextSpeed, readPrefs, slideIndexAt, writePref, type StorageLike } from "./reel-feed";
import { isTransientYouTubeError } from "./youtube-player";

describe("isTransientYouTubeError", () => {
  it("is true for the player failing to start, false for errors about the video itself", () => {
    expect([5, 3, 999].every(isTransientYouTubeError)).toBe(true);
    expect([2, 100, 101, 150, 153].some(isTransientYouTubeError)).toBe(false);
  });
});

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("activeLineIndex", () => {
  const lines = [
    { t: 10, d: 4, text: "one" },
    { t: 14, d: 6, text: "two" },
    { t: 18, d: 3, text: "three" }, // auto-captions overlap: line two is still on screen
  ];

  it("is the last line that has started", () => {
    expect(activeLineIndex(lines, 9)).toBe(-1);
    expect(activeLineIndex(lines, 10)).toBe(0);
    expect(activeLineIndex(lines, 13.9)).toBe(0);
    expect(activeLineIndex(lines, 14)).toBe(1);
    expect(activeLineIndex(lines, 19)).toBe(2);
    expect(activeLineIndex(lines, 500)).toBe(2);
  });

  it("handles no lines and a time that is not a number", () => {
    expect(activeLineIndex([], 5)).toBe(-1);
    expect(activeLineIndex(lines, Number.NaN)).toBe(-1);
  });
});

describe("mergeReels", () => {
  it("appends only new ids, keeps what is on screen in place and unchanged", () => {
    const current = [
      { id: "a", saved: true },
      { id: "b", saved: false },
    ];
    const page = [
      { id: "b", saved: true },
      { id: "c", saved: false },
      { id: "a", saved: false },
      { id: "d", saved: false },
    ];
    const merged = mergeReels(current, page);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(merged[0]).toBe(current[0]);
    expect(merged[1].saved).toBe(false);
  });

  it("returns the same array when the page adds nothing", () => {
    const current = [{ id: "a" }, { id: "b" }];
    expect(mergeReels(current, [{ id: "b" }, { id: "a" }])).toBe(current);
    expect(mergeReels(current, [])).toBe(current);
  });
});

describe("slideIndexAt", () => {
  it("rounds to the nearest slide and stays inside the feed", () => {
    expect(slideIndexAt(0, 700, 5)).toBe(0);
    expect(slideIndexAt(349, 700, 5)).toBe(0);
    expect(slideIndexAt(351, 700, 5)).toBe(1);
    expect(slideIndexAt(2100, 700, 5)).toBe(3);
    expect(slideIndexAt(99999, 700, 5)).toBe(4);
    expect(slideIndexAt(-50, 700, 5)).toBe(0);
    expect(slideIndexAt(700, 0, 5)).toBe(0);
    expect(slideIndexAt(700, 700, 0)).toBe(0);
  });
});

describe("feed preferences", () => {
  it("defaults to sound on, auto next, 1x", () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(readPrefs(memoryStorage())).toEqual({ muted: false, autoNext: true, speed: 1 });
  });

  it("round-trips each choice and shares the speed with the episode player", () => {
    const s = memoryStorage();
    writePref(s, "muted", true);
    writePref(s, "autoNext", false);
    writePref(s, "speed", 1.5);
    expect(s.data).toEqual({ "rc.reels.muted": "1", "rc.reels.autonext": "0", "rc.player.speed": "1.5" });
    expect(readPrefs(s)).toEqual({ muted: true, autoNext: false, speed: 1.5 });
  });

  it("ignores malformed values and a storage that throws", () => {
    expect(readPrefs(memoryStorage({ "rc.reels.muted": "yes", "rc.reels.autonext": "", "rc.player.speed": "9" }))).toEqual(DEFAULT_PREFS);
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(() => writePref(broken, "muted", true)).not.toThrow();
  });

  it("cycles the speed 1x, 1.25x, 1.5x, 2x and back", () => {
    expect([1, 1.25, 1.5, 2, 7].map(nextSpeed)).toEqual([1.25, 1.5, 2, 1, 1]);
  });
});
