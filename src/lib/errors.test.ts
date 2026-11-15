import { describe, expect, it } from "vitest";
import { RetryableError, isRetryableError } from "@/lib/errors";
import { RetryableError as AiRetryableError } from "@/lib/ai/errors";
import { JobRetryableError, PipelineError, isRetryable, retryAfterOf } from "@/lib/jobs/errors";
import { YouTubeError } from "@/lib/youtube/errors";

describe("shared RetryableError", () => {
  it("is one class across ai and jobs", () => {
    expect(AiRetryableError).toBe(RetryableError);
    const job = new JobRetryableError("busy", { retryAfterMs: 200 });
    expect(job).toBeInstanceOf(RetryableError);
    expect(isRetryableError(job)).toBe(true);
    expect(job.name).toBe("JobRetryableError");
  });

  it("drives the worker's retry decision through the retryable flag", () => {
    expect(isRetryable(new RetryableError("x"))).toBe(true);
    expect(isRetryable(new YouTubeError("network", "x"))).toBe(true);
    expect(isRetryable(new YouTubeError("quota", "x"))).toBe(false);
    expect(isRetryable(new PipelineError("x"))).toBe(false);
    expect(isRetryable(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(retryAfterOf(new RetryableError("x", { retryAfterMs: 1500 }))).toBe(1500);
    expect(retryAfterOf(new RetryableError("x"))).toBeNull();
  });
});
