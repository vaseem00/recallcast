import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { assertSameOrigin } from "./origin";

function req(method: string, headers: Record<string, string>, url = "http://localhost:3000/api/playlists") {
  return new Request(url, { method, headers });
}

function rejects(r: Request) {
  try {
    assertSameOrigin(r);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    return true;
  }
  return false;
}

afterEach(() => {
  delete process.env.APP_URL;
  resetEnvCache();
});

describe("assertSameOrigin", () => {
  it("allows safe methods regardless of origin", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(() => assertSameOrigin(req(m, { origin: "https://evil.example" }))).not.toThrow();
    }
  });

  it("allows a matching Origin (request URL / Host)", () => {
    expect(() => assertSameOrigin(req("POST", { origin: "http://localhost:3000" }))).not.toThrow();
    expect(() =>
      assertSameOrigin(req("DELETE", { origin: "http://localhost:3000", host: "localhost:3000" })),
    ).not.toThrow();
  });

  it("rejects a foreign, null or malformed Origin", () => {
    expect(rejects(req("POST", { origin: "https://evil.example" }))).toBe(true);
    expect(rejects(req("POST", { origin: "http://localhost:3001" }))).toBe(true);
    expect(rejects(req("POST", { origin: "https://localhost:3000" }))).toBe(true); // scheme differs
    expect(rejects(req("POST", { origin: "null" }))).toBe(true);
    expect(rejects(req("POST", { origin: "not a url" }))).toBe(true);
    expect(rejects(req("PUT", { origin: "http://localhost:3000.evil.example" }))).toBe(true);
    expect(rejects(req("PATCH", { origin: "https://evil.example" }))).toBe(true);
  });

  it("honours APP_URL and reverse-proxy headers", () => {
    process.env.APP_URL = "https://recallcast.example.com";
    resetEnvCache();
    const internal = "http://127.0.0.1:3000/api/playlists";
    expect(() =>
      assertSameOrigin(req("POST", { origin: "https://recallcast.example.com" }, internal)),
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(
        req(
          "POST",
          { origin: "https://app.other.example", "x-forwarded-host": "app.other.example", "x-forwarded-proto": "https" },
          internal,
        ),
      ),
    ).not.toThrow();
    expect(rejects(req("POST", { origin: "https://evil.example" }, internal))).toBe(true);
  });

  it("falls back to Sec-Fetch-Site when Origin is absent", () => {
    expect(() => assertSameOrigin(req("POST", { "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameOrigin(req("POST", { "sec-fetch-site": "none" }))).not.toThrow();
    expect(rejects(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(rejects(req("POST", { "sec-fetch-site": "same-site" }))).toBe(true);
  });

  it("falls back to Referer when Origin and Sec-Fetch-Site are absent", () => {
    expect(() => assertSameOrigin(req("POST", { referer: "http://localhost:3000/app" }))).not.toThrow();
    expect(rejects(req("POST", { referer: "https://evil.example/page" }))).toBe(true);
    expect(rejects(req("POST", { referer: "garbage" }))).toBe(true);
  });

  it("allows non-browser clients that send no browser signals", () => {
    expect(() => assertSameOrigin(req("POST", {}))).not.toThrow();
  });
});
