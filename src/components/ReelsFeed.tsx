"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReelFeed, ReelView } from "@/lib/reels";
import { api } from "./api";
import { formatClock, isTypingTarget, speedLabel, youtubeAt } from "./format";
import {
  activeLineIndex,
  getPrefsSnapshot,
  getServerPrefsSnapshot,
  mergeReels,
  nextSpeed,
  setPref,
  slideIndexAt,
  subscribePrefs,
} from "./reel-feed";
import { usePolling } from "./usePolling";
import { isTransientYouTubeError, loadYouTubeApi, YT_STATE, youtubeErrorMessage, type YTPlayer } from "./youtube-player";
import styles from "@/styles/reels.module.css";

type Phase = "loading" | "playing" | "paused" | "blocked" | "error";

export interface ReelsFeedProps {
  initial: ReelFeed;
  /** owner: the signed-in user's feed (save, share, seen). public: a shared link, read-only. */
  mode: "owner" | "public";
  /** owner only: which slice of the feed this page shows. */
  playlistId?: string | null;
  saved?: boolean;
  /** public only: what the link shows, for the strip above the feed. */
  title?: string;
  /** public only: where "Make your own" goes. */
  signedIn?: boolean;
}

const SEEK_S = 5;
/** A reel counts as seen once this much of it has played (or it was swiped past). */
const SEEN_AFTER_S = 3;
/**
 * How long after a load a player that is still unstarted (not buffering) is taken to mean "the
 * browser blocked autoplay". The API's own onAutoplayBlocked event usually says so sooner; this
 * is the backstop, and long enough that a slow connection is not mistaken for a block.
 */
const BLOCKED_AFTER_MS = 4000;
/**
 * How long after a load a player that is still unstarted, although the browser did not report
 * blocking autoplay, is taken to be stuck and replaced with a new one. A player that is still
 * not playing at this point (and was replaced once already, or is waiting in some other state)
 * is handed to the viewer: the label asks for a tap instead of saying "Loading" forever.
 */
const STALLED_AFTER_MS = 9000;
/** Leaving a reel with less than this much of it played counts as swiping it away. */
const SKIP_UNDER_S = 3;
/** ...if it was on screen at least this long (scrolling past it on the way elsewhere is not a skip). */
const SKIP_DWELL_MS = 1200;

const PHASE_LABEL: Record<Phase, string> = {
  loading: "Loading",
  playing: "On air",
  paused: "Paused",
  blocked: "Tap the video to start",
  error: "Can't play here",
};

/** In place of captions, for reels cut without them. */
const BASIS_NOTE: Record<Exclude<ReelView["basis"], "transcript">, string> = {
  chapters: "No captions yet, so this reel starts at one of the creator's chapter marks. Once captions are found it is cut from what is said.",
  position: "No captions yet, so this minute was picked by its place in the video, not by what is said. Once captions are found it is cut from what is said.",
};

/** One viewing of the reel on air, reported when the viewer leaves it (feeds the ranking). */
interface Watch {
  id: string;
  /** Seconds of the reel played (at the playback speed) since the last report. */
  played: number;
  started: boolean;
  completed: boolean;
  failed: boolean;
  /** A skip was already reported for this viewing. */
  skipSent: boolean;
  since: number;
}

/**
 * The reels feed: one reel per screen, swiped or keyed through like a short-video feed.
 *
 * Every reel is a window of a YouTube video played by YouTube's own embedded player. There is
 * one player for the whole feed. It stays pinned at the top of the scroller, always fully
 * visible, with nothing in front of it: the hook, the captions and every control sit beside or
 * below it (YouTube's embed rules: no overlays, one player playing, the player in view). What
 * scrolls is the page of each reel under the pinned video; when a new page settles, the same
 * player loads that reel's window, so a tap on the first video is enough for the browser to let
 * the following ones start with sound.
 */
