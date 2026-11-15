import "server-only";
import type { z } from "zod";

/**
 * Small helpers for JSON route handlers.
 *
 * Pattern:
 *   export const runtime = "nodejs";
 *   export async function POST(req: Request) {
 *     try {
 *       assertSameOrigin(req);               // from @/lib/auth
 *       const user = await requireUser();    // from @/lib/auth
 *       const body = await parseJson(req, Schema);
 *       return json({ ok: true }, 201);
 *     } catch (err) {
 *       return handleError(err);
 *     }
 *   }
 */

/** Error carrying an HTTP status; throw it anywhere and let handleError() turn it into a response. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json<T>(data: T, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  if (!h.has("content-type")) h.set("content-type", "application/json; charset=utf-8");
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

/** `{ error: msg }` with the given status. */
export function error(status: number, msg: string, headers?: HeadersInit): Response {
  return json({ error: msg }, status, headers);
}

/** 204 No Content. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * Reads the request body as JSON and validates it with `schema`.
 * Throws HttpError(415) for a non-JSON content type, (400) for invalid JSON or
 * a schema mismatch (message lists the first issues), (413) for bodies > maxBytes.
 */
export async function parseJson<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { maxBytes?: number } = {},
): Promise<z.infer<S>> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  const text = await readBodyText(req, maxBytes);
  let raw: unknown;
  try {
    raw = text.length ? JSON.parse(text) : undefined;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .slice(0, 3)
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new HttpError(400, msg || "Invalid request body");
  }
  return result.data as z.infer<S>;
}

/**
 * Reads the body as UTF-8 text, never holding more than `maxBytes` in memory: a declared
 * Content-Length above the limit is refused before reading, and a streamed (e.g. chunked)
 * body is cancelled as soon as it passes the limit. Route handlers get no body cap from Next,
 * so without this an unauthenticated multi-GB POST would be buffered in full. Throws HttpError(413).
 */
export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new HttpError(413, "Request body too large");
  const declared = req.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const n = Number(declared);
    if (!Number.isFinite(n) || n > maxBytes) throw tooLarge();
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks, total));
}

/**
 * Converts a thrown value into a JSON error response. HttpError keeps its status;
 * anything else is logged and returned as 500 without leaking internals.
 * Next.js redirect()/notFound() errors are re-thrown so Next can handle them.
 */
export function handleError(err: unknown): Response {
  if (err instanceof HttpError) return error(err.status, err.message);
  if (isNextControlFlowError(err)) throw err;
  console.error("[api] unhandled error", err);
  return error(500, "Internal server error");
}

function isNextControlFlowError(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK"));
}
