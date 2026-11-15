import "server-only";
import { RetryableError, isRetryableError } from "@/lib/errors";
import type { TranscriptSegment } from "@/lib/types";
import { isValidVideoId } from "@/lib/youtube/parse";
import { cleanCaptionText, parseJson3, parseTimedTextXml } from "./captions";
import type { TranscriptProvider, TranscriptResult } from "./provider";

/**
 * Transcript provider backed by youtubei.js (TRANSCRIPT_PROVIDER=youtubei), verified against
 * youtubei.js 18.3.0:
 *   const yt = await Innertube.create({ retrieve_player: false, lang: 'en' });
 *   const info = await yt.getBasicInfo(videoId, { client: 'ANDROID' });  // player response only
 *   info.playability_status                            // { status: 'OK' | 'UNPLAYABLE' | 'LOGIN_REQUIRED' | ..., reason }
 *   info.captions?.caption_tracks                      // { base_url, name: Text, language_code, kind?: 'asr' }
 *   const info = await yt.getInfo(videoId);            // VideoInfo (WEB player + next responses)
 *   const ti = await info.getTranscript();             // TranscriptInfo
 *   ti.languages / ti.selectedLanguage / await ti.selectLanguage(title)
 *   ti.transcript.content?.body?.initial_segments      // (TranscriptSegment | TranscriptSectionHeader)[]
 *     TranscriptSegment { start_ms: string; end_ms: string; snippet: Text }
 *
 * Strategy (checked live on 2026-11-13):
 *  1. Ask the player endpoint as YouTube's app clients, in CAPTION_CLIENTS order, and read the
 *     caption track's timedtext URL. YouTube answers its WEB, MWEB and TV clients with
 *     UNPLAYABLE "The page needs to be reloaded" unless the request carries an attestation
 *     token, and get_transcript answers 400; the app clients still return caption tracks whose
 *     URLs need no token.
 *  2. If no app client gave a usable answer, the older WEB path: transcript panel, then the
 *     WEB caption track.
 * A client that answers OK with no caption tracks settles it: the video has no captions.
 *
 * Rate limits (seen live on 2026-11-14): YouTube answers caption downloads with HTTP 429 for a
 * while once an address has asked for too many, whichever client the URL came from. That is not
 * "no captions". The provider then throws a RetryableError, sends nothing more to YouTube until a
 * pause has passed (CAPTION_COOLDOWN_MS, doubling while YouTube keeps refusing), and the job
 * worker retries the video later. Every other failure resolves to null.
 */

/** InnerTube clients tried for caption tracks, in order. */
export const CAPTION_CLIENTS = ["ANDROID", "IOS", "ANDROID_VR", "VISIONOS"] as const;

/** Pause after YouTube answers a caption download with 429: the first one, and the longest. */
export const CAPTION_COOLDOWN_MS = 60_000;
export const CAPTION_COOLDOWN_MAX_MS = 15 * 60_000;
/** Pacing used by the app (see getTranscriptProvider): at most one video's captions per this gap. */
export const CAPTION_GAP_MS = 1000;

// One state per process, however many provider objects or copies of this module exist (the job
// worker and the route handlers can each load their own copy).
interface CaptionLimitState {
  /** No caption request before this time (ms since epoch). */
  until: number;
  /** 429 answers in a row; sets the length of the next pause. */
  strikes: number;
  /** Pacing: when the next video may start. */
  nextAt: number;
}
const LIMIT_STATE_KEY = Symbol.for("recallcast.captionLimit");

function limitState(): CaptionLimitState {
  const g = globalThis as { [LIMIT_STATE_KEY]?: CaptionLimitState };
  return (g[LIMIT_STATE_KEY] ??= { until: 0, strikes: 0, nextAt: 0 });
}

/** Milliseconds until caption downloads are tried again; 0 when YouTube is not limiting this server. */
export function captionLimitRemainingMs(now: number = Date.now()): number {
  return Math.max(0, limitState().until - now);
}

/** Test hook: forget the rate-limit pause and the pacing. */
export function resetCaptionLimit(): void {
  Object.assign(limitState(), { until: 0, strikes: 0, nextAt: 0 });
}

function limitError(waitMs: number): RetryableError {
  return new RetryableError("YouTube is limiting caption downloads from this server (HTTP 429); will retry.", {
    status: 429,
    retryAfterMs: waitMs,
  });
}

