import "server-only";
import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ClipPlan } from "@/lib/types";
import { isShortVideo, normalizeClip, wholeVideoClip } from "./clip";
import { AiInputError, AiOutputError, AiRefusalError, classifyAnthropicError } from "./errors";
import { MAX_REELS_PER_VIDEO, MOMENT_BLOCK_SECONDS, isReelLengthVideo, normalizeMoments, wholeMoment } from "./moments";
import { MOMENTS_SYSTEM_PROMPT, SYSTEM_PROMPT, clipPrompt, momentsPrompt, momentsRepairPrompt, repairPrompt } from "./prompts";
import type { AiProvider } from "./provider";
import { WireClipSchema, WireMomentsSchema, type WireClip } from "./schemas";
import { MAX_TRANSCRIPT_CHARS, cleanCaptionText, formatTranscript } from "./transcript";

/**
 * Claude-backed AiProvider: two small structured-output calls per long video, one for the
 * episode ("clip pick") and one for its reels ("moment pick"). Each task has its own frozen
 * system prompt and output schema; everything below applies to both.
 *
 * Request shape:
 *  - client.beta.messages.parse with output_config.format from betaZodOutputFormat (structured outputs)
 *  - output_config.effort set explicitly (CLAUDE_EFFORT)
 *  - no `thinking` field: adaptive thinking is the default on current models, and
 *    `budget_tokens` returns a 400 on them
 *  - non-streaming, max_tokens 16000 (room for thinking + a short JSON object)
 *  - one stable system block with cache_control: ephemeral
 *  - server-side refusal fallbacks (fallbacks "default" + beta) only on models documented to
 *    accept them; Haiku does not, so they are off by default for the default model
 *  - stop_reason is checked before any output is read
 *
 * Output handling: normalizeClip (clip.ts) clamps and snaps the window; if it had to change
 * anything, one repair call is made and the better of the two answers is kept.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ParseParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The slice of an SDK response this module reads. */
export interface ClaudeResponse {
  model?: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content: Array<{ type: string; text?: string }>;
  parsed_output: unknown;
  usage?: unknown;
}

/** Minimal client surface, so tests can inject a fake. A real `new Anthropic()` satisfies it. */
export interface ClaudeClient {
  beta: { messages: { parse(params: ParseParams): PromiseLike<ClaudeResponse> } };
}

export interface AnthropicProviderOptions {
  client: ClaudeClient;
  model: string;
  effort: Effort;
  /** Default 16000. */
  maxTokens?: number;
  /** Server-side refusal fallbacks. Default: on for models that support them. */
  refusalFallback?: boolean;
  /** Formatted transcripts longer than this are rejected (the pipeline then uses the heuristic). */
  maxTranscriptChars?: number;
  logger?: Pick<Console, "warn" | "info">;
  /** Called after every API response (cost observability). */
  onUsage?: (event: { task: string; model: string; usage: unknown }) => void;
}

export const DEFAULT_MAX_TOKENS = 16_000;
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models documented to accept `fallbacks: "default"` on the Claude API. */
export const FALLBACK_CAPABLE_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export function createAnthropicClient(apiKey: string): ClaudeClient {
  // maxRetries covers quick in-request retries; the job queue does the longer backoff.
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
}

type ParseOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * betaZodOutputFormat, but with a parse() that never throws: the SDK calls parse() inside
 * messages.parse, and a throw there would hide stop_reason (refusal / max_tokens) from us.
 */
export function safeOutputFormat<S extends z.ZodType>(schema: S) {
  const base = betaZodOutputFormat(schema);
  return {
    type: base.type,
    schema: base.schema,
    parse(content: string): ParseOutcome<z.infer<S>> {
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        return { ok: false, error: "The output was not valid JSON." };
      }
      const result = schema.safeParse(json);
      if (result.success) return { ok: true, data: result.data };
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `The JSON did not match the schema: ${issues}` };
    },
  };
}

type CallResult<T> = { kind: "ok"; data: T; text: string } | { kind: "invalid"; reason: string };
type Message = Anthropic.Beta.Messages.BetaMessageParam;

