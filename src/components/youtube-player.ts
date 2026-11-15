"use client";

/**
 * Minimal typed loader for the YouTube IFrame Player API
 * (https://developers.google.com/youtube/iframe_api_reference). The API script is loaded once,
 * on first use, from www.youtube.com; the player itself runs in an iframe from
 * www.youtube-nocookie.com (privacy-enhanced mode).
 */

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  loadVideoById(opts: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  destroy(): void;
}

export interface YTPlayerOptions {
  host?: string;
  videoId: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (e: { target: YTPlayer }) => void;
    onStateChange?: (e: { data: number; target: YTPlayer }) => void;
    onError?: (e: { data: number; target: YTPlayer }) => void;
    /** The browser refused to start playback without a tap (the API then leaves the video unstarted). */
    onAutoplayBlocked?: (e: { target: YTPlayer }) => void;
  };
}

interface YTNamespace {
  Player: new (el: HTMLElement | string, opts: YTPlayerOptions) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  loading = new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("The YouTube player did not load."));
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("The YouTube player could not be loaded. Check your connection, or an ad blocker."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * False for the codes that are about the video itself (bad id, removed, private, embedding
 * switched off): loading it again cannot help. Anything else, code 5 "HTML5 player error"
 * above all, is the player failing to start, which a second load often cures.
 */
export function isTransientYouTubeError(code: number): boolean {
  return ![2, 100, 101, 150, 153].includes(code);
}

/** User-readable text for an IFrame API error code. */
export function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 101:
    case 150:
    case 153:
      return "This video can't play here. It may be private, removed, or blocked from playing outside YouTube.";
    case 100:
      return "This video was removed or made private.";
    case 5:
      return "This video can't play in this browser.";
    default:
      return "This video could not play.";
  }
}
