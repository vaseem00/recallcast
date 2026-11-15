"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clipPosition, clipRangeLabel, formatClock, isSpeed, isTypingTarget, SPEEDS, speedLabel, youtubeAt, type Speed } from "./format";
import { loadYouTubeApi, YT_STATE, youtubeErrorMessage, type YTPlayer } from "./youtube-player";
import styles from "@/styles/player.module.css";

export interface PlayerTrack {
  id: string;
  youtubeVideoId: string;
  /** Clip window, whole seconds into the video. */
  start: number;
  end: number;
  title: string;
  channel: string;
}

type Mode = "bar" | "mini" | "full";

const SPEED_KEY = "rc.player.speed";
const HINT_KEY = "rc.player.hinted";
const POPOUT_KEY = "rc.player.popout";
const SKIP_S = 15;
/** Taps closer together than this count as one double or triple tap. */
const TAP_MS = 300;
/** Movement past this many pixels turns a press into a drag. */
const DRAG_PX = 8;
/** Swiping the docked bar down this far turns it into the floating mini player. */
const SWIPE_TO_MINI_PX = 70;
const EDGE = 8;

function readSpeed(): Speed {
  try {
    const n = Number(window.localStorage.getItem(SPEED_KEY));
    return isSpeed(n) ? n : 1;
  } catch {
    return 1;
  }
}

function writeSpeed(s: Speed) {
  try {
    window.localStorage.setItem(SPEED_KEY, String(s));
  } catch {
    // storage blocked: the speed just is not remembered
  }
}