// ---- minimal structural views of the youtubei.js objects we touch (keeps tests library-free) ----

interface TextLike {
  toString(): string;
}

export interface SegmentNodeLike {
  type?: string;
  start_ms?: string | number;
  end_ms?: string | number;
  snippet?: TextLike | null;
}

export interface TranscriptInfoLike {
  transcript?: {
    content?: { body?: { initial_segments?: Iterable<SegmentNodeLike> | null } | null } | null;
  } | null;
  readonly languages: string[];
  readonly selectedLanguage: string;
  selectLanguage(language: string): Promise<TranscriptInfoLike>;
}

export interface CaptionTrackLike {
  base_url: string;
  name?: TextLike | null;
  language_code: string;
  kind?: string;
}

export interface VideoInfoLike {
  captions?: {
    caption_tracks?: CaptionTrackLike[];
    audio_tracks?: Array<{ default_caption_track_index?: number }>;
    default_audio_track_index?: number;
  } | null;
  playability_status?: { status?: string | null; reason?: string | null } | null;
  /** Only the full (WEB) info has the transcript panel. */
  getTranscript?(): Promise<TranscriptInfoLike>;
}

export interface InnertubeLike {
  getInfo(videoId: string): Promise<VideoInfoLike>;
  /** Player response only, as the given InnerTube client. */
  getBasicInfo?(videoId: string, options?: { client?: string }): Promise<VideoInfoLike>;
}