export default function ReelsFeed({ initial, mode, playlistId = null, saved = false, title, signedIn = false }: ReelsFeedProps) {
  const owner = mode === "owner";
  const [reels, setReels] = useState<ReelView[]>(initial.reels);
  const [meta, setMeta] = useState({ total: initial.total, pending: initial.pending, videos: initial.videos, noCaptions: initial.noCaptions });
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [ready, setReady] = useState(false);
  /** Bumped to throw the YouTube player away and build a new one (see rebuild). */
  const [playerEpoch, setPlayerEpoch] = useState(0);
  /** The browser refused sound without a tap, so this visit started muted. */
  const [forcedMute, setForcedMute] = useState(false);
  const [flash, setFlash] = useState<{ text: string; key: number } | null>(null);
  const prefs = useSyncExternalStore(subscribePrefs, getPrefsSnapshot, getServerPrefsSnapshot);
  const muted = prefs.muted || forcedMute;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ytRef = useRef<YTPlayer | null>(null);
  const reelsRef = useRef(reels);
  const activeRef = useRef(active);
  const posRef = useRef(pos);
  const mutedRef = useRef(muted);
  const speedRef = useRef(prefs.speed);
  const autoNextRef = useRef(prefs.autoNext);
  const loadedRef = useRef<string | null>(null);
  const endedRef = useRef<string | null>(null);
  /** The reel for which a stuck or failed player was already replaced once (see rebuild). */
  const retriedRef = useRef<string | null>(null);
  /** The IFrame API itself reported that the browser blocked autoplay for this player. */
  const apiBlockedRef = useRef(false);
  const stallTimer = useRef<number | undefined>(undefined);
  const phaseRef = useRef<Phase>(phase);
  const seenSent = useRef(new Set<string>());
  const watchRef = useRef<Watch | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);
  const blockedTimer = useRef<number | undefined>(undefined);
  const exhausted = useRef(false);
  const loadingMore = useRef(false);

  const reel: ReelView | null = reels[active] ?? null;
  const atEnd = reels.length > 0 && active >= reels.length;
  const length = reel ? Math.max(1, reel.end - reel.start) : 0;
  const count = owner ? Math.max(meta.total, reels.length) : reels.length;

  useEffect(() => {
    reelsRef.current = reels;
    activeRef.current = active;
    posRef.current = pos;
    mutedRef.current = muted;
    speedRef.current = prefs.speed;
    autoNextRef.current = prefs.autoNext;
    phaseRef.current = phase;
  });

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 4200);
    return () => window.clearTimeout(id);
  }, [flash]);

  const say = useCallback((text: string) => setFlash({ text, key: Date.now() }), []);

  // ---------------------------------------------------------------- feed data

  const feedUrl = `/api/reels${playlistId ? `?playlist=${encodeURIComponent(playlistId)}` : saved ? "?saved=1" : ""}`;

  const fetchMore = useCallback(
    async (signal?: AbortSignal) => {
      const res = await api<ReelFeed>(feedUrl, { signal });
      if (signal?.aborted || !res.ok || !Array.isArray(res.data?.reels)) return false;
      const page = res.data;
      const before = reelsRef.current.length;
      const merged = mergeReels(reelsRef.current, page.reels);
      if (merged.length !== before) {
        reelsRef.current = merged;
        setReels(merged);
      }
      setMeta({ total: page.total, pending: page.pending, videos: page.videos, noCaptions: page.noCaptions });
      return merged.length !== before;
    },
    [feedUrl],
  );

  // While videos are still being cut, new reels keep arriving: poll and append them.
  usePolling(owner && !saved && meta.pending > 0, 4000, async (signal) => {
    if (await fetchMore(signal)) exhausted.current = false;
  });

  // Near the end of what is loaded: ask for the next page (the server sends unseen reels first).
  useEffect(() => {
    if (!owner || saved || loadingMore.current || exhausted.current) return;
    if (reels.length === 0 || reels.length >= meta.total || active < reels.length - 2) return;
    loadingMore.current = true;
    void fetchMore().then((added) => {
      loadingMore.current = false;
      if (!added) exhausted.current = true;
    });
  }, [owner, saved, active, reels.length, meta.total, fetchMore]);

  const markSeen = useCallback(
    (r: ReelView | null | undefined) => {
      if (!owner || !r || seenSent.current.has(r.id)) return;
      seenSent.current.add(r.id);
      void api(`/api/reels/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { seen: true } });
    },
    [owner],
  );

  /**
   * Sends what happened to the reel on air since the last report: seconds played, played to the
   * end, or (only when the viewer moved on: `leaving`) swiped away within its first seconds after
   * it started playing. The owner's ranking reads these; nothing is sent on public pages.
   */
  const reportWatch = useCallback(
    (leaving: boolean) => {
      const w = watchRef.current;
      if (!owner || !w) return;
      const body: { watched?: number; completed?: true; skipped?: true } = {};
      const played = Math.round(Math.min(600, w.played) * 10) / 10;
      if (played >= 1) body.watched = played;
      if (w.completed) body.completed = true;
      else if (leaving && w.started && !w.failed && !w.skipSent && w.played < SKIP_UNDER_S && performance.now() - w.since >= SKIP_DWELL_MS) {
        body.skipped = true;
        w.skipSent = true;
      }
      w.played = 0;
      w.completed = false;
      if (body.watched === undefined && !body.completed && !body.skipped) return;
      void api(`/api/reels/${encodeURIComponent(w.id)}`, { method: "PATCH", body, keepalive: true });
    },
    [owner],
  );

  // A new reel on air starts a new viewing; leaving it (or the page) reports the old one.
  const activeId = reels[active]?.id ?? null;
  useEffect(() => {
    if (!activeId) return;
    watchRef.current = { id: activeId, played: 0, started: false, completed: false, failed: false, skipSent: false, since: performance.now() };
    return () => reportWatch(true);
  }, [activeId, reportWatch]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") reportWatch(false);
    };
    const onPageHide = () => reportWatch(false);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [reportWatch]);

  // ---------------------------------------------------------------- moving through the feed

  const goTo = useCallback((index: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const i = Math.max(0, Math.min(reelsRef.current.length, index));
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: i * el.clientHeight, behavior: reduce ? "auto" : "smooth" });
  }, []);

  const onScroll = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const el = scrollerRef.current;
      if (!el) return;
      // One more slide than there are reels: the last one is the end of the feed.
      const next = slideIndexAt(el.scrollTop, el.clientHeight, reelsRef.current.length + 1);
      if (next !== activeRef.current) {
        markSeen(reelsRef.current[activeRef.current]);
        setActive(next);
      }
    }, 110);
  }, [markSeen]);

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  // ---------------------------------------------------------------- the one YouTube player

  const finish = useCallback(() => {
    const r = reelsRef.current[activeRef.current];
    if (!r || endedRef.current === r.id) return;
    endedRef.current = r.id;
    markSeen(r);
    if (watchRef.current?.id === r.id) watchRef.current.completed = true;
    if (autoNextRef.current) {
      try {
        ytRef.current?.pauseVideo();
      } catch {
        // ignore
      }
      goTo(activeRef.current + 1);
      return;
    }
    // Repeat: back to the start of the window.
    endedRef.current = null;
    try {
      ytRef.current?.seekTo(r.start, true);
      ytRef.current?.playVideo();
    } catch {
      // ignore
    }
    setPos(0);
  }, [goTo, markSeen]);
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  /** Browsers always allow silent autoplay: start muted and offer the sound. */
  const onBlocked = useCallback(() => {
    const yt = ytRef.current;
    if (!yt) return;
    if (!mutedRef.current) {
      mutedRef.current = true;
      setForcedMute(true);
      try {
        yt.mute();
        yt.playVideo();
      } catch {
        // ignore
      }
      return;
    }
    setPhase((p) => (p === "playing" ? p : "blocked"));
  }, []);
  const onBlockedRef = useRef(onBlocked);
  useEffect(() => {
    onBlockedRef.current = onBlocked;
  }, [onBlocked]);

  /**
   * Throws the player away and builds a new one for the current reel. YouTube's player now and
   * then never starts a video on a page load (it stays "unstarted", then reports error 5 some
   * 20 s later; a bare embed does the same), and loading the video again into that player does
   * not help, while a new player does. Automatic use is once per reel; `force` is the Play button.
   */
  const rebuild = useCallback((force = false): boolean => {
    const r = reelsRef.current[activeRef.current];
    if (!r || (!force && retriedRef.current === r.id)) return false;
    retriedRef.current = r.id;
    endedRef.current = null;
    setReady(false);
    setPhase("loading");
    setErrorText(null);
    setPos(0);
    setPlayerEpoch((n) => n + 1);
    return true;
  }, []);
  const rebuildRef = useRef(rebuild);
  useEffect(() => {
    rebuildRef.current = rebuild;
  }, [rebuild]);

  const watchForBlock = useCallback(() => {
    window.clearTimeout(blockedTimer.current);
    window.clearTimeout(stallTimer.current);
    const stateNow = (): number | null => {
      try {
        return ytRef.current?.getPlayerState() ?? null;
      } catch {
        return null;
      }
    };
    blockedTimer.current = window.setTimeout(() => {
      const state = stateNow();
      if (state === YT_STATE.UNSTARTED || state === YT_STATE.CUED) onBlockedRef.current();
    }, BLOCKED_AFTER_MS);
    stallTimer.current = window.setTimeout(() => {
      const state = stateNow();
      if (state === YT_STATE.PLAYING) return;
      // Still unstarted well after the silent start was tried, and the browser never said it
      // blocked autoplay: the player is stuck. Build a new one (once per reel).
      if (state === YT_STATE.UNSTARTED && !apiBlockedRef.current && rebuildRef.current()) return;
      // Whatever it is waiting for (a tap the browser wants, a buffer that never fills), say so
      // instead of "Loading" forever: a tap on the video or on Play starts it.
      setPhase((p) => (p === "loading" ? "blocked" : p));
    }, STALLED_AFTER_MS);
  }, []);

  const hasReels = reels.length > 0;

  // Create the player once there is a reel to play (and again after rebuild()).
  useEffect(() => {
    if (!hasReels) return;
    let cancelled = false;
    apiBlockedRef.current = false;
    const first = reelsRef.current[Math.min(activeRef.current, reelsRef.current.length - 1)];
    if (!first) return;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        const el = document.createElement("div");
        hostRef.current.replaceChildren(el);
        loadedRef.current = first.id;
        ytRef.current = new YT.Player(el, {
          host: "https://www.youtube-nocookie.com",
          videoId: first.youtubeVideoId,
          width: "100%",
          height: "100%",
          playerVars: {
            start: first.start,
            end: first.end,
            autoplay: 1,
            playsinline: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            rel: 0,
            iv_load_policy: 3,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              setReady(true);
              try {
                if (mutedRef.current) e.target.mute();
                e.target.setPlaybackRate(speedRef.current);
                e.target.playVideo();
              } catch {
                // ignore
              }
              watchForBlock();
            },
            onStateChange: (e) => {
              if (cancelled) return;
              if (e.data === YT_STATE.PLAYING) {
                window.clearTimeout(blockedTimer.current);
                window.clearTimeout(stallTimer.current);
                const w = watchRef.current;
                if (w && w.id === loadedRef.current) w.started = true;
                setPhase("playing");
                setErrorText(null);
                try {
                  e.target.setPlaybackRate(speedRef.current);
                } catch {
                  // ignore
                }
              } else if (e.data === YT_STATE.PAUSED) {
                setPhase((p) => (p === "error" ? p : "paused"));
              } else if (e.data === YT_STATE.ENDED) {
                finishRef.current();
              }
            },
            onAutoplayBlocked: () => {
              if (cancelled) return;
              apiBlockedRef.current = true;
              onBlockedRef.current();
            },
            onError: (e) => {
              if (cancelled) return;
              window.clearTimeout(blockedTimer.current);
              window.clearTimeout(stallTimer.current);
              // The player failing (not the video being off limits): one new player per reel
              // before the error is shown.
              if (isTransientYouTubeError(e.data) && rebuildRef.current()) return;
              if (watchRef.current) watchRef.current.failed = true; // moving on is not a skip
              setPhase("error");
              setErrorText(youtubeErrorMessage(e.data));
            },
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase("error");
        setErrorText(err instanceof Error ? err.message : "The YouTube player could not be loaded.");
      });
    return () => {
      cancelled = true;
      window.clearTimeout(blockedTimer.current);
      window.clearTimeout(stallTimer.current);
      try {
        ytRef.current?.destroy();
      } catch {
        // ignore
      }
      ytRef.current = null;
      loadedRef.current = null;
    };
  }, [hasReels, watchForBlock, playerEpoch]);

  // A new reel settled under the player: load its window into the same player. On the end
  // slide nothing plays.
  useEffect(() => {
    const yt = ytRef.current;
    if (!ready || !yt) return;
    if (!reel) {
      try {
        yt.pauseVideo();
      } catch {
        // ignore
      }
      return;
    }
    if (loadedRef.current === reel.id) return;
    loadedRef.current = reel.id;
    endedRef.current = null;
    setPhase("loading");
    setErrorText(null);
    setPos(0);
    try {
      yt.loadVideoById({ videoId: reel.youtubeVideoId, startSeconds: reel.start, endSeconds: reel.end });
    } catch (err) {
      console.warn("[reels] loadVideoById failed", err);
    }
    watchForBlock();
  }, [ready, reel, watchForBlock]);

  // Clock: YouTube has no time events, so poll. Also the backstop for the end of the window,
  // in case the player pauses at endSeconds instead of reporting ENDED.
  useEffect(() => {
    if (!ready) return;
    let lastTick = performance.now();
    const id = window.setInterval(() => {
      const tick = performance.now();
      const dt = (tick - lastTick) / 1000;
      lastTick = tick;
      const yt = ytRef.current;
      const r = reelsRef.current[activeRef.current];
      if (!yt || !r || loadedRef.current !== r.id) return;
      let now = 0;
      let state: number = YT_STATE.UNSTARTED;
      try {
        now = yt.getCurrentTime();
        state = yt.getPlayerState();
      } catch {
        return;
      }
      if (!Number.isFinite(now) || now < r.start - 2) return; // still loading the new video
      // Seconds of the reel played, for the viewing report (a throttled tab's long gap is not).
      const w = watchRef.current;
      if (state === YT_STATE.PLAYING && w && w.id === r.id && dt > 0 && dt < 1.5) {
        w.started = true;
        w.played += dt * speedRef.current;
      }
      const p = Math.max(0, Math.min(r.end - r.start, now - r.start));
      setPos((old) => (Math.abs(old - p) >= 0.15 ? p : old));
      if (p >= SEEN_AFTER_S && state === YT_STATE.PLAYING) markSeen(r);
      if (now >= r.end - 0.25 && endedRef.current !== r.id && (state === YT_STATE.PLAYING || state === YT_STATE.PAUSED || state === YT_STATE.ENDED)) {
        finishRef.current();
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [ready, markSeen]);

  useEffect(() => {
    try {
      ytRef.current?.setPlaybackRate(prefs.speed);
    } catch {
      // player not ready
    }
  }, [prefs.speed]);

  // ---------------------------------------------------------------- controls

  const toggle = useCallback(() => {
    const yt = ytRef.current;
    const r = reelsRef.current[activeRef.current];
    if (!yt || !r) return;
    // After a player error, Play means "try this reel again", with a new player.
    if (phaseRef.current === "error") {
      rebuildRef.current(true);
      return;
    }
    try {
      if (yt.getPlayerState() === YT_STATE.PLAYING) {
        yt.pauseVideo();
      } else {
        if (endedRef.current === r.id) {
          endedRef.current = null;
          yt.seekTo(r.start, true);
        }
        yt.playVideo();
      }
    } catch {
      // ignore
    }
  }, []);

  const seekTo = useCallback((p: number) => {
    const yt = ytRef.current;
    const r = reelsRef.current[activeRef.current];
    if (!yt || !r) return;
    const next = Math.max(0, Math.min(r.end - r.start - 0.5, p));
    endedRef.current = null;
    try {
      yt.seekTo(r.start + next, true);
    } catch {
      return;
    }
    setPos(next);
  }, []);

  const toggleSound = useCallback(() => {
    const yt = ytRef.current;
    const next = !mutedRef.current;
    try {
      if (next) {
        yt?.mute();
      } else {
        yt?.unMute();
        yt?.setVolume(100);
        yt?.playVideo();
      }
    } catch {
      // ignore
    }
    mutedRef.current = next;
    setForcedMute(false);
    setPref("muted", next);
  }, []);

  const toggleSaved = useCallback(
    async (r: ReelView) => {
      const want = !r.saved;
      const patch = (value: boolean) => setReels((list) => list.map((x) => (x.id === r.id ? { ...x, saved: value } : x)));
      patch(want);
      const res = await api(`/api/reels/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { saved: want } });
      if (!res.ok) {
        patch(!want);
        say(res.error);
      }
    },
    [say],
  );

  const offerLink = useCallback(
    async (url: string, hook: string) => {
      // The phone's share sheet where there is one; otherwise the clipboard.
      if (typeof navigator.share === "function" && window.matchMedia?.("(pointer: coarse)").matches) {
        try {
          await navigator.share({ title: hook, url });
          return;
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") return;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        say("Link copied. The page is public: anyone can watch it without an account, and search engines may list it.");
      } catch {
        say(`Copy this link: ${url}`);
      }
    },
    [say],
  );

  const share = useCallback(
    async (r: ReelView) => {
      if (!owner) {
        await offerLink(window.location.href, r.hook);
        return;
      }
      const res = await api<{ slug: string; path: string }>(`/api/reels/${encodeURIComponent(r.id)}/share`, { method: "POST", body: {} });
      if (!res.ok || !res.data?.slug) {
        say(res.ok ? "The link could not be made. Try again." : res.error);
        return;
      }
      const { slug, path } = res.data;
      setReels((list) => list.map((x) => (x.id === r.id ? { ...x, shareSlug: slug } : x)));
      await offerLink(new URL(path, window.location.origin).toString(), r.hook);
    },
    [owner, offerLink, say],
  );

  const unshare = useCallback(
    async (r: ReelView) => {
      const res = await api(`/api/reels/${encodeURIComponent(r.id)}/share`, { method: "DELETE" });
      if (!res.ok) {
        say(res.error);
        return;
      }
      setReels((list) => list.map((x) => (x.id === r.id ? { ...x, shareSlug: null } : x)));
      say("The link no longer works.");
    },
    [say],
  );

  // ---------------------------------------------------------------- keyboard

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const r = reelsRef.current[activeRef.current];
      if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") {
        e.preventDefault();
        goTo(activeRef.current + 1);
      } else if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") {
        e.preventDefault();
        goTo(activeRef.current - 1);
      } else if (e.code === "Space" || e.key === " ") {
        if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return;
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(posRef.current - SEEK_S);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(posRef.current + SEEK_S);
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleSound();
      } else if ((e.key === "s" || e.key === "S") && owner && r) {
        e.preventDefault();
        void toggleSaved(r);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, toggle, seekTo, toggleSound, toggleSaved, owner]);

  // ---------------------------------------------------------------- render

  const strip = (
    <div className={styles.strip}>
      {owner ? (
        <nav aria-label="Feed" className={styles.stripLinks}>
          <Link className={styles.stripLink} href="/app/reels" aria-current={!saved && !playlistId ? "page" : undefined}>
            All
          </Link>
          <Link className={styles.stripLink} href="/app/reels?saved=1" aria-current={saved ? "page" : undefined}>
            Saved
          </Link>
          {playlistId ? (
            <span className={styles.stripLink} aria-current="page">
              {reels[0]?.playlistTitle || "One playlist"}
            </span>
          ) : null}
        </nav>
      ) : (
        <p className={styles.stripTitle}>{title || "Reels"}</p>
      )}
      {owner && meta.pending > 0 ? (
        <p className="chip" data-tone="work" role="status">
          Cutting {meta.pending} more {meta.pending === 1 ? "video" : "videos"}
        </p>
      ) : null}
      {!owner ? (
        <Link className={styles.stripCta} href={signedIn ? "/app" : "/signup"}>
          {signedIn ? "Your library" : "Make your own"}
        </Link>
      ) : null}
    </div>
  );

  if (!hasReels) {
    return (
      <section className={`band ${styles.feed}`} aria-labelledby="reels-head">
        <h1 id="reels-head" className="visually-hidden">
          Reels
        </h1>
        {strip}
        <EmptyFeed owner={owner} saved={saved} playlistId={playlistId} meta={meta} />
      </section>
    );
  }

  const pct = length > 0 ? Math.min(100, (pos / length) * 100) : 0;
  const line = reel ? activeLineIndex(reel.captions, reel.start + pos) : -1;
  const playing = phase === "playing";

  return (
    <section className={`band ${styles.feed}`} aria-labelledby="reels-head">
      <h1 id="reels-head" className="visually-hidden">
        Reels
      </h1>
      {strip}

      <div className={styles.scroller} ref={scrollerRef} onScroll={onScroll} tabIndex={-1}>
        <div className={styles.stage} data-idle={atEnd || undefined}>
          <div className={styles.screen} ref={hostRef} aria-label={reel ? `YouTube video: ${reel.videoTitle}` : "YouTube video"} />
          <input
            type="range"
            className={styles.range}
            min={0}
            max={length || 1}
            step={1}
            value={Math.min(pos, length || 1)}
            disabled={!ready || !reel}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="Seek in this reel"
            aria-valuetext={`${formatClock(pos)} of ${formatClock(length)}`}
            style={{ ["--p" as string]: `${pct}%` }}
          />
        </div>

        {reels.map((r, i) => (
          <Slide
            key={r.id}
            reel={r}
            index={i}
            count={count}
            owner={owner}
            current={i === active}
            line={i === active ? line : -1}
            label={i === active ? PHASE_LABEL[phase] : i === active + 1 ? "Up next" : null}
            live={i === active && playing}
            error={i === active && phase === "error" ? errorText : null}
            nextHook={reels[i + 1]?.hook ?? null}
            onSave={toggleSaved}
            onShare={share}
            onUnshare={unshare}
            onNext={goTo}
          />
        ))}

        <div className={styles.slide} data-end="true">
          <div className={styles.frameSpace} aria-hidden="true" />
          <div className={styles.endBody}>
            <h2 className={styles.hook}>{saved ? "That is everything you saved." : "That is every reel for now."}</h2>
            <p className={styles.endLine}>
              {owner
                ? meta.pending > 0
                  ? "More are being cut. They join the end of the feed as they are ready."
                  : "Add another playlist and its best minutes join the feed."
                : "These moments were picked from the full videos."}
            </p>
            <div className={styles.actions}>
              <button type="button" className="btn btn--primary" onClick={() => goTo(0)}>
                Back to the first
              </button>
              {owner ? (
                <Link className="btn" href="/app">
                  Add a playlist
                </Link>
              ) : (
                <Link className="btn" href={signedIn ? "/app" : "/signup"}>
                  {signedIn ? "Open your library" : "Make your own feed"}
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.transport}>
        <div className={styles.moves}>
          <button type="button" className={styles.iconBtn} onClick={() => goTo(active - 1)} disabled={active <= 0} aria-label="Previous reel" title="Previous reel (Up arrow)">
            <Icon d="m6 15 6-6 6 6" />
          </button>
          <button type="button" className={styles.playBtn} onClick={toggle} disabled={!ready || !reel} aria-label={playing ? "Pause" : "Play"} aria-busy={(phase === "loading" && !!reel) || undefined}>
            {playing ? <Icon d="M8 5v14M16 5v14" width={2.4} /> : <Icon d="M8 5.5v13l10.5-6.5z" fill />}
          </button>
          <button type="button" className={styles.iconBtn} onClick={() => goTo(active + 1)} disabled={atEnd} aria-label="Next reel" title="Next reel (Down arrow)">
            <Icon d="m6 9 6 6 6-6" />
          </button>
        </div>

        <p className={styles.clock} aria-hidden="true">
          {reel ? `${formatClock(pos)} / ${formatClock(length)}` : ""}
        </p>

        <div className={styles.tools}>
          <button
            type="button"
            className={styles.toolBtn}
            data-urgent={forcedMute || undefined}
            onClick={toggleSound}
            aria-pressed={!muted}
            title={muted ? "Turn the sound on (M)" : "Mute (M)"}
          >
            {/* Phones get the short label so the three buttons fit beside the transport. */}
            <span className={styles.labelLong}>{forcedMute ? "Tap for sound" : muted ? "Sound off" : "Sound on"}</span>
            <span className={styles.labelShort}>{forcedMute ? "Unmute" : muted ? "Muted" : "Sound"}</span>
          </button>
          <button
            type="button"
            className={`${styles.toolBtn} ${styles.speedBtn}`}
            onClick={() => setPref("speed", nextSpeed(prefs.speed))}
            aria-label={`Playback speed ${speedLabel(prefs.speed)}. Change speed`}
            title="Playback speed"
          >
            {speedLabel(prefs.speed)}
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => setPref("autoNext", !prefs.autoNext)}
            aria-pressed={prefs.autoNext}
            title={prefs.autoNext ? "When a reel ends the next one plays. Press to repeat instead." : "When a reel ends it repeats. Press to play the next one instead."}
          >
            {prefs.autoNext ? "Auto next" : "Repeat"}
          </button>
        </div>
      </div>

      {flash ? (
        <p key={flash.key} className={styles.flash} role="status">
          {flash.text}
        </p>
      ) : null}
    </section>
  );
}

