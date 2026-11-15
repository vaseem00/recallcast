import "server-only";
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with node:crypto scrypt.
 *
 * Encoded format (self-describing so params can be raised later):
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 */

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64, saltLen: 16 } as const;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// Upper bounds accepted when parsing a stored hash (guards against absurd params).
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function maxmemFor(N: number, r: number, p: number): number {
  // scrypt needs ~128 * N * r * p bytes (+ slack); Node's default (32 MiB) is enough for the defaults.
  return Math.max(32 * 1024 * 1024, 128 * N * r * (p + 2));
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("hashPassword: password must be a non-empty string");
  }
  const { N, r, p, keyLen, saltLen } = SCRYPT_PARAMS;
  const salt = randomBytes(saltLen);
  const key = await scryptAsync(password, salt, keyLen, { N, r, p, maxmem: maxmemFor(N, r, p) });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  if (typeof encoded !== "string") return null;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, nStr, rStr, pStr, saltStr, keyStr] = parts;
  if (!/^\d+$/.test(nStr) || !/^\d+$/.test(rStr) || !/^\d+$/.test(pStr)) return null;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  // N must be a power of two > 1.
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > MAX_R || p < 1 || p > MAX_P) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(saltStr) || !/^[A-Za-z0-9_-]+$/.test(keyStr)) return null;
  const salt = Buffer.from(saltStr, "base64url");
  const key = Buffer.from(keyStr, "base64url");
  if (salt.length < 8 || key.length < 16 || key.length > 256) return null;
  return { N, r, p, salt, key };
}

/** Timing-safe check of `password` against a hash produced by hashPassword(). Never throws for bad input. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== "string") return false;
  const parsed = parseHash(hash);
  if (!parsed) return false;
  const { N, r, p, salt, key } = parsed;
  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, key.length, { N, r, p, maxmem: maxmemFor(N, r, p) });
  } catch {
    return false;
  }
  return derived.length === key.length && timingSafeEqual(derived, key);
}

/** True when a stored hash uses weaker params than the current defaults (rehash on next login). */
export function needsRehash(hash: string): boolean {
  const parsed = parseHash(hash);
  if (!parsed) return true;
  return (
    parsed.N < SCRYPT_PARAMS.N ||
    parsed.r < SCRYPT_PARAMS.r ||
    parsed.p < SCRYPT_PARAMS.p ||
    parsed.key.length < SCRYPT_PARAMS.keyLen
  );
}

let dummyHash: Promise<string> | null = null;

/**
 * A real hash of a random secret, computed once. Login verifies against it when the
 * email is unknown, so "no such user" costs the same scrypt work as "wrong password".
 */
export function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = hashPassword(randomBytes(32).toString("base64url")).catch((err) => {
      dummyHash = null;
      throw err;
    });
  }
  return dummyHash;
}