export interface YoutubeiProviderDeps {
  /** Returns a (cached) Innertube client. Defaults to a lazily created youtubei.js instance. */
  getClient?: () => Promise<InnertubeLike>;
  /** Used for the timedtext fallback. Defaults to globalThis.fetch at call time. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** At most one video's captions per this many ms, across the process. Default 0: no pacing. */
  minGapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const CLIENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_CAPTION_BYTES = 5_000_000;

// ---- default client (one per process, recreated when stale or after a failed create) ----

let clientCache: { promise: Promise<InnertubeLike>; createdAt: number } | null = null;

async function createDefaultClient(): Promise<InnertubeLike> {
  const mod = await import("youtubei.js");
  // The parser prints a page of generated class source for every response node it does not
  // know yet. None of it concerns captions; this module logs its own failures.
  try {
    mod.Log.setLevel(mod.Log.Level.NONE);
  } catch {
    // logging control is optional
  }
  const yt = await mod.Innertube.create({ retrieve_player: false, lang: "en", location: "US" });
  return yt as unknown as InnertubeLike;
}

function getDefaultClient(): Promise<InnertubeLike> {
  const now = Date.now();
  if (!clientCache || now - clientCache.createdAt > CLIENT_MAX_AGE_MS) {
    const promise = createDefaultClient();
    const entry = { promise, createdAt: now };
    clientCache = entry;
    promise.catch(() => {
      if (clientCache === entry) clientCache = null;
    });
  }
  return clientCache.promise;
}

/** Test hook: forget the cached youtubei.js client. */
export function resetYoutubeiClient(): void {
  clientCache = null;
}

// ---- helpers ----

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const isEnglishTitle = (t: string) => /^english\b/i.test(t.trim());
const isAutoTitle = (t: string) => /auto-generated|automatic/i.test(t);

/** Chooses a transcript-panel language: manual English > any English > selected (video default) > first. */
export function pickLanguage(languages: string[], selected: string): string | null {
  const english = languages.filter(isEnglishTitle);
  const manualEnglish = english.find((t) => !isAutoTitle(t));
  if (manualEnglish) return manualEnglish;
  if (english.length) return english[0];
  if (selected) return selected;
  return languages[0] ?? null;
}

function langCodeForTitle(title: string, tracks: CaptionTrackLike[]): string {
  const t = title.trim();
  const track = tracks.find((tr) => (tr.name?.toString() ?? "").trim() === t);
  if (track?.language_code) return track.language_code;
  if (isEnglishTitle(t)) return "en";
  return "und";
}

export function mapTranscriptSegments(nodes: Iterable<SegmentNodeLike> | null | undefined): TranscriptSegment[] {
  if (!nodes) return [];
  const out: TranscriptSegment[] = [];
  for (const node of Array.from(nodes)) {
    if (!node) continue;
    // Section headers (chapter titles) share start_ms/snippet but are not speech.
    if (node.type !== undefined && node.type !== "TranscriptSegment") continue;
    const startMs = Number(node.start_ms);
    const endMs = Number(node.end_ms);
    if (!Number.isFinite(startMs) || startMs < 0) continue;
    const text = cleanCaptionText(node.snippet?.toString() ?? "");
    if (!text) continue;
    const dur = Number.isFinite(endMs) && endMs > startMs ? (endMs - startMs) / 1000 : 0;
    out.push({ start: Math.round(startMs / 10) / 100, dur: Math.round(dur * 100) / 100, text });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Caption track preference: manual English > ASR English > default track > first. */
export function pickCaptionTrack(info: VideoInfoLike): CaptionTrackLike | null {
  const tracks = info.captions?.caption_tracks ?? [];
  if (!tracks.length) return null;
  const en = (t: CaptionTrackLike) => /^en\b/i.test(t.language_code ?? "");
  const manualEn = tracks.find((t) => en(t) && t.kind !== "asr");
  if (manualEn) return manualEn;
  const asrEn = tracks.find((t) => en(t));
  if (asrEn) return asrEn;
  const audio = info.captions?.audio_tracks?.[info.captions?.default_audio_track_index ?? 0];
  const idx = audio?.default_caption_track_index;
  if (typeof idx === "number" && tracks[idx]) return tracks[idx];
  return tracks[0];
}

/** Only https URLs on youtube.com hosts may be fetched (defence against SSRF via tampered payloads). */
export function safeTimedTextUrl(baseUrl: string): URL | null {
  try {
    const url = new URL(baseUrl, "https://www.youtube.com");
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
    if (url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

// ---- provider ----

export function createYoutubeiTranscriptProvider(deps: YoutubeiProviderDeps = {}): TranscriptProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const getClient = deps.getClient ?? getDefaultClient;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minGapMs = Math.max(0, deps.minGapMs ?? 0);

  /** YouTube answered 429: start (or keep) the pause and say when to come back. */
  function rateLimited(retryAfterMs: number | null): RetryableError {
    const s = limitState();
    const t = now();
    // Two videos refused at the same moment are one refusal, not two.
    if (t >= s.until) {
      s.strikes = Math.min(s.strikes + 1, 10);
      const wait = Math.min(CAPTION_COOLDOWN_MAX_MS, Math.max(retryAfterMs ?? 0, CAPTION_COOLDOWN_MS * 2 ** (s.strikes - 1)));
      s.until = t + wait;
      log(`[transcripts] YouTube answered 429 to a caption download. No caption requests for ${Math.round(wait / 1000)} s.`);
    }
    return limitError(s.until - t);
  }

  /** Spaces the videos out, so a whole playlist is not asked for in one burst. */
  async function pace(): Promise<void> {
    if (minGapMs <= 0) return;
    const s = limitState();
    const t = now();
    const at = Math.max(t, s.nextAt);
    s.nextAt = at + minGapMs;
    if (at > t) await sleep(at - t);
  }

  async function fromTranscriptPanel(info: VideoInfoLike): Promise<TranscriptResult | null> {
    if (typeof info.getTranscript !== "function") return null;
    let ti = await withTimeout(info.getTranscript(), timeoutMs, "getTranscript");
    const wanted = pickLanguage(ti.languages ?? [], ti.selectedLanguage ?? "");
    if (wanted && wanted !== ti.selectedLanguage) {
      try {
        ti = await withTimeout(ti.selectLanguage(wanted), timeoutMs, "selectLanguage");
      } catch {
        // Keep the default-language transcript we already have.
      }
    }
    const segments = mapTranscriptSegments(ti.transcript?.content?.body?.initial_segments);
    if (!segments.length) return null;
    const title = ti.selectedLanguage || wanted || "";
    const lang = title ? langCodeForTitle(title, info.captions?.caption_tracks ?? []) : "und";
    return { segments, lang, source: "youtubei" };
  }

  async function fetchText(url: URL): Promise<string | null> {
    const doFetch = deps.fetchImpl ?? globalThis.fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (res.status === 429) {
      const seconds = Number(res.headers?.get?.("retry-after"));
      throw rateLimited(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null);
    }
    // Any other refusal: say which, so the log does not read as "no captions".
    if (!res.ok) throw new Error(`caption download answered HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length > MAX_CAPTION_BYTES) return null;
    return text;
  }

  async function fromCaptionTrack(info: VideoInfoLike): Promise<TranscriptResult | null> {
    const track = pickCaptionTrack(info);
    if (!track) return null;
    const base = safeTimedTextUrl(track.base_url);
    if (!base) return null;

    const jsonUrl = new URL(base);
    jsonUrl.searchParams.set("fmt", "json3");
    const done = (segments: TranscriptSegment[]): TranscriptResult => {
      limitState().strikes = 0; // YouTube is answering again
      return { segments, lang: track.language_code || "und", source: "youtubei" };
    };
    const jsonText = await fetchText(jsonUrl);
    if (jsonText) {
      try {
        const segments = parseJson3(JSON.parse(jsonText));
        if (segments.length) return done(segments);
      } catch {
        // not JSON; fall through to XML
      }
    }

    const xmlUrl = new URL(base);
    xmlUrl.searchParams.delete("fmt");
    const xml = await fetchText(xmlUrl);
    const segments = xml ? parseTimedTextXml(xml) : [];
    return segments.length ? done(segments) : null;
  }

  /**
   * Step 1: caption tracks through the app clients. `settled` is true when a client gave a
   * definite answer (a transcript, or "this video has no captions"), so the WEB path is skipped.
   */
  async function fromAppClients(
    client: InnertubeLike,
    videoId: string,
  ): Promise<{ settled: boolean; result: TranscriptResult | null }> {
    if (typeof client.getBasicInfo !== "function") return { settled: false, result: null };
    const refusals: string[] = [];
    for (const name of CAPTION_CLIENTS) {
      let info: VideoInfoLike;
      try {
        info = await withTimeout(client.getBasicInfo(videoId, { client: name }), timeoutMs, `getBasicInfo(${name})`);
      } catch (err) {
        refusals.push(`${name}: ${errMessage(err)}`);
        continue;
      }
      if (info.captions?.caption_tracks?.length) {
        try {
          const result = await fromCaptionTrack(info);
          if (result) return { settled: true, result };
          refusals.push(`${name}: the caption file was empty`);
        } catch (err) {
          // Limited by address: the other clients' caption URLs would be refused too.
          if (isRetryableError(err)) throw err;
          refusals.push(`${name}: ${errMessage(err)}`);
        }
        continue;
      }
      const status = info.playability_status?.status ?? "";
      if (status === "OK") {
        log(`[transcripts] ${videoId} has no caption tracks.`);
        return { settled: true, result: null };
      }
      refusals.push(`${name}: ${status || "no status"} ${info.playability_status?.reason ?? ""}`.trim());
    }
    // Every client refusing at once (LOGIN_REQUIRED, "Sign in to confirm you're not a bot")
    // usually means YouTube is blocking this server's IP address, not this one video.
    log(`[transcripts] no app client returned captions for ${videoId}: ${refusals.join("; ").slice(0, 600)}`);
    return { settled: false, result: null };
  }

  return {
    async fetch(videoId: string): Promise<TranscriptResult | null> {
      if (!isValidVideoId(videoId)) return null;
      // While YouTube is refusing this server, ask for nothing: more requests only extend it.
      const wait = captionLimitRemainingMs(now());
      if (wait > 0) throw limitError(wait);
      await pace();
      let client: InnertubeLike;
      try {
        client = await withTimeout(getClient(), timeoutMs, "Innertube.create");
      } catch (err) {
        log(`[transcripts] youtubei could not start for video ${videoId}: ${errMessage(err)}`);
        return null;
      }

      const viaApps = await fromAppClients(client, videoId);
      if (viaApps.settled) return viaApps.result;

      let info: VideoInfoLike;
      try {
        info = await withTimeout(client.getInfo(videoId), timeoutMs, "getInfo");
      } catch (err) {
        log(`[transcripts] youtubei could not load video ${videoId}: ${errMessage(err)}`);
        return null;
      }

      try {
        const panel = await fromTranscriptPanel(info);
        if (panel) return panel;
      } catch (err) {
        log(`[transcripts] transcript panel unavailable for ${videoId}: ${errMessage(err)}`);
      }

      try {
        const captions = await fromCaptionTrack(info);
        if (captions) return captions;
      } catch (err) {
        if (isRetryableError(err)) throw err;
        log(`[transcripts] caption track fallback failed for ${videoId}: ${errMessage(err)}`);
      }

      return null;
    },
  };
}

function errMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 200)}...` : msg;
}
