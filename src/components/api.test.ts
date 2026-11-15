import { afterEach, describe, expect, it, vi } from "vitest";
import { api, fallbackMessage } from "./api";

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api", () => {
  it("GETs JSON with same-origin credentials and no body", async () => {
    const f = mockFetch(async () => new Response(JSON.stringify({ playlists: [] }), { status: 200 }));
    const res = await api<{ playlists: unknown[] }>("/api/playlists");
    expect(res).toEqual({ ok: true, status: 200, data: { playlists: [] } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/playlists");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBeUndefined();
  });

  it("POSTs a JSON body with a content type", async () => {
    const f = mockFetch(async () => new Response(JSON.stringify({ id: "p1" }), { status: 201 }));
    const res = await api<{ id: string }>("/api/playlists", { method: "POST", body: { url: "x" } });
    expect(res.ok && res.data.id).toBe("p1");
    const init = f.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ url: "x" }));
  });

  it("returns the server's {error} message", async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: "Daily limit reached" }), { status: 429 }));
    expect(await api("/api/playlists", { body: {} })).toEqual({ ok: false, status: 429, error: "Daily limit reached" });
  });

  it("falls back to a plain message for non-JSON errors", async () => {
    mockFetch(async () => new Response("<html>oops</html>", { status: 502 }));
    expect(await api("/api/x")).toEqual({ ok: false, status: 502, error: fallbackMessage(502) });
  });

  it("handles 204 with no body", async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    const res = await api("/api/playlists/p1", { method: "DELETE" });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
  });

  it("reports a network failure without throwing", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await api("/api/x");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });

  it("reports an abort as cancelled", async () => {
    mockFetch(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    expect(await api("/api/x")).toEqual({ ok: false, status: 0, error: "Cancelled." });
  });

  it("refuses absolute and protocol-relative URLs", async () => {
    const f = mockFetch(async () => new Response("{}"));
    expect((await api("https://evil.example/api")).ok).toBe(false);
    expect((await api("//evil.example/api")).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("has a message for every common status", () => {
    for (const s of [400, 401, 403, 404, 409, 429, 500, 503, 599, 418]) {
      expect(fallbackMessage(s).length).toBeGreaterThan(0);
    }
  });
});