function firstVisit(): boolean {
  try {
    if (window.localStorage.getItem(HINT_KEY)) return false;
    window.localStorage.setItem(HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * The episode player. Each episode is a window (start to end) of a YouTube video, played through
 * YouTube's own embedded player, which always stays visible and at least 200px tall (YouTube's
 * terms; the creator gets the view). It has three layouts that share one YouTube player, so
 * switching never reloads the video:
 *  - bar:  docked to the bottom edge with the full transport;
 *  - mini: a floating card you drag anywhere (it snaps to the nearest side); swipe the bar down
 *          to get it;
 *  - full: the whole screen (real fullscreen where the browser allows it, else the viewport).
 * On the video: one tap plays or pauses, two taps on the left or right half skip 15 seconds,
 * three taps toggle full screen. Keyboard: space, left and right arrows, f, Escape.
 * When a clip ends the next one starts, like a podcast queue.
 */
export default function Player({
  tracks,
  index,
  onIndexChange,
  onClose,
}: {
  tracks: PlayerTrack[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose?: () => void;
}) {
  const track = tracks[index] ?? null;
  const sectionRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ytRef = useRef<YTPlayer | null>(null);
  const loadedRef = useRef<string | null>(null);
  const endedRef = useRef<string | null>(null);
  const trackRef = useRef(track);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [pos, setPos] = useState(0);
  // The player mounts on the client after a Play press, so reading storage here cannot cause
  // a hydration mismatch.
  const [speed, setSpeed] = useState<Speed>(() => (typeof window === "undefined" ? 1 : readSpeed()));
  const speedRef = useRef(speed);
  const [error, setError] = useState<{ trackId: string | null; message: string } | null>(null);

  const [mode, setMode] = useState<Mode>("bar");
  const modeRef = useRef<Mode>("bar");
  const beforeFull = useRef<Mode>("bar");
  const realFullscreen = useRef(false);
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const miniPosRef = useRef(miniPos);
  const [dragging, setDragging] = useState(false);
  const [flash, setFlash] = useState<{ text: string; side: "left" | "right" | "center"; key: number } | null>(() =>
    typeof window !== "undefined" && firstVisit()
      ? { text: "Tap twice on a side to skip. Tap three times for full screen.", side: "center", key: 0 }
      : null,
  );

  useEffect(() => {
    trackRef.current = track;
  }, [track]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    miniPosRef.current = miniPos;
  }, [miniPos]);
  useEffect(() => {
    speedRef.current = speed;
    try {
      ytRef.current?.setPlaybackRate(speed);
    } catch {
      // player not ready
    }
  }, [speed]);
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), flash.side === "center" ? 3200 : 650);
    return () => window.clearTimeout(id);
  }, [flash]);

  const hasNext = index < tracks.length - 1;
  const hasPrev = index > 0;
  const length = track ? Math.max(1, track.end - track.start) : 0;

  const goNext = useCallback(() => {
    if (index < tracks.length - 1) onIndexChange(index + 1);
  }, [index, tracks.length, onIndexChange]);
  const goNextRef = useRef(goNext);
  useEffect(() => {
    goNextRef.current = goNext;
  }, [goNext]);

  const finish = useCallback(() => {
    const t = trackRef.current;
    if (!t || endedRef.current === t.id) return;
    endedRef.current = t.id;
    setPlaying(false);
    try {
      ytRef.current?.pauseVideo();
    } catch {
      // ignore
    }
    setPos(Math.max(0, t.end - t.start));
    goNextRef.current();
  }, []);

  // ---------------------------------------------------------------- YouTube player

  // Create the YouTube player once.
  useEffect(() => {
    let cancelled = false;
    const first = trackRef.current;
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
                e.target.setPlaybackRate(speedRef.current);
                e.target.playVideo();
              } catch {
                // ignore
              }
            },
            onStateChange: (e) => {
              if (cancelled) return;
              if (e.data === YT_STATE.PLAYING) {
                setPlaying(true);
                setWaiting(false);
                setError(null);
                try {
                  e.target.setPlaybackRate(speedRef.current);
                } catch {
                  // ignore
                }
              } else if (e.data === YT_STATE.BUFFERING) {
                setWaiting(true);
              } else if (e.data === YT_STATE.PAUSED || e.data === YT_STATE.CUED) {
                setPlaying(false);
                setWaiting(false);
              } else if (e.data === YT_STATE.ENDED) {
                setWaiting(false);
                finish();
              }
            },
            onError: (e) => {
              if (cancelled) return;
              setPlaying(false);
              setWaiting(false);
              setError({ trackId: trackRef.current?.id ?? null, message: youtubeErrorMessage(e.data) });
            },
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setWaiting(false);
        setError({ trackId: null, message: err instanceof Error ? err.message : "The YouTube player could not be loaded." });
      });
    return () => {
      cancelled = true;
      try {
        ytRef.current?.destroy();
      } catch {
        // ignore
      }
      ytRef.current = null;
    };
  }, [finish]);

  // Load a new clip into the same player when the track changes.
  useEffect(() => {
    const yt = ytRef.current;
    if (!ready || !yt || !track || loadedRef.current === track.id) return;
    loadedRef.current = track.id;
    endedRef.current = null;
    try {
      yt.loadVideoById({ videoId: track.youtubeVideoId, startSeconds: track.start, endSeconds: track.end });
    } catch (err) {
      // Playback failures arrive through the player's onError; this only guards a torn-down iframe.
      console.warn("[player] loadVideoById failed", err);
    }
  }, [ready, track]);

  // Clock: YouTube has no time events, so poll while ready. Also the backstop for the clip's
  // end, in case the player pauses at endSeconds instead of reporting ENDED.
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      const yt = ytRef.current;
      const t = trackRef.current;
      if (!yt || !t || loadedRef.current !== t.id) return;
      let now = 0;
      try {
        now = yt.getCurrentTime();
      } catch {
        return;
      }
      if (!Number.isFinite(now) || now < t.start - 2) {
        setPos(0); // still loading the new video
        return;
      }
      setPos(clipPosition(now, t));
      if (now >= t.end - 0.25 && endedRef.current !== t.id) {
        let state: number = YT_STATE.UNSTARTED;
        try {
          state = yt.getPlayerState();
        } catch {
          // ignore
        }
        if (state === YT_STATE.PLAYING || state === YT_STATE.PAUSED || state === YT_STATE.ENDED) finish();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [ready, finish]);

  const seekTo = useCallback((p: number) => {
    const t = trackRef.current;
    const yt = ytRef.current;
    if (!t || !yt) return;
    const len = Math.max(0, t.end - t.start);
    const next = Math.max(0, Math.min(len - 0.5, p));
    endedRef.current = null;
    try {
      yt.seekTo(t.start + next, true);
    } catch {
      return;
    }
    setPos(next);
  }, []);

  const toggle = useCallback(() => {
    const yt = ytRef.current;
    const t = trackRef.current;
    if (!yt || !t) return;
    try {
      if (playing) {
        yt.pauseVideo();
      } else {
        if (endedRef.current === t.id) {
          endedRef.current = null;
          yt.seekTo(t.start, true);
          setPos(0);
        }
        yt.playVideo();
      }
    } catch {
      // ignore
    }
  }, [playing]);

  const skip = useCallback((delta: number) => seekTo(pos + delta), [pos, seekTo]);

  // ---------------------------------------------------------------- layouts

  /** Default mini position: bottom-right corner, measured once the mini layout has rendered. */
  const placeMini = useCallback((x?: number, y?: number) => {
    const el = sectionRef.current;
    const w = el?.offsetWidth ?? 356;
    const h = el?.offsetHeight ?? 260;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nx = clamp(x ?? vw - w - EDGE, EDGE, Math.max(EDGE, vw - w - EDGE));
    const ny = clamp(y ?? vh - h - EDGE * 2, EDGE, Math.max(EDGE, vh - h - EDGE));
    return { x: nx, y: ny };
  }, []);

  const toMini = useCallback(() => {
    setMiniPos(null);
    setMode("mini");
  }, []);

  const toBar = useCallback(() => setMode("bar"), []);

  const exitFull = useCallback(() => {
    if (realFullscreen.current && typeof document !== "undefined" && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    realFullscreen.current = false;
    setMode(beforeFull.current);
  }, []);

  /** Must run inside a user gesture (tap, click, key) so the browser allows fullscreen. */
  const enterFull = useCallback(() => {
    beforeFull.current = modeRef.current === "full" ? "bar" : modeRef.current;
    setMode("full");
    const el = sectionRef.current;
    if (el && typeof el.requestFullscreen === "function" && document.fullscreenEnabled) {
      el.requestFullscreen({ navigationUI: "hide" })
        .then(() => {
          realFullscreen.current = true;
          const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
          orientation?.lock?.("landscape").catch(() => {});
        })
        .catch(() => {
          // Not allowed here (e.g. iPhone Safari): the CSS layout still fills the viewport.
        });
    }
  }, []);

  /**
   * Puts the YouTube iframe itself (only the video) into fullscreen. On Android, Chrome treats a
   * fullscreen video as one it may move into its own floating picture-in-picture window when
   * the user presses Home or switches app, so the clip keeps playing over other apps. Whether it
   * does is Chrome's and YouTube's decision; nothing here forces it.
   */
  const popOut = useCallback(() => {
    const frame = hostRef.current?.querySelector("iframe");
    if (!frame || typeof frame.requestFullscreen !== "function" || !document.fullscreenEnabled) {
      setFlash({ text: "This browser can't pop the video out.", side: "center", key: Date.now() });
      return;
    }
    const android = /Android/i.test(navigator.userAgent);
    if (android) {
      let seen = true;
      try {
        seen = window.localStorage.getItem(POPOUT_KEY) === "1";
        window.localStorage.setItem(POPOUT_KEY, "1");
      } catch {
        // storage blocked: skip the explanation
      }
      if (!seen) {
        setFlash({
          text: "Pop out plays the video full screen. Then press Home or open another app, and Chrome keeps it playing in a small window. Tap Pop out again to start.",
          side: "center",
          key: Date.now(),
        });
        return;
      }
    }
    try {
      ytRef.current?.playVideo();
    } catch {
      // ignore
    }
    frame
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => {
        const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        orientation?.lock?.("landscape").catch(() => {});
      })
      .catch(() => setFlash({ text: "The video could not go full screen here.", side: "center", key: Date.now() }));
  }, []);

  const toggleFull = useCallback(() => {
    if (modeRef.current === "full") exitFull();
    else enterFull();
  }, [enterFull, exitFull]);

  // Leaving real fullscreen with the system gesture or Esc returns to the previous layout.
  useEffect(() => {
    function onChange() {
      if (!document.fullscreenElement && realFullscreen.current) {
        realFullscreen.current = false;
        setMode(beforeFull.current);
      }
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Full screen without the Fullscreen API: stop the page scrolling underneath.
  useEffect(() => {
    if (mode !== "full") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mode]);

  // Mini: place it once it has its mini size, and keep it on screen when the window resizes.
  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (mode !== "mini") {
      // Drags write the transform straight to the element; clear it so the bar and full
      // layouts sit where their CSS puts them.
      if (el) el.style.transform = "";
      return;
    }
    const p = placeMini(miniPosRef.current?.x, miniPosRef.current?.y);
    if (el) el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    function onResize() {
      const q = placeMini(miniPosRef.current?.x, miniPosRef.current?.y);
      setMiniPos(q);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mode, placeMini]);

  // ---------------------------------------------------------------- gestures

  const actions = useRef({ toggle, skip, toggleFull });
  useEffect(() => {
    actions.current = { toggle, skip, toggleFull };
  }, [toggle, skip, toggleFull]);

  const gesture = useRef<{ id: number; x0: number; y0: number; px: number; py: number; dragging: boolean; onVideo: boolean } | null>(null);
  const taps = useRef<{ n: number; timer: number | undefined }>({ n: 0, timer: undefined });
  const screenRef = useRef<HTMLDivElement>(null);

  function registerTap(clientX: number) {
    const t = taps.current;
    t.n += 1;
    window.clearTimeout(t.timer);
    if (t.n >= 3) {
      t.n = 0;
      actions.current.toggleFull(); // still inside the pointerup gesture, so fullscreen is allowed
      return;
    }
    t.timer = window.setTimeout(() => {
      const n = t.n;
      t.n = 0;
      if (n === 1) {
        actions.current.toggle();
      } else if (n === 2) {
        const r = screenRef.current?.getBoundingClientRect();
        const left = r ? clientX < r.left + r.width / 2 : false;
        actions.current.skip(left ? -SKIP_S : SKIP_S);
        setFlash({ text: left ? `-${SKIP_S} s` : `+${SKIP_S} s`, side: left ? "left" : "right", key: Date.now() });
      }
    }, TAP_MS);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, onVideo: boolean) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = miniPosRef.current ?? placeMini();
    gesture.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, px: p.x, py: p.y, dragging: false, onVideo };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    const el = sectionRef.current;
    if (!g || g.id !== e.pointerId || !el) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.dragging) {
      if (Math.hypot(dx, dy) < DRAG_PX || modeRef.current === "full") return;
      g.dragging = true;
      setDragging(true);
      window.clearTimeout(taps.current.timer);
      taps.current.n = 0;
    }
    if (modeRef.current === "mini") {
      el.style.transform = `translate3d(${g.px + dx}px, ${g.py + dy}px, 0)`;
    } else if (modeRef.current === "bar") {
      el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    gesture.current = null;
    const el = sectionRef.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (g.dragging) {
      setDragging(false);
      if (modeRef.current === "bar") {
        if (el) el.style.transform = "";
        if (dy > SWIPE_TO_MINI_PX) toMini();
      } else if (modeRef.current === "mini" && el) {
        // Snap to the nearer side, keep the height where it was dropped.
        const w = el.offsetWidth;
        const cx = g.px + dx + w / 2;
        const x = cx < window.innerWidth / 2 ? EDGE : window.innerWidth - w - EDGE;
        const p = placeMini(x, g.py + dy);
        setMiniPos(p);
        el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      }
      return;
    }
    if (g.onVideo) registerTap(e.clientX);
  }

  function onPointerCancel() {
    gesture.current = null;
    setDragging(false);
    if (modeRef.current === "bar" && sectionRef.current) sectionRef.current.style.transform = "";
  }

  // ---------------------------------------------------------------- keyboard

  useEffect(() => {
    if (!track) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.code === "Space" || e.key === " ") {
        if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return;
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        skip(-SKIP_S);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skip(SKIP_S);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFull();
      } else if (e.key === "Escape" && modeRef.current === "full" && !document.fullscreenElement) {
        exitFull();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [track, toggle, skip, toggleFull, exitFull]);

  if (!track) return null;

  const pct = length > 0 ? Math.min(100, (pos / length) * 100) : 0;
  const shownError = error && (error.trackId === null || error.trackId === track.id) ? error.message : null;
  const busy = (waiting && !shownError) || undefined;

  const playIcon = playing ? (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M8 5v14M16 5v14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </svg>
  );
  const nextIcon = (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M18 5v14M6 6l9 6-9 6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
  const expandIcon = (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const shrinkIcon = (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const popIcon = (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M10 4H4v16h16v-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 4h6v6M20 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const miniIcon = (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="12" y="12" width="7" height="5" fill="currentColor" />
    </svg>
  );

  return (
    <>
      {mode === "bar" ? <div className={styles.spacer} aria-hidden="true" /> : null}
      <section
        ref={sectionRef}
        className={styles.player}
        data-mode={mode}
        data-dragging={dragging || undefined}
        aria-label="Episode player"
        style={mode === "mini" && miniPos ? { transform: `translate3d(${miniPos.x}px, ${miniPos.y}px, 0)` } : undefined}
      >
        <div
          className={styles.handle}
          onPointerDown={(e) => onPointerDown(e, false)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          aria-hidden="true"
          title={mode === "bar" ? "Swipe down for the mini player" : "Drag to move"}
        >
          <span />
        </div>

        <div className={styles.inner}>
          <div className={styles.screenWrap} ref={screenRef}>
            <div className={styles.screen} ref={hostRef} aria-label={`YouTube video: ${track.title}`} />
            <div
              className={styles.tapLayer}
              onPointerDown={(e) => onPointerDown(e, true)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              aria-hidden="true"
            />
            {flash ? (
              <p key={flash.key} className={styles.flash} data-side={flash.side} aria-live="polite">
                {flash.text}
              </p>
            ) : null}
          </div>

          {mode === "mini" ? (
            <div className={styles.miniBar}>
              <span className={styles.miniProgress} style={{ ["--p" as string]: `${pct}%` }} aria-hidden="true" />
              <div
                className={styles.miniText}
                onPointerDown={(e) => onPointerDown(e, false)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
              >
                <p className={styles.miniTitle}>{track.title}</p>
                <p className={styles.miniMeta}>
                  {formatClock(pos)} / {formatClock(length)}
                  {tracks.length > 1 ? ` · ${index + 1} of ${tracks.length}` : ""}
                </p>
              </div>
              <button type="button" className={styles.miniPlay} onClick={toggle} disabled={!ready} aria-label={playing ? "Pause" : "Play"} aria-busy={busy}>
                {playIcon}
              </button>
              <button type="button" className={styles.skipBtn} onClick={goNext} disabled={!hasNext} aria-label="Next episode">
                {nextIcon}
              </button>
              <button type="button" className={styles.skipBtn} onClick={popOut} aria-label="Pop out the video" title="Pop out: full-screen video that can keep playing in a small window">
                {popIcon}
              </button>
              <button type="button" className={styles.skipBtn} onClick={toBar} aria-label="Expand the player">
                {expandIcon}
              </button>
              {onClose ? (
                <button type="button" className={styles.skipBtn} onClick={onClose} aria-label="Close the player">
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </div>
          ) : (
            <div className={styles.side}>
              <div
                className={styles.titleRow}
                onPointerDown={mode === "bar" ? (e) => onPointerDown(e, false) : undefined}
                onPointerMove={mode === "bar" ? onPointerMove : undefined}
                onPointerUp={mode === "bar" ? onPointerUp : undefined}
                onPointerCancel={mode === "bar" ? onPointerCancel : undefined}
              >
                <p className={styles.title}>{track.title}</p>
                <p className={styles.meta}>
                  {track.channel ? <span>{track.channel}</span> : null}
                  <span>{clipRangeLabel(track)} of the video</span>
                  {tracks.length > 1 ? (
                    <span>
                      Episode {index + 1} of {tracks.length}
                    </span>
                  ) : null}
                </p>
              </div>

              <div className={styles.scrub}>
                <span className={styles.time}>{formatClock(pos)}</span>
                <input
                  type="range"
                  className={styles.range}
                  min={0}
                  max={length || 1}
                  step={1}
                  value={Math.min(pos, length || 1)}
                  disabled={!ready}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  aria-label="Seek"
                  aria-valuetext={`${formatClock(pos)} of ${formatClock(length)}`}
                  style={{ ["--p" as string]: `${pct}%` }}
                />
                <span className={styles.time}>{formatClock(length)}</span>
              </div>

              {shownError ? (
                <p className={styles.error} role="alert">
                  {shownError}{" "}
                  <a className={styles.textLink} href={youtubeAt(track.youtubeVideoId, track.start)} target="_blank" rel="noopener noreferrer">
                    Open on YouTube
                  </a>
                  {hasNext ? (
                    <>
                      {" "}
                      <button type="button" className={styles.textBtn} onClick={goNext}>
                        Next episode
                      </button>
                    </>
                  ) : null}
                </p>
              ) : null}

              <div className={styles.controls}>
                <div className={styles.transport}>
                  <button type="button" className={styles.skipBtn} onClick={() => onIndexChange(index - 1)} disabled={!hasPrev} aria-label="Previous episode">
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                      <path d="M6 5v14M18 6l-9 6 9 6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                  </button>
                  <button type="button" className={styles.skipBtn} onClick={() => skip(-SKIP_S)} disabled={!ready} aria-label={`Back ${SKIP_S} seconds`}>
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                      <path d="M11 6 5 12l6 6M19 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button type="button" className={styles.playBtn} onClick={toggle} disabled={!ready} aria-label={playing ? "Pause" : "Play"} aria-busy={busy}>
                    {playIcon}
                  </button>
                  <button type="button" className={styles.skipBtn} onClick={() => skip(SKIP_S)} disabled={!ready} aria-label={`Forward ${SKIP_S} seconds`}>
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                      <path d="m13 6 6 6-6 6M5 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button type="button" className={styles.skipBtn} onClick={goNext} disabled={!hasNext} aria-label="Next episode">
                    {nextIcon}
                  </button>
                </div>

                <div className={styles.tools}>
                  <fieldset className={styles.speeds}>
                    <legend className="visually-hidden">Playback speed</legend>
                    {SPEEDS.map((s) => (
                      <label key={s} className={styles.speed}>
                        <input
                          type="radio"
                          name="player-speed"
                          value={s}
                          checked={speed === s}
                          onChange={() => {
                            setSpeed(s);
                            writeSpeed(s);
                          }}
                        />
                        <span>{speedLabel(s)}</span>
                      </label>
                    ))}
                  </fieldset>
                  <button type="button" className={styles.skipBtn} onClick={popOut} aria-label="Pop out the video" title="Pop out: full-screen video that can keep playing in a small window">
                    {popIcon}
                  </button>
                  {mode === "bar" ? (
                    <button type="button" className={styles.skipBtn} onClick={toMini} aria-label="Mini player" title="Mini player">
                      {miniIcon}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.skipBtn}
                    onClick={toggleFull}
                    aria-label={mode === "full" ? "Exit full screen" : "Full screen"}
                    title={mode === "full" ? "Exit full screen (Esc)" : "Full screen (F)"}
                  >
                    {mode === "full" ? shrinkIcon : expandIcon}
                  </button>
                  {onClose && mode !== "full" ? (
                    <button type="button" className={styles.textBtn} onClick={onClose}>
                      Close
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
