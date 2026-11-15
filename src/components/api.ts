/**
 * Tiny JSON client for the app's own API. Same-origin only (relative paths), credentials
 * included, never throws: every outcome is a typed result so callers can render it.
 */

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export interface ApiOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
  /** Let the request finish after the page is hidden or left (small reports only). */
  keepalive?: boolean;
}

const FALLBACK: Record<number, string> = {
  400: "That request was not valid.",
  401: "Your session ended. Log in again.",
  403: "That is not allowed.",
  404: "Not found.",
  409: "That changed in the meantime. Refresh and try again.",
  413: "That is too large.",
  415: "That request was not valid.",
  429: "Too many tries. Wait a little and try again.",
  500: "Something broke on our side. Try again in a minute.",
  502: "The server could not be reached. Try again in a minute.",
  503: "The server is busy. Try again in a minute.",
};

export function fallbackMessage(status: number): string {
  if (FALLBACK[status]) return FALLBACK[status];
  if (status >= 500) return FALLBACK[500];
  return "That did not work. Try again.";
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return { ok: false, status: 0, error: "Bad request path." };
  }
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return { ok: false, status: 0, error: "Cancelled." };
    return { ok: false, status: 0, error: "No connection. Check your network and try again." };
  }

  if (res.status === 204 || res.status === 205) {
    return res.ok ? { ok: true, status: res.status, data: undefined as T } : { ok: false, status: res.status, error: fallbackMessage(res.status) };
  }

  let parsed: unknown = undefined;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (res.ok) return { ok: true, status: res.status, data: parsed as T };
  const msg =
    parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
      ? ((parsed as { error: string }).error || fallbackMessage(res.status))
      : fallbackMessage(res.status);
  return { ok: false, status: res.status, error: msg };
}
