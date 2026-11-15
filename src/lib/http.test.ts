import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError, parseJson } from "./http";

const Schema = z.object({ a: z.number() });

function streamingRequest(chunk: Uint8Array, maxChunks: number, headers: Record<string, string> = {}) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= maxChunks) return controller.close();
      pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
  return { req, pulled: () => pulled, cancelled: () => cancelled };
}

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe("parseJson body limit", () => {
  it("parses a small JSON body", async () => {
    const req = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    await expect(parseJson(req, Schema, { maxBytes: 100 })).resolves.toEqual({ a: 1 });
  });

  // Before the fix parseJson called req.text() and checked the size afterwards, so the whole
  // body (any size) was buffered first. Now a streamed body is cut off just past maxBytes.
  it("stops reading a chunked body as soon as it passes maxBytes (413) and cancels the stream", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const s = streamingRequest(chunk, 100_000); // would be ~6.5 GB if read in full
    expect(await status(parseJson(s.req, Schema, { maxBytes: 10_000 }))).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(3);
    expect(s.cancelled()).toBe(true);
  });

  it("refuses a declared Content-Length above maxBytes without reading the body", async () => {
    const s = streamingRequest(new Uint8Array(10).fill(0x20), 5, { "content-length": "999999999" });
    expect(await status(parseJson(s.req, Schema, { maxBytes: 10_000 }))).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(1); // the stream may prime one chunk, never more
  });

  it("decodes multi-byte UTF-8 split across chunks and accepts a body exactly at the limit", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ a: 1, s: "héllo ✓" }));
    const half = Math.floor(bytes.length / 2);
    const parts = [bytes.slice(0, half), bytes.slice(half)];
    const req = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          parts.forEach((p) => c.enqueue(p));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const out = await parseJson(req, z.object({ a: z.number(), s: z.string() }), { maxBytes: bytes.length });
    expect(out).toEqual({ a: 1, s: "héllo ✓" });
  });
});
