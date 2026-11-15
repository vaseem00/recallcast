import { describe, expect, it } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import {
  AiOutputError,
  AiPermanentError,
  AiRefusalError,
  RetryableError,
  classifyAnthropicError,
  isRetryableError,
  retryAfterFromHeaders,
} from "./errors";

const apiErr = (status: number, headers: Record<string, string> = {}) =>
  APIError.generate(status, { error: { type: "error", message: `boom ${status}` } }, `boom ${status}`, new Headers(headers));

describe("classifyAnthropicError", () => {
  it("rate limits are retryable and carry retry-after", () => {
    const e = classifyAnthropicError(apiErr(429, { "retry-after": "7" }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).retryAfterMs).toBe(7000);
    expect((e as RetryableError).status).toBe(429);
    expect(isRetryableError(e)).toBe(true);
  });

  it("prefers retry-after-ms", () => {
    const e = classifyAnthropicError(apiErr(429, { "retry-after-ms": "1500", "retry-after": "9" })) as RetryableError;
    expect(e.retryAfterMs).toBe(1500);
  });

  it("connection errors and timeouts are retryable", () => {
    expect(classifyAnthropicError(new APIConnectionError({ message: "ECONNRESET" }))).toBeInstanceOf(RetryableError);
    expect(classifyAnthropicError(new APIConnectionTimeoutError())).toBeInstanceOf(RetryableError);
  });

  it.each([500, 502, 503, 504, 529])("HTTP %i is retryable", (status) => {
    expect(classifyAnthropicError(apiErr(status))).toBeInstanceOf(RetryableError);
  });

  it("408 is retryable, 501 is permanent", () => {
    expect(classifyAnthropicError(apiErr(408))).toBeInstanceOf(RetryableError);
    expect(classifyAnthropicError(apiErr(501))).toBeInstanceOf(AiPermanentError);
  });

  it.each([400, 401, 403, 404, 413, 422])("HTTP %i is permanent", (status) => {
    const e = classifyAnthropicError(apiErr(status));
    expect(e).toBeInstanceOf(AiPermanentError);
    expect((e as AiPermanentError).retryable).toBe(false);
    expect((e as AiPermanentError).status).toBe(status);
    expect(isRetryableError(e)).toBe(false);
  });

  it("adds actionable hints for auth and model errors", () => {
    expect((classifyAnthropicError(apiErr(401)) as Error).message).toMatch(/ANTHROPIC_API_KEY/);
    expect((classifyAnthropicError(apiErr(404)) as Error).message).toMatch(/CLAUDE_MODEL/);
  });

  it("user aborts are permanent", () => {
    expect(classifyAnthropicError(new APIUserAbortError())).toBeInstanceOf(AiPermanentError);
  });

  it("passes non-SDK errors and already-classified errors through unchanged", () => {
    const plain = new Error("x");
    expect(classifyAnthropicError(plain)).toBe(plain);
    const r = new RetryableError("r");
    expect(classifyAnthropicError(r)).toBe(r);
    const o = new AiOutputError("t", ["p"]);
    expect(classifyAnthropicError(o)).toBe(o);
  });
});

describe("error classes", () => {
  it("refusal and output errors are permanent with readable messages", () => {
    const r = new AiRefusalError("bio", null);
    expect(r).toBeInstanceOf(AiPermanentError);
    expect(r.retryable).toBe(false);
    expect(r.category).toBe("bio");
    expect(r.message).toMatch(/declined.*bio/);
    const o = new AiOutputError("episode script", ["got 1 turn"]);
    expect(o.message).toMatch(/episode script.*got 1 turn/);
    expect(o.problems).toEqual(["got 1 turn"]);
  });
});

describe("retryAfterFromHeaders", () => {
  it("parses HTTP dates and ignores garbage", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }), now)).toBe(5000);
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "soon" }), now)).toBeNull();
    expect(retryAfterFromHeaders(undefined)).toBeNull();
  });
});
