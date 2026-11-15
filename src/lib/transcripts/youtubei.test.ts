import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTION_CLIENTS,
  CAPTION_COOLDOWN_MAX_MS,
  CAPTION_COOLDOWN_MS,
  captionLimitRemainingMs,
  createYoutubeiTranscriptProvider,
  resetCaptionLimit,
  mapTranscriptSegments,
  pickCaptionTrack,
  pickLanguage,
  safeTimedTextUrl,
  type CaptionTrackLike,
  type InnertubeLike,
  type SegmentNodeLike,
  type TranscriptInfoLike,
  type VideoInfoLike,
} from "./youtubei";

const VID = "dQw4w9WgXcQ";
const text = (s: string) => ({ toString: () => s });
const seg = (startMs: number, endMs: number, s: string): SegmentNodeLike => ({
  type: "TranscriptSegment",
  start_ms: String(startMs),
  end_ms: String(endMs),
  snippet: text(s),
});
const header = (startMs: number, s: string): SegmentNodeLike => ({
  type: "TranscriptSectionHeader",
  start_ms: String(startMs),
  end_ms: String(startMs + 1000),
  snippet: text(s),
});

/** Fake TranscriptInfo with a language menu; each language has its own segment list. */
function fakeTranscriptInfo(
  byLanguage: Record<string, SegmentNodeLike[]>,
  selected: string,
  opts: { selectFails?: boolean } = {},
): TranscriptInfoLike & { selectLanguage: ReturnType<typeof vi.fn> } {
  const info = {
    transcript: { content: { body: { initial_segments: byLanguage[selected] ?? [] } } },
    languages: Object.keys(byLanguage),
    selectedLanguage: selected,
    selectLanguage: vi.fn(async (lang: string) => {
      if (opts.selectFails) throw new Error("Language not found");
      return fakeTranscriptInfo(byLanguage, lang, opts);
    }),
  };
  return info;
}

function fakeClient(info: Partial<VideoInfoLike> & { getTranscript?: VideoInfoLike["getTranscript"] }): {
  client: InnertubeLike;
  getInfo: ReturnType<typeof vi.fn>;
} {
  const full: VideoInfoLike = {
    captions: info.captions ?? null,
    getTranscript: info.getTranscript ?? (async () => Promise.reject(new Error("Transcript panel not found"))),
  };
  const getInfo = vi.fn(async () => full);
  return { client: { getInfo }, getInfo };
}

const tracks: CaptionTrackLike[] = [
  { base_url: "https://www.youtube.com/api/timedtext?v=x&lang=es", name: text("Spanish"), language_code: "es" },
  {
    base_url: "https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr",
    name: text("English (auto-generated)"),
    language_code: "en",
    kind: "asr",
  },
  { base_url: "https://www.youtube.com/api/timedtext?v=x&lang=en-GB", name: text("English (United Kingdom)"), language_code: "en-GB" },
];

const quiet = { log: () => {} };

// The rate-limit pause and the pacing are process-wide; no test may inherit another's.
beforeEach(() => resetCaptionLimit());

describe("pickLanguage", () => {
  it("prefers manual English, then any English, then the selected default", () => {
    expect(pickLanguage(["Spanish", "English (auto-generated)", "English"], "Spanish")).toBe("English");
    expect(pickLanguage(["Spanish", "English (auto-generated)"], "Spanish")).toBe("English (auto-generated)");
    expect(pickLanguage(["Spanish", "German"], "German")).toBe("German");
    expect(pickLanguage(["Spanish", "German"], "")).toBe("Spanish");
    expect(pickLanguage([], "")).toBeNull();
  });
});

describe("mapTranscriptSegments", () => {
  it("converts ms to seconds, skips section headers, empties and bad numbers, and sorts", () => {
    const out = mapTranscriptSegments([
      header(0, "Chapter 1: Intro"),
      seg(4200, 7300, "second"),
      seg(1000, 4200, "  first\nline "),
      seg(8000, 8000, "zero length"),
      seg(9000, 9500, "   "),
      { type: "TranscriptSegment", start_ms: "abc", end_ms: "1", snippet: text("bad") },
      { type: "TranscriptSegment", start_ms: "10000", end_ms: "11000", snippet: null },
    ]);
    expect(out).toEqual([
      { start: 1, dur: 3.2, text: "first line" },
      { start: 4.2, dur: 3.1, text: "second" },
      { start: 8, dur: 0, text: "zero length" },
    ]);
  });

  it("handles null input", () => {
    expect(mapTranscriptSegments(null)).toEqual([]);
  });
});

