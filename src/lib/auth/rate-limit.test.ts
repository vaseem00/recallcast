import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { installPeerStamp, PEER_HEADER, peerHeaderValue, readPeer, stampPeer } from "./peer";
import { get, run } from "@/lib/db";
import { clientIp, getAuthLimiters, ipKey, purgeRateLimitHits, RateLimiter, SqliteRateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows `limit` hits per window, then blocks with Retry-After", () => {
    const rl = new RateLimiter({ limit: 10, windowMs: 15 * 60_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) expect(rl.hit("k", t0 + i).allowed).toBe(true);
    const tenth = rl.hit("k", t0 + 9);
    expect(tenth.allowed).toBe(true); // the 10th attempt is still allowed
    expect(tenth.remaining).toBe(0);
    expect(rl.check("k", t0 + 10).allowed).toBe(false);
    const r = rl.hit("k", t0 + 10);
    expect(r.allowed).toBe(false); // the 11th is blocked
    expect(r.retryAfterS).toBeGreaterThan(0);
    expect(r.retryAfterS).toBeLessThanOrEqual(15 * 60);
  });

  it("permits exactly 10 of 25 back-to-back attempts", () => {
    const rl = new RateLimiter({ limit: 10, windowMs: 60_000 });
    let permitted = 0;
    for (let i = 0; i < 25; i++) if (rl.hit("pair", i).allowed) permitted++;
    expect(permitted).toBe(10);
  });

  it("recovers after the window passes", () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    rl.hit("k", 0);
    rl.hit("k", 10);
    rl.hit("k", 20);
    expect(rl.check("k", 500).allowed).toBe(false);
    expect(rl.check("k", 1001).allowed).toBe(true);
    expect(rl.check("k", 1001).remaining).toBe(1);
    expect(rl.check("k", 2000).remaining).toBe(3);
  });

  it("keeps blocking a client that keeps hammering (sliding)", () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
    rl.hit("k", 0);
    rl.hit("k", 0);
    for (let t = 100; t <= 3000; t += 100) expect(rl.hit("k", t).allowed).toBe(false);
  });

  it("isolates keys and supports reset", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
    rl.hit("a", 0);
    expect(rl.check("a", 1).allowed).toBe(false);
    expect(rl.check("b", 1).allowed).toBe(true);
    rl.reset("a");
    expect(rl.check("a", 2).allowed).toBe(true);
  });

  it("bounds memory by evicting keys", () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 1_000_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) rl.hit(`k${i}`, i);
    expect(rl.size).toBeLessThanOrEqual(100);
  });

  it("rejects invalid config", () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1 })).toThrow();
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});

describe("auth limiters", () => {
  it("login is 10 per 15 minutes per IP+email and is a process singleton", () => {
    const l = getAuthLimiters();
    expect(l.loginIpEmail.limit).toBe(10);
    expect(l.loginIpEmail.windowMs).toBe(15 * 60 * 1000);
    expect(getAuthLimiters()).toBe(l);
  });

  it("are persistent (SQLite) and include a per-user password-change limiter (10 / 15 min)", () => {
    const l = getAuthLimiters();
    for (const name of ["loginIp", "loginIpEmail", "loginEmail", "signupIp", "passwordChange"] as const) {
      expect(l[name]).toBeInstanceOf(SqliteRateLimiter);
      expect((l[name] as SqliteRateLimiter).bucket).toBe(name);
    }
    expect(l.passwordChange.limit).toBe(10);
    expect(l.passwordChange.windowMs).toBe(15 * 60 * 1000);
  });
});

