import { describe, expect, it } from "vitest";
import { getDummyHash, hashPassword, needsRehash, SCRYPT_PARAMS, verifyPassword } from "./password";

describe("password hashing (scrypt)", () => {
  it("round-trips: the right password verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password, including near misses", async () => {
    const hash = await hashPassword("s3cret-password");
    expect(await verifyPassword("s3cret-passwore", hash)).toBe(false);
    expect(await verifyPassword("S3cret-password", hash)).toBe(false);
    expect(await verifyPassword("s3cret-password ", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("encodes params, a 16-byte salt and a 64-byte key", async () => {
    const hash = await hashPassword("password123");
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
    expect(Buffer.from(parts[4], "base64url")).toHaveLength(SCRYPT_PARAMS.saltLen);
    expect(Buffer.from(parts[5], "base64url")).toHaveLength(SCRYPT_PARAMS.keyLen);
  });

  it("uses a fresh random salt per hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("handles unicode passwords (NFKC-normalised)", async () => {
    const composed = "café-päss";
    const decomposed = "café-päss";
    const hash = await hashPassword(composed);
    expect(await verifyPassword(composed, hash)).toBe(true);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it("returns false (never throws) for malformed or hostile hashes", async () => {
    const good = await hashPassword("password123");
    const [, , r, p, salt, key] = good.split("$");
    const bad = [
      "",
      "plain",
      "bcrypt$10$abc",
      `scrypt$16384$${r}$${p}$${salt}`,
      `scrypt$16383$${r}$${p}$${salt}$${key}`, // N not a power of two
      `scrypt$${2 ** 24}$${r}$${p}$${salt}$${key}`, // N too large (DoS guard)
      `scrypt$16384$999$${p}$${salt}$${key}`,
      `scrypt$16384$${r}$${p}$${salt}$***`,
      `scrypt$abc$${r}$${p}$${salt}$${key}`,
    ];
    for (const h of bad) {
      await expect(verifyPassword("password123", h)).resolves.toBe(false);
    }
    // @ts-expect-error runtime guard for non-string input
    await expect(verifyPassword(undefined, good)).resolves.toBe(false);
  });

  it("detects hashes that need rehashing", async () => {
    const good = await hashPassword("password123");
    expect(needsRehash(good)).toBe(false);
    expect(needsRehash(good.replace("scrypt$16384$", "scrypt$1024$"))).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
  });

  it("refuses to hash an empty password", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });

  it("provides a cached dummy hash that no ordinary password matches", async () => {
    const d1 = await getDummyHash();
    const d2 = await getDummyHash();
    expect(d1).toBe(d2);
    expect(await verifyPassword("password123", d1)).toBe(false);
  });
});