describe("pickCaptionTrack", () => {
  it("prefers manual English over ASR English", () => {
    expect(pickCaptionTrack({ captions: { caption_tracks: tracks }, getTranscript: vi.fn() })?.language_code).toBe("en-GB");
  });

  it("falls back to ASR English, then the default track, then the first", () => {
    expect(
      pickCaptionTrack({ captions: { caption_tracks: tracks.slice(0, 2) }, getTranscript: vi.fn() })?.kind,
    ).toBe("asr");
    const nonEnglish: CaptionTrackLike[] = [
      { base_url: "https://www.youtube.com/a", language_code: "es" },
      { base_url: "https://www.youtube.com/b", language_code: "fr" },
    ];
    expect(
      pickCaptionTrack({
        captions: { caption_tracks: nonEnglish, audio_tracks: [{ default_caption_track_index: 1 }], default_audio_track_index: 0 },
        getTranscript: vi.fn(),
      })?.language_code,
    ).toBe("fr");
    expect(pickCaptionTrack({ captions: { caption_tracks: nonEnglish }, getTranscript: vi.fn() })?.language_code).toBe("es");
    expect(pickCaptionTrack({ captions: null, getTranscript: vi.fn() })).toBeNull();
  });
});

describe("safeTimedTextUrl", () => {
  it.each([
    ["https://www.youtube.com/api/timedtext?v=x", true],
    ["/api/timedtext?v=x", true],
    ["https://youtube.com/api/timedtext", true],
    ["http://www.youtube.com/api/timedtext", false],
    ["https://www.youtube.com.evil.com/api/timedtext", false],
    ["https://evil.com/?u=www.youtube.com", false],
    ["https://user@www.youtube.com/api/timedtext", false],
    ["javascript:alert(1)", false],
    ["https://169.254.169.254/latest/meta-data", false],
  ])("%s -> %s", (url, ok) => {
    expect(safeTimedTextUrl(url) !== null).toBe(ok);
  });
});