describe("SqliteRateLimiter", () => {
  let seq = 0;
  const bucket = () => `test-${++seq}-${Math.random().toString(36).slice(2)}`;
  const rows = (b: string, key?: string) =>
    Number(
      (key === undefined
        ? get<{ n: number }>("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket = ?", b)
        : get<{ n: number }>("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket = ? AND key = ?", b, key))!.n,
    );

  it("has the same semantics as the in-memory limiter", () => {
    const b = bucket();
    const mem = new RateLimiter({ limit: 3, windowMs: 1000 });
    const sql = new SqliteRateLimiter({ bucket: b, limit: 3, windowMs: 1000 });
    const times = [0, 10, 20, 30, 500, 999, 1005, 1015, 1500, 2600, 2601, 2602, 2603];
    for (const t of times) {
      expect(sql.check("k", t)).toEqual(mem.check("k", t));
      expect(sql.hit("k", t)).toEqual(mem.hit("k", t));
    }
  });

  it("permits exactly 10 of 25 back-to-back attempts and blocks with Retry-After", () => {
    const rl = new SqliteRateLimiter({ bucket: bucket(), limit: 10, windowMs: 60_000 });
    let permitted = 0;
    let last;
    for (let i = 0; i < 25; i++) {
      last = rl.hit("pair", 1_000_000 + i);
      if (last.allowed) permitted++;
    }
    expect(permitted).toBe(10);
    expect(last!.retryAfterS).toBeGreaterThan(0);
    expect(last!.retryAfterS).toBeLessThanOrEqual(60);
  });

  it("survives a restart: a new instance on the same bucket (same DB) sees earlier hits", () => {
    const b = bucket();
    const first = new SqliteRateLimiter({ bucket: b, limit: 2, windowMs: 60_000 });
    first.hit("1.2.3.4", 5_000);
    first.hit("1.2.3.4", 5_001);
    const afterRestart = new SqliteRateLimiter({ bucket: b, limit: 2, windowMs: 60_000 });
    expect(afterRestart.check("1.2.3.4", 5_002).allowed).toBe(false);
    expect(afterRestart.hit("1.2.3.4", 5_002).allowed).toBe(false);
    // other buckets are independent
    expect(new SqliteRateLimiter({ bucket: bucket(), limit: 2, windowMs: 60_000 }).check("1.2.3.4", 5_002).allowed).toBe(true);
  });

  it("keeps blocking a hammering client but stores at most `limit` rows per key", () => {
    const b = bucket();
    const rl = new SqliteRateLimiter({ bucket: b, limit: 5, windowMs: 1000 });
    for (let t = 0; t < 5000; t += 10) {
      const r = rl.hit("k", t);
      if (t >= 50) expect(r.allowed).toBe(false);
      expect(rows(b, "k")).toBeLessThanOrEqual(5);
    }
    expect(rows(b, "k")).toBe(5);
    // a quiet key recovers once the window has passed, and its stale rows are dropped on the next hit
    expect(rl.check("k", 7000).allowed).toBe(true);
    expect(rl.hit("k", 7000).allowed).toBe(true);
    expect(rows(b, "k")).toBe(1);
  });

  it("isolates keys and supports reset and clear", () => {
    const b = bucket();
    const rl = new SqliteRateLimiter({ bucket: b, limit: 1, windowMs: 1000 });
    rl.hit("a", 0);
    rl.hit("b", 0);
    expect(rl.check("a", 1).allowed).toBe(false);
    expect(rl.check("c", 1).allowed).toBe(true);
    expect(rl.size).toBe(2);
    rl.reset("a");
    expect(rl.check("a", 2).allowed).toBe(true);
    expect(rl.check("b", 2).allowed).toBe(false);
    rl.clear();
    expect(rl.size).toBe(0);
  });

  it("purgeRateLimitHits drops rows outside each bucket's window and keeps live ones", () => {
    const now = Date.now();
    const short = bucket();
    const long = bucket();
    const s = new SqliteRateLimiter({ bucket: short, limit: 10, windowMs: 60_000 });
    const l = new SqliteRateLimiter({ bucket: long, limit: 10, windowMs: 3_600_000 });
    s.hit("old", now - 120_000);
    s.hit("live", now - 1_000);
    l.hit("old-for-short-but-live", now - 120_000);
    l.hit("old", now - 7_200_000);
    const unknown = `unknown-${bucket()}`;
    run("INSERT INTO rate_limit_hits (bucket, key, at) VALUES (?, 'x', ?), (?, 'y', ?)", unknown, now - 3_600_000, unknown, now - 25 * 3_600_000);

    const deleted = purgeRateLimitHits(now);
    expect(deleted).toBeGreaterThanOrEqual(3);
    expect(rows(short, "old")).toBe(0);
    expect(rows(short, "live")).toBe(1);
    expect(rows(long, "old-for-short-but-live")).toBe(1);
    expect(rows(long, "old")).toBe(0);
    // a bucket this process does not know is kept for 24 h
    expect(rows(unknown, "x")).toBe(1);
    expect(rows(unknown, "y")).toBe(0);
    expect(s.check("live", now).remaining).toBe(9);
  });

  it("rejects invalid config", () => {
    expect(() => new SqliteRateLimiter({ bucket: "x", limit: 0, windowMs: 1 })).toThrow();
    expect(() => new SqliteRateLimiter({ bucket: "x", limit: 1, windowMs: 0 })).toThrow();
    expect(() => new SqliteRateLimiter({ bucket: "", limit: 1, windowMs: 1 })).toThrow();
  });
});