function Icon({ d, fill = false, width = 1.8 }: { d: string; fill?: boolean; width?: number }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      {fill ? <path d={d} fill="currentColor" /> : <path d={d} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

interface SlideProps {
  reel: ReelView;
  index: number;
  count: number;
  owner: boolean;
  current: boolean;
  /** Index of the caption being spoken; -1 when this is not the reel on air. */
  line: number;
  label: string | null;
  live: boolean;
  error: string | null;
  /** The hook of the reel after this one, for the "Up next" row on wide screens. */
  nextHook: string | null;
  onSave: (r: ReelView) => void;
  onShare: (r: ReelView) => void;
  onUnshare: (r: ReelView) => void;
  onNext: (index: number) => void;
}

/** The page of one reel, under the pinned video: its number, hook, captions and actions. */
const Slide = memo(function Slide({ reel, index, count, owner, current, line, label, live, error, nextHook, onSave, onShare, onUnshare, onNext }: SlideProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLSpanElement>(null);

  // Keep the line being spoken in view. The box does not scroll by hand (a swipe on it moves
  // the feed), so this is the only thing that moves it.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const now = nowRef.current;
    if (!now || line < 0) {
      box.scrollTop = 0;
      return;
    }
    // Where the line sits inside the box right now, whatever the box's offset parent is:
    // keep it about a quarter of the way down, so what was just said stays readable above it.
    const offset = now.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop = Math.max(0, box.scrollTop + offset - box.clientHeight * 0.25);
  }, [line]);

  return (
    <article className={styles.slide} data-current={current || undefined} aria-label={`Reel ${index + 1} of ${count}`}>
      <div className={styles.frameSpace} aria-hidden="true" />

      <header className={styles.head}>
        {count > 1 ? (
          <p className={styles.count}>
            {String(index + 1).padStart(2, "0")}
            <span className={styles.countOf}>/{count}</span>
          </p>
        ) : null}
        {label ? (
          <p className="chip" data-tone={live ? "live" : current ? "work" : "quiet"} role={current ? "status" : undefined}>
            {label}
          </p>
        ) : null}
        <h2 className={styles.hook}>{reel.hook}</h2>
        <p className={styles.source}>
          {reel.channel ? <span>{reel.channel}</span> : null}
          <span>{reel.videoTitle}</span>
        </p>
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {error}{" "}
          <a className={styles.textLink} href={youtubeAt(reel.youtubeVideoId, reel.start)} target="_blank" rel="noopener noreferrer">
            Open on YouTube
          </a>{" "}
          <button type="button" className={styles.textBtn} onClick={() => onNext(index + 1)}>
            Next reel
          </button>
        </p>
      ) : null}

      <div className={styles.captions} ref={boxRef}>
        {reel.captions.length > 0 ? (
          <p className={styles.words}>
            {reel.captions.map((c, k) => (
              <span key={k} ref={k === line ? nowRef : undefined} data-state={line < 0 ? undefined : k < line ? "said" : k === line ? "now" : undefined}>
                {c.text}{" "}
              </span>
            ))}
          </p>
        ) : reel.takeaway ? (
          <p className={styles.words}>{reel.takeaway}</p>
        ) : reel.basis !== "transcript" ? (
          <p className={styles.note}>{BASIS_NOTE[reel.basis]}</p>
        ) : null}
      </div>

      <footer className={styles.foot}>
        {reel.takeaway && reel.captions.length > 0 ? <p className={styles.takeaway}>{reel.takeaway}</p> : null}
        <div className={styles.actions}>
          {owner ? (
            <button type="button" className="btn btn--small" onClick={() => onSave(reel)} aria-pressed={reel.saved} data-on={reel.saved || undefined}>
              {reel.saved ? "Saved" : "Save"}
            </button>
          ) : null}
          <button type="button" className="btn btn--small" onClick={() => onShare(reel)}>
            {owner && reel.shareSlug ? "Copy link" : "Share"}
          </button>
          {owner && reel.shareSlug ? (
            <button type="button" className={styles.textBtn} onClick={() => onUnshare(reel)}>
              Stop sharing
            </button>
          ) : null}
          <a className={styles.textLink} href={youtubeAt(reel.youtubeVideoId, reel.start)} target="_blank" rel="noopener noreferrer">
            Full video at {formatClock(reel.start)}
          </a>
          {owner && reel.playlistId ? (
            <Link className={styles.textLink} href={`/app/p/${encodeURIComponent(reel.playlistId)}`}>
              Playlist
            </Link>
          ) : null}
        </div>
        {nextHook ? (
          <button type="button" className={styles.upNext} onClick={() => onNext(index + 1)}>
            <span className={styles.upNextNum}>{String(index + 2).padStart(2, "0")}</span>
            <span className={styles.upNextBody}>
              <span className={styles.upNextLabel}>Up next</span>
              <span className={styles.upNextHook}>{nextHook}</span>
            </span>
          </button>
        ) : null}
      </footer>
    </article>
  );
});