describe("youtubei transcript provider", () => {
  it("returns the English transcript from the panel, selecting it when the default differs", async () => {
    const ti = fakeTranscriptInfo(
      {
        Spanish: [seg(0, 2000, "hola")],
        "English (United Kingdom)": [seg(0, 2000, "hello"), seg(2000, 5000, "world")],
      },
      "Spanish",
    );
    const { client, getInfo } = fakeClient({ captions: { caption_tracks: tracks }, getTranscript: async () => ti });
    const provider = createYoutubeiTranscriptProvider({ getClient: async () => client, ...quiet });

    const result = await provider.fetch(VID);
    expect(getInfo).toHaveBeenCalledWith(VID);
    expect(ti.selectLanguage).toHaveBeenCalledWith("English (United Kingdom)");
    expect(result).toEqual({
      segments: [
        { start: 0, dur: 2, text: "hello" },
        { start: 2, dur: 3, text: "world" },
      ],
      lang: "en-GB",
      source: "youtubei",
    });
  });

  it("keeps the video's default language when no English exists", async () => {
    const ti = fakeTranscriptInfo({ German: [seg(500, 1500, "hallo")], French: [seg(0, 1, "x")] }, "German");
    const { client } = fakeClient({ getTranscript: async () => ti });
    const result = await createYoutubeiTranscriptProvider({ getClient: async () => client, ...quiet }).fetch(VID);
    expect(ti.selectLanguage).not.toHaveBeenCalled();
    expect(result).toEqual({ segments: [{ start: 0.5, dur: 1, text: "hallo" }], lang: "und", source: "youtubei" });
  });

  it("keeps the default transcript when selecting English fails", async () => {
    const ti = fakeTranscriptInfo({ Spanish: [seg(0, 1000, "hola")], English: [] }, "Spanish", { selectFails: true });
    const { client } = fakeClient({
      captions: { caption_tracks: [{ base_url: "/x", name: text("Spanish"), language_code: "es" }] },
      getTranscript: async () => ti,
    });
    const result = await createYoutubeiTranscriptProvider({ getClient: async () => client, ...quiet }).fetch(VID);
    expect(result?.segments.map((s) => s.text)).toEqual(["hola"]);
    expect(result?.lang).toBe("es");
  });

  it("falls back to the caption track (json3) when the panel fails", async () => {
    const { client } = fakeClient({ captions: { caption_tracks: tracks } });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("www.youtube.com");
      expect(url.searchParams.get("lang")).toBe("en-GB");
      expect(url.searchParams.get("fmt")).toBe("json3");
      return Response.json({ events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "from json3" }] }] });
    });
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => client,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...quiet,
    }).fetch(VID);
    expect(result).toEqual({ segments: [{ start: 0, dur: 1.5, text: "from json3" }], lang: "en-GB", source: "youtubei" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to XML when json3 is empty", async () => {
    const { client } = fakeClient({ captions: { caption_tracks: tracks.slice(0, 1) } });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("fmt") === "json3") return new Response("", { status: 200 });
      return new Response('<transcript><text start="1" dur="2">xml works</text></transcript>');
    });
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => client,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...quiet,
    }).fetch(VID);
    expect(result).toEqual({ segments: [{ start: 1, dur: 2, text: "xml works" }], lang: "es", source: "youtubei" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to fetch caption URLs outside youtube.com", async () => {
    const { client } = fakeClient({
      captions: { caption_tracks: [{ base_url: "https://evil.example/steal", language_code: "en" }] },
    });
    const fetchImpl = vi.fn();
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => client,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...quiet,
    }).fetch(VID);
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when there are no captions at all", async () => {
    const { client } = fakeClient({ captions: null });
    const log = vi.fn();
    const result = await createYoutubeiTranscriptProvider({ getClient: async () => client, log }).fetch(VID);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it("returns null when the panel is empty and the caption request fails", async () => {
    const ti = fakeTranscriptInfo({ English: [] }, "English");
    const { client } = fakeClient({ captions: { caption_tracks: tracks }, getTranscript: async () => ti });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => client,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...quiet,
    }).fetch(VID);
    expect(result).toBeNull();
  });

  it("returns null when the caption endpoint answers non-2xx, and logs the status", async () => {
    const { client } = fakeClient({ captions: { caption_tracks: tracks } });
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const log = vi.fn();
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => client,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
    }).fetch(VID);
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // a refused file is not asked for again in another format
    expect(log.mock.calls.flat().join(" ")).toMatch(/HTTP 403/);
  });

  it("returns null when the client cannot be created or getInfo throws", async () => {
    const p1 = createYoutubeiTranscriptProvider({ getClient: async () => Promise.reject(new Error("offline")), ...quiet });
    await expect(p1.fetch(VID)).resolves.toBeNull();
    const p2 = createYoutubeiTranscriptProvider({
      getClient: async () => ({ getInfo: async () => Promise.reject(new Error("This video is unavailable")) }),
      ...quiet,
    });
    await expect(p2.fetch(VID)).resolves.toBeNull();
  });

  it("returns null on timeout", async () => {
    const p = createYoutubeiTranscriptProvider({
      getClient: async () => ({ getInfo: () => new Promise<VideoInfoLike>(() => {}) }),
      timeoutMs: 20,
      ...quiet,
    });
    await expect(p.fetch(VID)).resolves.toBeNull();
  });

  it("rejects invalid video ids without calling the client", async () => {
    const getClient = vi.fn();
    const p = createYoutubeiTranscriptProvider({ getClient, ...quiet });
    await expect(p.fetch("../../etc")).resolves.toBeNull();
    await expect(p.fetch("")).resolves.toBeNull();
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("youtubei transcript provider: app clients first", () => {
  const json3 = (line: string) => Response.json({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: line }] }] });
  const blocked: VideoInfoLike = { captions: null, playability_status: { status: "UNPLAYABLE", reason: "The page needs to be reloaded." } };
  const withTracks: VideoInfoLike = { captions: { caption_tracks: tracks }, playability_status: { status: "OK" } };

  it("reads the caption track through the first app client and never touches the WEB path", async () => {
    const getBasicInfo = vi.fn(async () => withTracks);
    const getInfo = vi.fn();
    const fetchImpl = vi.fn(async () => json3("from the app client"));
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => ({ getInfo, getBasicInfo }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...quiet,
    }).fetch(VID);
    expect(result).toEqual({ segments: [{ start: 1, dur: 2, text: "from the app client" }], lang: "en-GB", source: "youtubei" });
    expect(getBasicInfo).toHaveBeenCalledTimes(1);
    expect(getBasicInfo).toHaveBeenCalledWith(VID, { client: CAPTION_CLIENTS[0] });
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("moves to the next app client when one is refused or throws", async () => {
    const getBasicInfo = vi
      .fn<(id: string, o?: { client?: string }) => Promise<VideoInfoLike>>()
      .mockResolvedValueOnce(blocked)
      .mockRejectedValueOnce(new Error("status code 400"))
      .mockResolvedValueOnce(withTracks);
    const fetchImpl = vi.fn(async () => json3("third time"));
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => ({ getInfo: vi.fn(), getBasicInfo }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...quiet,
    }).fetch(VID);
    expect(result?.segments[0].text).toBe("third time");
    expect(getBasicInfo.mock.calls.map((c) => c[1]?.client)).toEqual(CAPTION_CLIENTS.slice(0, 3));
  });

  it("stops at once when a client answers OK with no caption tracks", async () => {
    const getBasicInfo = vi.fn(async () => ({ captions: null, playability_status: { status: "OK" } }));
    const getInfo = vi.fn();
    const result = await createYoutubeiTranscriptProvider({ getClient: async () => ({ getInfo, getBasicInfo }), ...quiet }).fetch(VID);
    expect(result).toBeNull();
    expect(getBasicInfo).toHaveBeenCalledTimes(1);
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("tries the next client when a caption file cannot be fetched", async () => {
    const getBasicInfo = vi.fn(async () => withTracks);
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n <= 1 ? new Response("blocked", { status: 403 }) : json3("second client")));
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => ({ getInfo: vi.fn(), getBasicInfo }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...quiet,
    }).fetch(VID);
    expect(result?.segments[0].text).toBe("second client");
    expect(getBasicInfo).toHaveBeenCalledTimes(2);
  });

  describe("rate limits (HTTP 429 on a caption download)", () => {
    const limited = () => new Response("Too Many Requests", { status: 429 });
    /** A provider on a clock the test moves. */
    function setup(fetchImpl: () => Promise<Response>) {
      const clock = { t: 1_000_000 };
      const getBasicInfo = vi.fn(async () => withTracks);
      const getInfo = vi.fn();
      const fetchMock = vi.fn(fetchImpl);
      const log = vi.fn();
      const provider = createYoutubeiTranscriptProvider({
        getClient: async () => ({ getInfo, getBasicInfo }),
        fetchImpl: fetchMock as unknown as typeof fetch,
        log,
        now: () => clock.t,
      });
      return { clock, getBasicInfo, getInfo, fetchMock, log, provider };
    }
    const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { retryable?: boolean; retryAfterMs?: number; status?: number });

    it("is a retryable error, not 'no captions', and no other client or format is tried", async () => {
      const { provider, getBasicInfo, getInfo, fetchMock, log } = setup(async () => limited());
      const err = await caught(provider.fetch(VID));
      expect(err).toMatchObject({ retryable: true, status: 429, retryAfterMs: CAPTION_COOLDOWN_MS });
      expect(getBasicInfo).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getInfo).not.toHaveBeenCalled();
      expect(captionLimitRemainingMs(1_000_000)).toBe(CAPTION_COOLDOWN_MS);
      expect(log.mock.calls.flat().join(" ")).toMatch(/429.*No caption requests for 60 s/);
    });

    it("asks YouTube for nothing during the pause, for any video and any provider object", async () => {
      const a = setup(async () => limited());
      await caught(a.provider.fetch(VID));
      a.clock.t += 20_000;
      const err = await caught(a.provider.fetch("aaaaaaaaaaa"));
      expect(err).toMatchObject({ retryable: true, retryAfterMs: CAPTION_COOLDOWN_MS - 20_000 });
      const b = setup(async () => json3("never asked"));
      b.clock.t = a.clock.t;
      expect(await caught(b.provider.fetch(VID))).toMatchObject({ retryable: true });
      expect(a.getBasicInfo).toHaveBeenCalledTimes(1);
      expect(b.getBasicInfo).not.toHaveBeenCalled();
      expect(b.fetchMock).not.toHaveBeenCalled();
    });

    it("doubles the pause while YouTube keeps refusing, up to the cap, and starts over once it answers", async () => {
      let ok = false;
      const { provider, clock } = setup(async () => (ok ? json3("back") : limited()));
      const waits: number[] = [];
      for (let i = 0; i < 6; i++) {
        const err = await caught(provider.fetch(VID));
        waits.push(err!.retryAfterMs!);
        clock.t += err!.retryAfterMs!;
      }
      expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, CAPTION_COOLDOWN_MAX_MS, CAPTION_COOLDOWN_MAX_MS]);
      ok = true;
      expect((await provider.fetch(VID))?.segments[0].text).toBe("back");
      expect(captionLimitRemainingMs(clock.t)).toBe(0);
      ok = false;
      expect((await caught(provider.fetch(VID)))!.retryAfterMs).toBe(CAPTION_COOLDOWN_MS);
    });

    it("two videos refused at the same moment count as one refusal, and Retry-After is honoured", async () => {
      const { provider, clock } = setup(async () => new Response("slow down", { status: 429, headers: { "retry-after": "300" } }));
      const [e1, e2] = await Promise.all([caught(provider.fetch(VID)), caught(provider.fetch("bbbbbbbbbbb"))]);
      expect(e1!.retryAfterMs).toBe(300_000);
      expect(e2!.retryAfterMs).toBe(300_000);
      clock.t += 300_000;
      // the next refusal is the second one (120 s), not the third
      const again = setup(async () => limited());
      again.clock.t = clock.t;
      expect((await caught(again.provider.fetch(VID)))!.retryAfterMs).toBe(120_000);
    });

    it("the WEB fallback's caption request is covered too", async () => {
      const clock = { t: 5_000_000 };
      const { client } = fakeClient({ captions: { caption_tracks: tracks } });
      const provider = createYoutubeiTranscriptProvider({
        getClient: async () => client, // no getBasicInfo: straight to the WEB path
        fetchImpl: (async () => limited()) as unknown as typeof fetch,
        now: () => clock.t,
        ...quiet,
      });
      expect(await caught(provider.fetch(VID))).toMatchObject({ retryable: true, status: 429 });
    });
  });

  it("paces videos when asked to: one per gap, without sleeping for the first", async () => {
    const clock = { t: 0 };
    const sleeps: number[] = [];
    const provider = createYoutubeiTranscriptProvider({
      getClient: async () => ({ getInfo: vi.fn(), getBasicInfo: async () => withTracks }),
      fetchImpl: (async () => json3("line")) as unknown as typeof fetch,
      minGapMs: 1000,
      now: () => clock.t,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...quiet,
    });
    await Promise.all([provider.fetch(VID), provider.fetch("aaaaaaaaaaa"), provider.fetch("bbbbbbbbbbb")]);
    expect(sleeps).toEqual([1000, 2000]);
    clock.t = 10_000;
    await provider.fetch(VID);
    expect(sleeps).toEqual([1000, 2000]); // long after the last one: no wait
  });

  it("falls back to the WEB panel when every app client is refused, and logs why", async () => {
    const ti = fakeTranscriptInfo({ English: [seg(0, 2000, "from the panel")] }, "English");
    const getBasicInfo = vi.fn(async () => blocked);
    const getInfo = vi.fn(async () => ({ captions: null, getTranscript: async () => ti }));
    const log = vi.fn();
    const result = await createYoutubeiTranscriptProvider({ getClient: async () => ({ getInfo, getBasicInfo }), log }).fetch(VID);
    expect(result?.segments.map((s) => s.text)).toEqual(["from the panel"]);
    expect(getBasicInfo).toHaveBeenCalledTimes(CAPTION_CLIENTS.length);
    expect(log.mock.calls.flat().join(" ")).toMatch(/no app client returned captions.*UNPLAYABLE/);
  });

  it("returns null when the app clients and the WEB path all fail", async () => {
    const result = await createYoutubeiTranscriptProvider({
      getClient: async () => ({
        getBasicInfo: async () => blocked,
        getInfo: async () => Promise.reject(new Error("This video is unavailable")),
      }),
      ...quiet,
    }).fetch(VID);
    expect(result).toBeNull();
  });
});
