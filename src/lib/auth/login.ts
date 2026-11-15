import "server-only";
import type { PublicUser } from "@/lib/types";
import { getDummyHash, hashPassword, needsRehash, verifyPassword } from "./password";
import { findUserByEmail, toPublicUser, updatePasswordHash } from "./users";

/**
 * Verifies credentials. Returns the user, or null for ANY failure (unknown email or
 * wrong password). Unknown emails still run a full scrypt verify against a dummy hash,
 * so both failure modes cost about the same time.
 */
export async function authenticate(email: string, password: string): Promise<PublicUser | null> {
  const row = findUserByEmail(email);
  if (!row) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  if (needsRehash(row.password_hash)) {
    try {
      updatePasswordHash(row.id, await hashPassword(password));
    } catch (err) {
      console.error("[auth] rehash failed", err);
    }
  }
  return toPublicUser(row);
}
