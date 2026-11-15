import "server-only";
import { z } from "zod";
import { get, now, run, transaction } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { newId } from "@/lib/ids";
import type { PublicUser, UserRow } from "@/lib/types";
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN } from "./password";

/** Email normalised: trimmed, lower-cased, valid, <= 254 chars. */
export const emailSchema = z
  .string({ error: "Email is required" })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address" }).max(254, { error: "Email is too long" }));

export const signupSchema = z.object({
  email: emailSchema,
  password: z
    .string({ error: "Password is required" })
    .min(PASSWORD_MIN, { error: `Password must be at least ${PASSWORD_MIN} characters` })
    .max(PASSWORD_MAX, { error: `Password must be at most ${PASSWORD_MAX} characters` }),
});

/** Login is lenient on the password (any non-empty value up to the max) so it never reveals policy. */
export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string({ error: "Password is required" })
    .min(1, { error: "Password is required" })
    .max(PASSWORD_MAX, { error: "Invalid email or password" }),
});

export function toPublicUser(row: Pick<UserRow, "id" | "email" | "created_at">): PublicUser {
  return { id: row.id, email: row.email, createdAt: Number(row.created_at) };
}

export function findUserByEmail(email: string): UserRow | undefined {
  return get<UserRow>("SELECT * FROM users WHERE email = ?", email.trim().toLowerCase());
}

export function findUserById(id: string): UserRow | undefined {
  return get<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export class EmailTakenError extends Error {
  constructor() {
    super("An account with this email already exists");
    this.name = "EmailTakenError";
  }
}

/** The site-wide MAX_SIGNUPS_PER_DAY cap is reached (rolling 24 h). */
export class SignupsPausedError extends Error {
  constructor() {
    super("New sign-ups are paused for today. Try again tomorrow.");
    this.name = "SignupsPausedError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Account creations counted by the site-wide cap in the 24 h before `at` (signup_events ledger). */
export function signupsInLastDay(at: number = now()): number {
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM signup_events WHERE created_at > ?", at - DAY_MS)?.n ?? 0);
}

/**
 * Creates a user with a hashed password and records it in signup_events, in one transaction.
 *
 * Throws SignupsPausedError when MAX_SIGNUPS_PER_DAY accounts were created in the last 24 h, and
 * EmailTakenError on a duplicate (case-insensitive). The password is always hashed first, and the
 * cap is checked before the email, so neither the timing nor the cap refusal depends on whether
 * the email is registered (only the 409 itself does).
 */
export async function createUser(email: string, password: string): Promise<PublicUser> {
  const normalized = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const id = newId();
  const createdAt = now();
  const cap = getEnv().MAX_SIGNUPS_PER_DAY;
  transaction(() => {
    // Check-then-insert with no await in between: concurrent sign-ups cannot overshoot the cap.
    if (signupsInLastDay(createdAt) >= cap) throw new SignupsPausedError();
    try {
      run(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
        id,
        normalized,
        passwordHash,
        createdAt,
      );
    } catch (err) {
      if (/UNIQUE/i.test((err as Error)?.message ?? "")) throw new EmailTakenError();
      throw err;
    }
    run("INSERT INTO signup_events (created_at) VALUES (?)", createdAt);
  });
  return { id, email: normalized, createdAt };
}

export function updatePasswordHash(userId: string, passwordHash: string): void {
  run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, userId);
}
