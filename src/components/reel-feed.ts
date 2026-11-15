/**
 * Client-safe helpers for the reels feed: which caption is being spoken, how new pages join the
 * list, and what the feed remembers between visits. No React and no runtime imports, so they
 * are unit-tested without a browser.
 */

export interface TimedLine {
  /** Seconds into the video. */
  t: number;
  d: number;
  text: string;
}

/**
 * Index of the caption being spoken at `videoTime`: the last line that has started. -1 before
 * the first line. Lines are sorted by `t` (auto-captions overlap, so `d` is not used).
 */
export function activeLineIndex(lines: readonly TimedLine[], videoTime: number): number {
  if (!Number.isFinite(videoTime)) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= videoTime + 0.05) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Adds a freshly fetched page to the list already on screen: reels the viewer has in the list
 * keep their place (and their local saved/seen state); only new ids are appended, in page order.
 * Returns the same array when the page brought nothing new.
 */
export function mergeReels<T extends { id: string }>(current: readonly T[], page: readonly T[]): T[] {
  const known = new Set(current.map((r) => r.id));
  const added = page.filter((r) => !known.has(r.id));
  return added.length ? [...current, ...added] : (current as T[]);
}

/** Which slide a scroll position has settled on. */
export function slideIndexAt(scrollTop: number, slideHeight: number, count: number): number {
  if (!(slideHeight > 0) || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(scrollTop / slideHeight)));
}

// ---------- remembered between visits ----------

/** The speed key is the episode player's, so one choice covers both. */
const KEYS = { muted: "rc.reels.muted", autoNext: "rc.reels.autonext", speed: "rc.player.speed" } as const;
const SPEED_STEPS = [1, 1.25, 1.5, 2] as const;

export interface FeedPrefs {
  muted: boolean;
  /** When a reel ends: true plays the next one, false repeats it. */
  autoNext: boolean;
  speed: number;
}

export const DEFAULT_PREFS: FeedPrefs = Object.freeze({ muted: false, autoNext: true, speed: 1 });

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the stored choices; anything missing, malformed or blocked falls back to the default. */
export function readPrefs(storage: StorageLike | null | undefined): FeedPrefs {
  const out = { ...DEFAULT_PREFS };
  if (!storage) return out;
  try {
    const muted = storage.getItem(KEYS.muted);
    const autoNext = storage.getItem(KEYS.autoNext);
    const speed = Number(storage.getItem(KEYS.speed));
    if (muted === "1" || muted === "0") out.muted = muted === "1";
    if (autoNext === "1" || autoNext === "0") out.autoNext = autoNext === "1";
    if ((SPEED_STEPS as readonly number[]).includes(speed)) out.speed = speed;
  } catch {
    // storage blocked: defaults
  }
  return out;
}

export function writePref<K extends keyof FeedPrefs>(storage: StorageLike | null | undefined, key: K, value: FeedPrefs[K]): void {
  try {
    storage?.setItem(KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  } catch {
    // storage blocked: the choice just is not remembered
  }
}

/** The speed after `speed` in 1x, 1.25x, 1.5x, 2x, wrapping to 1x. */
export function nextSpeed(speed: number): number {
  const i = (SPEED_STEPS as readonly number[]).indexOf(speed);
  return SPEED_STEPS[(i + 1) % SPEED_STEPS.length];
}

// A tiny store over localStorage for useSyncExternalStore: the server and the first client
// render both see DEFAULT_PREFS (no hydration mismatch), then the stored choices apply.

const listeners = new Set<() => void>();
let snapshot: FeedPrefs = DEFAULT_PREFS;
let loaded = false;

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function same(a: FeedPrefs, b: FeedPrefs): boolean {
  return a.muted === b.muted && a.autoNext === b.autoNext && a.speed === b.speed;
}

function refresh(): void {
  const next = readPrefs(browserStorage());
  loaded = true;
  if (!same(next, snapshot)) snapshot = next;
}

export function subscribePrefs(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab changed a choice: read it again. (setPref below notifies without re-reading,
  // so a choice made with storage blocked is not thrown away.)
  const onStorage = () => {
    refresh();
    onChange();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Stable between changes, as useSyncExternalStore requires. */
export function getPrefsSnapshot(): FeedPrefs {
  if (!loaded) refresh();
  return snapshot;
}

export function getServerPrefsSnapshot(): FeedPrefs {
  return DEFAULT_PREFS;
}

export function setPref<K extends keyof FeedPrefs>(key: K, value: FeedPrefs[K]): void {
  writePref(browserStorage(), key, value);
  // Keep the choice for this visit even when storage is blocked.
  snapshot = { ...snapshot, [key]: value };
  loaded = true;
  listeners.forEach((l) => l());
}