export function createAnthropicProvider(opts: AnthropicProviderOptions): AiProvider {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxTranscriptChars = opts.maxTranscriptChars ?? MAX_TRANSCRIPT_CHARS;
  const logger = opts.logger ?? console;
  let useFallbacks = opts.refusalFallback ?? FALLBACK_CAPABLE_MODELS.has(opts.model);

  /** One request = one task: its frozen system prompt (cached) and its output schema. */
  interface Task<S extends z.ZodType> {
    name: string;
    system: string;
    schema: S;
  }

  function buildParams(system: string, format: ReturnType<typeof safeOutputFormat>, messages: Message[]): ParseParams {
    const params: ParseParams = {
      model: opts.model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      output_config: { effort: opts.effort, format },
    };
    if (useFallbacks) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = "default";
    }
    return params;
  }

  async function send(task: string, system: string, format: ReturnType<typeof safeOutputFormat>, messages: Message[]) {
    try {
      return await opts.client.beta.messages.parse(buildParams(system, format, messages));
    } catch (err) {
      // If this account/model rejects the fallbacks parameter, drop it once and carry on without it.
      if (useFallbacks && err instanceof BadRequestError && /fallback/i.test(err.apiMessage ?? err.message)) {
        logger.warn(`[ai] server-side refusal fallbacks rejected by the API (${task}); continuing without them.`);
        useFallbacks = false;
        try {
          return await opts.client.beta.messages.parse(buildParams(system, format, messages));
        } catch (retryErr) {
          throw classifyAnthropicError(retryErr);
        }
      }
      throw classifyAnthropicError(err);
    }
  }

  async function callOnce<S extends z.ZodType>(
    job: Task<S>,
    messages: Message[],
    attempt = "",
  ): Promise<CallResult<z.infer<S>>> {
    const task = `${job.name}${attempt}`;
    const format = safeOutputFormat(job.schema);
    const res = await send(task, job.system, format, messages);
    opts.onUsage?.({ task, model: res.model ?? opts.model, usage: res.usage });
    if (res.model && res.model !== opts.model) {
      logger.info(`[ai] ${task} was served by fallback model ${res.model}.`);
    }

    // Check stop_reason before reading any output.
    if (res.stop_reason === "refusal") {
      throw new AiRefusalError(res.stop_details?.category ?? null, res.stop_details?.explanation ?? null);
    }
    if (res.stop_reason === "model_context_window_exceeded") {
      throw new AiInputError(`The input for ${task} is too large for the model's context window.`);
    }
    const textBlock = res.content.find((b) => b.type === "text" && typeof b.text === "string");
    const text = textBlock?.text ?? "";
    if (res.stop_reason === "max_tokens") {
      return { kind: "invalid", reason: "The output was cut off at the token limit." };
    }
    const outcome = res.parsed_output as ParseOutcome<z.infer<S>> | null | undefined;
    if (!outcome) return { kind: "invalid", reason: "The response contained no JSON output." };
    if (!outcome.ok) return { kind: "invalid", reason: outcome.error };
    return { kind: "ok", data: outcome.data, text };
  }

  const CLIP_TASK: Task<typeof WireClipSchema> = { name: "clip pick", system: SYSTEM_PROMPT, schema: WireClipSchema };
  const MOMENTS_TASK: Task<typeof WireMomentsSchema> = {
    name: "moment pick",
    system: MOMENTS_SYSTEM_PROMPT,
    schema: WireMomentsSchema,
  };

  return {
    async pickMoments({ video, segments, count }) {
      const segs = (segments ?? []).filter((s) => cleanCaptionText(s.text).length > 0);
      if (!segs.length) throw new AiInputError("The transcript is empty, so there is nothing to choose from.");
      const ctx = { video, segments: segs };
      if (isReelLengthVideo(ctx)) return [wholeMoment(ctx)];
      const wanted = Math.max(1, Math.min(MAX_REELS_PER_VIDEO, Math.floor(Number(count) || 1)));

      // Shorter blocks than the clip pick: a reel has to start on its first sentence.
      const transcriptText = formatTranscript(segs, { maxBlockSeconds: MOMENT_BLOCK_SECONDS });
      if (transcriptText.length > maxTranscriptChars) {
        throw new AiInputError(`The transcript is too long to analyze (${transcriptText.length} characters).`);
      }
      const task = MOMENTS_TASK.name;
      const userPrompt = momentsPrompt({ video, transcriptText, count: wanted });
      const first: Message[] = [{ role: "user", content: userPrompt }];
      const a = await callOnce(MOMENTS_TASK, first);

      // Unlike the single clip, a partly usable answer is kept as it is: the moments that
      // normalize are stored and the rest are dropped. Only an answer with nothing usable
      // (or no JSON at all) earns the one repair call.
      let repairMessages: Message[];
      let problems: string[];
      if (a.kind === "ok") {
        const got = normalizeMoments(a.data.moments, ctx, "ai", wanted);
        if (got.moments.length > 0) {
          if (got.notes.length) logger.info(`[ai] ${task}: kept ${got.moments.length} moment(s); adjusted: ${got.notes.join("; ")}`);
          return got.moments;
        }
        problems = got.notes.length ? got.notes : ["the list of moments was empty"];
        repairMessages = [
          ...first,
          { role: "assistant", content: a.text },
          { role: "user", content: momentsRepairPrompt(problems, false) },
        ];
      } else {
        problems = [a.reason];
        repairMessages = [
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "text", text: momentsRepairPrompt(problems, true) },
            ],
          },
        ];
      }

      const b = await callOnce(MOMENTS_TASK, repairMessages, " (repair)");
      if (b.kind === "ok") {
        const got = normalizeMoments(b.data.moments, ctx, "ai", wanted);
        if (got.moments.length > 0) return got.moments;
        throw new AiOutputError(task, got.notes.length ? got.notes : ["the list of moments was empty"]);
      }
      throw new AiOutputError(task, [b.reason]);
    },

    async pickClip({ video, segments }) {
      const segs = (segments ?? []).filter((s) => cleanCaptionText(s.text).length > 0);
      if (!segs.length) throw new AiInputError("The transcript is empty, so there is nothing to choose from.");
      const ctx = { video, segments: segs };
      if (isShortVideo(ctx)) return wholeVideoClip(ctx);

      const transcriptText = formatTranscript(segs);
      if (transcriptText.length > maxTranscriptChars) {
        throw new AiInputError(`The transcript is too long to analyze (${transcriptText.length} characters).`);
      }
      const task = CLIP_TASK.name;
      const userPrompt = clipPrompt({ video, transcriptText });
      const first: Message[] = [{ role: "user", content: userPrompt }];
      const a = await callOnce(CLIP_TASK, first);

      let firstClip: { clip: ClipPlan; notes: string[] } | null = null;
      let repairMessages: Message[];
      if (a.kind === "ok") {
        firstClip = normalizeClip(a.data, ctx, "ai");
        if (firstClip.notes.length === 0) return firstClip.clip;
        repairMessages = [
          ...first,
          { role: "assistant", content: a.text },
          { role: "user", content: repairPrompt(firstClip.notes, false) },
        ];
      } else {
        repairMessages = [
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "text", text: repairPrompt([a.reason], true) },
            ],
          },
        ];
      }

      let b: CallResult<WireClip>;
      try {
        b = await callOnce(CLIP_TASK, repairMessages, " (repair)");
      } catch (err) {
        if (firstClip) {
          logger.warn(`[ai] ${task}: repair attempt failed (${errMessage(err)}); keeping the adjusted first answer.`);
          return firstClip.clip;
        }
        throw err;
      }
      if (b.kind === "ok") {
        const second = normalizeClip(b.data, ctx, "ai");
        if (!firstClip || second.notes.length <= firstClip.notes.length) {
          if (second.notes.length) logger.warn(`[ai] ${task}: accepted after repair with adjustments: ${second.notes.join("; ")}`);
          return second.clip;
        }
        logger.warn(`[ai] ${task}: repair did not help; keeping the adjusted first answer (${firstClip.notes.join("; ")}).`);
        return firstClip.clip;
      }
      if (firstClip) return firstClip.clip;
      throw new AiOutputError(task, [b.reason]);
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