function EmptyFeed({
  owner,
  saved,
  playlistId,
  meta,
}: {
  owner: boolean;
  saved: boolean;
  playlistId: string | null;
  meta: { pending: number; videos: number; noCaptions: number };
}) {
  let head = "No reels yet.";
  let body = "Add a playlist in the library. RecallCast cuts the strongest one-minute moments from every video.";
  let action: { href: string; label: string } | null = { href: "/app", label: "Go to the library" };

  if (!owner) {
    head = "Nothing to play here.";
    body = "This link has no reels left.";
    action = { href: "/", label: "About RecallCast" };
  } else if (saved) {
    head = "Nothing saved yet.";
    body = "Press Save on a reel and it is kept here.";
    action = { href: "/app/reels", label: "Open the feed" };
  } else if (meta.pending > 0) {
    head = "Cutting the first reels.";
    body = `${meta.pending} ${meta.pending === 1 ? "video is" : "videos are"} being read. Reels appear here as each one is done; this page updates by itself.`;
    action = null;
  } else if (meta.videos > 0 && meta.noCaptions >= meta.videos) {
    head = "No captions yet.";
    body = "None were found for these videos, and their reels are not ready. Open the playlist and choose Check captions again, or paste a transcript.";
    action = { href: playlistId ? `/app/p/${encodeURIComponent(playlistId)}` : "/app", label: playlistId ? "Open the playlist" : "Go to the library" };
  }

  return (
    <div className={styles.empty}>
      <h2 className={styles.hook}>{head}</h2>
      <p className={styles.endLine} role={owner && meta.pending > 0 ? "status" : undefined}>
        {body}
      </p>
      {action ? (
        <Link className="btn btn--primary" href={action.href}>
          {action.label}
        </Link>
      ) : (
        <p className="chip" data-tone="work">
          Working
        </p>
      )}
    </div>
  );
}