describe("RateLimiter eviction (blocked keys are kept)", () => {
  it("flooding with throwaway keys does not reset a blocked key", () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1_000_000, maxKeys: 100 });
    for (let i = 0; i < 3; i++) rl.hit("victim", i);
    expect(rl.check("victim", 10).allowed).toBe(false);
    for (let i = 0; i < 1000; i++) rl.hit(`junk${i}`, 100 + i);
    expect(rl.size).toBeLessThanOrEqual(100);
    expect(rl.check("victim", 2000).allowed).toBe(false);
    expect(rl.hit("victim", 2001).allowed).toBe(false);
  });

  it("fails closed for new keys when every stored key is blocked", () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000_000, maxKeys: 3 });
    for (const k of ["a", "b", "c"]) rl.hit(k, 0);
    const r = rl.hit("d", 1);
    expect(r.allowed).toBe(false);
    expect(rl.size).toBe(3);
    // once a window passes the expired keys are swept and new keys get in again
    expect(rl.hit("d", 1_000_002).allowed).toBe(true);
  });
});

describe("auth limiters: per-IP login cap", () => {
  it("has a per-IP login limiter independent of the email", () => {
    const l = getAuthLimiters();
    expect(l.loginIp.limit).toBe(100);
    expect(l.loginIp.windowMs).toBe(15 * 60 * 1000);
  });
});

describe("clientIp", () => {
  const req = (h: Record<string, string>) => new Request("http://localhost/api/auth/login", { headers: h });

  // Before the fix the leftmost X-Forwarded-For value (client-controlled) was the key.
  it("ignores X-Forwarded-For and X-Real-IP by default and uses the stamped peer address", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }), 0)).toBe("unknown");
    expect(clientIp(req({ "x-real-ip": "198.51.100.7" }), 0)).toBe("unknown");
    expect(clientIp(req({}), 0)).toBe("unknown");
    const peer = { [PEER_HEADER]: peerHeaderValue("192.0.2.10") };
    expect(clientIp(req({ ...peer, "x-forwarded-for": `${Math.random()}` }), 0)).toBe("192.0.2.10");
    expect(clientIp(req({ ...peer }))).toBe("192.0.2.10"); // TRUST_PROXY_HOPS defaults to 0
  });

  it("rejects a client-sent peer header without the process secret", () => {
    expect(clientIp(req({ [PEER_HEADER]: "deadbeef 203.0.113.99" }), 0)).toBe("unknown");
    expect(clientIp(req({ [PEER_HEADER]: "203.0.113.99" }), 0)).toBe("unknown");
  });

  it("with N trusted hops takes the Nth X-Forwarded-For entry from the right", () => {
    const xff = { "x-forwarded-for": "6.6.6.6, 203.0.113.5", [PEER_HEADER]: peerHeaderValue("10.0.0.2") };
    expect(clientIp(req(xff), 1)).toBe("203.0.113.5");
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.5, 10.0.0.1" }), 2)).toBe("203.0.113.5");
    // fewer entries than hops: fall back to the peer address, never the client-written left side
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6", [PEER_HEADER]: peerHeaderValue("10.0.0.2") }), 2)).toBe("10.0.0.2");
  });

  it("groups IPv6 by /64 and unwraps IPv4-mapped addresses", () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(ipKey("[2001:db8::1]:443")).toBe("2001:db8:0:0::/64");
    expect(ipKey("203.0.113.5:8080")).toBe("203.0.113.5");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});

describe("peer stamp", () => {
  it("stampPeer overwrites a client-sent peer header with the socket address", () => {
    const fake = { headers: { [PEER_HEADER]: "forged 6.6.6.6" } as Record<string, string>, socket: { remoteAddress: "192.0.2.1" } };
    stampPeer(fake as never);
    expect(readPeer(new Headers(fake.headers))).toBe("192.0.2.1");
    const noSocket = { headers: { [PEER_HEADER]: peerHeaderValue("6.6.6.6") } as Record<string, string>, socket: {} };
    stampPeer(noSocket as never);
    expect(noSocket.headers[PEER_HEADER]).toBeUndefined();
  });

  it("installPeerStamp stamps real http.Server requests before handlers see them", async () => {
    installPeerStamp();
    expect(installPeerStamp()).toBe(false); // idempotent
    let seen: string | null = "unset";
    const server = http.createServer((req, res) => {
      seen = readPeer(new Headers(req.headers as Record<string, string>));
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { [PEER_HEADER]: peerHeaderValue("6.6.6.6"), "x-forwarded-for": "6.6.6.6" },
      });
      expect(await res.text()).toBe("ok");
      expect(seen).toBe("127.0.0.1");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
