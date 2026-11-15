import { describe, expect, it } from "vitest";
import { RetryableError } from "@/lib/errors";
import type { TranscriptSegment, VideoMeta } from "@/lib/types";
import {
  DEFAULT_MAX_TOKENS,
  FALLBACK_BETA,
  createAnthropicProvider,
  type AnthropicProviderOptions,
  type ClaudeClient,
  type ClaudeResponse,
  type ParseParams,
} from "./anthropic";
import { CLIP_MAX_S } from "./clip";
import { AiInputError, AiOutputError, AiRefusalError } from "./errors";
import { MOMENTS_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts";

/**
 * The Claude provider against a fake client: no network, no API key. The fake runs the
 * request's output_config.format.parse() on each scripted reply, as the SDK's messages.parse does.
 */

const video: VideoMeta = {
  youtubeVideoId: "vidCLAUDE01",
  title: "How memory works",
  channel: "Brain Lab",
  durationS: 1200,
  thumbnail: "",
  position: 0,
};

const segments: TranscriptSegment[] = Array.from({ length: 240 }, (_, i) => ({
  start: i * 5,
  dur: 5,
  text: `Caption ${i} about spaced retrieval practice.`,
}));

type Reply =
  | { text: string; stop_reason?: string; model?: string }
  | { refusal: true; category?: string; explanation?: string }
  | { stop_reason: string }
  | { throws: unknown };

const answer = (start: number, end: number, title = "The forgetting curve") =>
  ({ text: JSON.stringify({ start, end, title, summary: "Why memories fade.", reason: "It is the core idea." }) }) as const;

function fakeClient(replies: Reply[]) {
  const calls: ParseParams[] = [];
  const client: ClaudeClient & { calls: ParseParams[] } = {
    calls,
    beta: {
      messages: {
        async parse(params: ParseParams): Promise<ClaudeResponse> {
          calls.push(params);
          const r = replies.shift();
          if (!r) throw new Error("unexpected extra API call");
          if ("throws" in r) throw r.throws;
          const usage = { input_tokens: 10, output_tokens: 5 };
          if ("refusal" in r) {
            return {
              stop_reason: "refusal",
              stop_details: { category: r.category ?? null, explanation: r.explanation ?? null },
              content: [],
              parsed_output: null,
              usage,
            };
          }
          if (!("text" in r)) return { stop_reason: r.stop_reason, content: [], parsed_output: null, usage };
          const format = params.output_config?.format as unknown as { parse(s: string): unknown };
          return {
            model: r.model ?? params.model,
            stop_reason: r.stop_reason ?? "end_turn",
            content: [{ type: "text", text: r.text }],
            parsed_output: format.parse(r.text),
            usage,
          };
        },
      },
    },
  };
  return client;
}

const quiet = { warn: () => {}, info: () => {} };

function provider(replies: Reply[], opts: Partial<AnthropicProviderOptions> = {}) {
  const client = fakeClient(replies);
  const ai = createAnthropicProvider({ client, model: "claude-haiku-5-5", effort: "medium", logger: quiet, ...opts });
  return { ai, client };
}

describe("request shape", () => {
  it("sends one structured-output request with a cached system block, explicit effort and no thinking", async () => {
    const usage: unknown[] = [];
    const { ai, client } = provider([answer(100, 310)], { onUsage: (e) => usage.push(e) });
    await ai.pickClip({ video, segments });
    expect(client.calls).toHaveLength(1);
    const p = client.calls[0];
    const format = p.output_config?.format as unknown as { type: string; schema: { properties: Record<string, unknown> } };
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(p.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(p.output_config?.effort).toBe("medium");
    expect(format.type).toBe("json_schema");
    expect(Object.keys(format.schema.properties).sort()).toEqual(["end", "reason", "start", "summary", "title"]);
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("fallbacks");
    expect(p).not.toHaveProperty("betas");
    expect(p).not.toHaveProperty("stream");

    expect(p.messages).toHaveLength(1);
    const msg = p.messages[0] as { role: string; content: string };
    expect(msg.role).toBe("user");
    expect(msg.content).toContain("title: How memory works");
    expect(msg.content).toContain("duration: 20:00");
    expect(msg.content).toContain("<transcript>\n[00:00] Caption 0");
    expect(msg.content).toContain("[01:40] Caption 20");
    expect(SYSTEM_PROMPT).not.toContain("How memory works"); // per-request data never goes into the cached prefix

    expect(usage).toEqual([{ task: "clip pick", model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 } }]);
  });

  it("adds server-side refusal fallbacks only for models that support them", async () => {
    const opus = provider([answer(100, 310)], { model: "claude-opus-5-5" });
    await opus.ai.pickClip({ video, segments });
    expect(opus.client.calls[0]).toMatchObject({ betas: [FALLBACK_BETA], fallbacks: "default" });

    const off = provider([answer(100, 310)], { model: "claude-opus-5-5", refusalFallback: false });
    await off.ai.pickClip({ video, segments });
    expect(off.client.calls[0]).not.toHaveProperty("fallbacks");
  });

  it("honours maxTokens and effort options", async () => {
    const { ai, client } = provider([answer(100, 310)], { maxTokens: 4000, effort: "low" });
    await ai.pickClip({ video, segments });
    expect(client.calls[0]).toMatchObject({ max_tokens: 4000, output_config: { effort: "low" } });
  });
});

describe("pickClip", () => {
  it("plays a short video in full without any API call", async () => {
    const { ai, client } = provider([]);
    const short = segments.slice(0, 40); // 200 s
    const clip = await ai.pickClip({ video: { ...video, durationS: 200 }, segments: short });
    expect(client.calls).toHaveLength(0);
    expect(clip).toMatchObject({ start: 0, end: 200, picked: "whole" });
  });

  it("normalizes a valid answer (caption-snapped) without a repair", async () => {
    const { ai, client } = provider([answer(100.7, 310)]);
    const clip = await ai.pickClip({ video, segments });
    expect(client.calls).toHaveLength(1);
    expect(clip).toEqual({
      start: 100,
      end: 315,
      title: "The forgetting curve",
      summary: "Why memories fade.",
      reason: "It is the core idea.",
      picked: "ai",
    });
  });

  it("an out-of-range answer gets exactly one repair, and the repaired answer is used", async () => {
    const { ai, client } = provider([answer(100, 700), answer(400, 610, "Sleep and memory")]);
    const clip = await ai.pickClip({ video, segments });
    expect(client.calls).toHaveLength(2);
    expect(clip).toMatchObject({ start: 400, end: 615, title: "Sleep and memory", picked: "ai" });

    const repair = client.calls[1].messages as { role: string; content: string }[];
    expect(repair.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repair[0].content).toBe((client.calls[0].messages[0] as { content: string }).content);
    expect(repair[1].content).toContain('"end":700');
    expect(repair[2].content).toContain(`longer than ${CLIP_MAX_S}`);
  });

  it("keeps the adjusted first answer when the repair is worse", async () => {
    // second answer: reversed and too close to the end (two problems vs one)
    const { ai, client } = provider([answer(100, 700), answer(1150, 1100, "Worse")]);
    const clip = await ai.pickClip({ video, segments });
    expect(client.calls).toHaveLength(2);
    expect(clip).toMatchObject({ start: 100, end: 315, title: "The forgetting curve", picked: "ai" });
  });

  it("keeps the adjusted first answer when the repair call itself fails", async () => {
    const { ai, client } = provider([answer(100, 700), { throws: new RetryableError("overloaded") }]);
    const clip = await ai.pickClip({ video, segments });
    expect(client.calls).toHaveLength(2);
    expect(clip).toMatchObject({ start: 100, end: 315 });
  });

  it("repairs unparseable output once, resending the prompt with the problem", async () => {
    const { ai, client } = provider([{ text: "not json" }, answer(200, 410)]);
    const clip = await ai.pickClip({ video, segments });
    expect(clip).toMatchObject({ start: 200, end: 415, picked: "ai" });
    const msgs = client.calls[1].messages as { role: string; content: { type: string; text: string }[] }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toHaveLength(2);
    expect(msgs[0].content[1].text).toMatch(/not complete, valid JSON/);
    expect(msgs[0].content[1].text).toContain("not valid JSON");
  });

  it("treats a cut-off answer (max_tokens) as invalid and repairs it", async () => {
    const { ai, client } = provider([{ text: '{"start": 1', stop_reason: "max_tokens" }, answer(200, 410)]);
    expect(await ai.pickClip({ video, segments })).toMatchObject({ start: 200 });
    expect(client.calls).toHaveLength(2);
  });

  it("throws AiOutputError when the repair is invalid too", async () => {
    const { ai, client } = provider([{ text: "{}" }, { text: '{"start":"soon"}' }]);
    await expect(ai.pickClip({ video, segments })).rejects.toBeInstanceOf(AiOutputError);
    expect(client.calls).toHaveLength(2);
  });

  it("a refusal throws AiRefusalError without a repair", async () => {
    const { ai, client } = provider([{ refusal: true, category: "cyber" }]);
    const err = await ai.pickClip({ video, segments }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRefusalError);
    expect((err as AiRefusalError).category).toBe("cyber");
    expect((err as AiRefusalError).retryable).toBe(false);
    expect(client.calls).toHaveLength(1);
  });

  it("a context-window overflow is an input error", async () => {
    const { ai } = provider([{ stop_reason: "model_context_window_exceeded" }]);
    await expect(ai.pickClip({ video, segments })).rejects.toBeInstanceOf(AiInputError);
  });

  it("a transcript over maxTranscriptChars throws AiInputError without any API call", async () => {
    const { ai, client } = provider([], { maxTranscriptChars: 500 });
    await expect(ai.pickClip({ video, segments })).rejects.toThrow(AiInputError);
    await expect(ai.pickClip({ video, segments })).rejects.toThrow(/too long/);
    expect(client.calls).toHaveLength(0);
  });

  it("an empty transcript throws AiInputError", async () => {
    const { ai, client } = provider([]);
    await expect(ai.pickClip({ video, segments: [{ start: 0, dur: 1, text: "   " }] })).rejects.toBeInstanceOf(AiInputError);
    expect(client.calls).toHaveLength(0);
  });

  it("retryable errors from the client propagate", async () => {
    const { ai } = provider([{ throws: new RetryableError("Claude API rate limit reached; will retry.", { status: 429 }) }]);
    const err = await ai.pickClip({ video, segments }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryable).toBe(true);
  });
});

describe("pickMoments (reels)", () => {
  const moments = (...list: Array<[start: number, end: number, hook?: string]>) =>
    ({
      text: JSON.stringify({
        moments: list.map(([start, end, hook = `Moment at ${start}`]) => ({ start, end, hook, takeaway: "The point it makes." })),
      }),
    }) as const;

  it("sends the reels task: its own cached system prompt, the moments schema and a finer transcript", async () => {
    const { ai, client } = provider([moments([100, 160], [600, 655])]);
    const out = await ai.pickMoments({ video, segments, count: 4 });
    expect(out).toEqual([
      { start: 100, end: 160, hook: "Moment at 100", takeaway: "The point it makes.", picked: "ai" },
      { start: 600, end: 655, hook: "Moment at 600", takeaway: "The point it makes.", picked: "ai" },
    ]);
    expect(client.calls).toHaveLength(1);
    const p = client.calls[0];
    const format = p.output_config?.format as unknown as { type: string; schema: { properties: Record<string, unknown> } };
    expect(p.system).toEqual([{ type: "text", text: MOMENTS_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(MOMENTS_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    expect(Object.keys(format.schema.properties)).toEqual(["moments"]);
    expect(p.output_config?.effort).toBe("medium");
    expect(p).not.toHaveProperty("thinking");
    const prompt = String(p.messages[0].content);
    expect(prompt).toMatch(/choose up to 4 of the strongest self-contained moments/);
    expect(prompt).toMatch(/between 30 and 80 seconds/);
    // 10-second blocks: a marker every other 5-second caption, where the clip pick has one per four.
    expect(prompt).toContain("[00:10] Caption 2");
    expect(prompt).toContain("[00:20] Caption 4");
    expect(prompt).toContain("<transcript>");
  });

  it("keeps the usable moments of a partly usable answer without a second call", async () => {
    const { ai, client } = provider([moments([100, 160, "Good"], [120, 170, "Overlaps the first"], [5000, 5060, "Past the end"], [300, 310, "Too short, fixed"])]);
    const out = await ai.pickMoments({ video, segments, count: 6 });
    expect(out.map((m) => m.hook)).toEqual(["Good", "Too short, fixed"]);
    expect(out[1].end - out[1].start).toBe(60);
    expect(client.calls).toHaveLength(1);
  });

  it("never returns more than was asked for", async () => {
    const { ai } = provider([moments([0, 60], [100, 160], [200, 260], [300, 360])]);
    expect(await ai.pickMoments({ video, segments, count: 2 })).toHaveLength(2);
  });

  it("asks once more when nothing in the answer is usable, quoting the problems", async () => {
    const { ai, client } = provider([moments([5000, 5060]), moments([200, 255, "Second try"])]);
    const out = await ai.pickMoments({ video, segments, count: 3 });
    expect(out.map((m) => m.hook)).toEqual(["Second try"]);
    expect(client.calls).toHaveLength(2);
    const repair = client.calls[1].messages;
    expect(repair).toHaveLength(3);
    expect(repair[1].role).toBe("assistant");
    expect(String(repair[2].content)).toMatch(/None of the moments in your previous answer could be used/);
    expect(String(repair[2].content)).toMatch(/last 30 seconds/);
  });

  it("repairs an answer that is not valid JSON, then gives up with AiOutputError", async () => {
    const ok = provider([{ text: "not json" }, moments([60, 120])]);
    expect(await ok.ai.pickMoments({ video, segments, count: 2 })).toHaveLength(1);
    expect(ok.client.calls[1].messages).toHaveLength(1);
    expect(JSON.stringify(ok.client.calls[1].messages[0].content)).toMatch(/not complete, valid JSON/);

    const bad = provider([{ text: "not json" }, { text: JSON.stringify({ moments: [] }) }]);
    const err = await bad.ai.pickMoments({ video, segments, count: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiOutputError);
    expect(bad.client.calls).toHaveLength(2);
  });

  it("a refusal, an oversized transcript and an empty transcript are permanent errors", async () => {
    const refused = provider([{ refusal: true, category: "cyber" }]);
    await expect(refused.ai.pickMoments({ video, segments, count: 2 })).rejects.toBeInstanceOf(AiRefusalError);
    const tooLong = provider([], { maxTranscriptChars: 500 });
    await expect(tooLong.ai.pickMoments({ video, segments, count: 2 })).rejects.toThrow(/too long/);
    expect(tooLong.client.calls).toHaveLength(0);
    const empty = provider([]);
    await expect(empty.ai.pickMoments({ video, segments: [], count: 2 })).rejects.toBeInstanceOf(AiInputError);
  });

  it("retryable errors propagate, also from the repair call", async () => {
    const rate = () => new RetryableError("Claude API rate limit reached; will retry.", { status: 429 });
    const first = provider([{ throws: rate() }]);
    await expect(first.ai.pickMoments({ video, segments, count: 2 })).rejects.toBeInstanceOf(RetryableError);
    const second = provider([{ text: "not json" }, { throws: rate() }]);
    await expect(second.ai.pickMoments({ video, segments, count: 2 })).rejects.toBeInstanceOf(RetryableError);
  });

  it("a video of about a minute is one whole reel with no API call", async () => {
    const { ai, client } = provider([]);
    const short = { ...video, durationS: 60 };
    const out = await ai.pickMoments({ video: short, segments: segments.slice(0, 12), count: 3 });
    expect(out).toEqual([expect.objectContaining({ start: 0, end: 60, picked: "whole" })]);
    expect(client.calls).toHaveLength(0);
  });
});
