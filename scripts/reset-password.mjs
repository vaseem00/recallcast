#!/usr/bin/env node
// Operator password reset (there is no email, so a user who forgot their password asks you).
//
//   node scripts/reset-password.mjs someone@example.com
//
// Sets a new random password, signs the account out everywhere and prints the new password
// once, for you to hand to the user over a channel you trust. They should change it at
// /app/account right after signing in. Uses DATABASE_PATH (default ./data/recallcast.db).
// Run it on the server that holds the database (on Railway: `railway ssh`, then run it).

import { randomBytes, scrypt as scryptCb } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
// Must match src/lib/auth/password.ts (SCRYPT_PARAMS and the stored format).
const N = 16384, r = 8, p = 1, keyLen = 64, saltLen = 16;

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/reset-password.mjs <email>");
  process.exit(2);
}

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const file = path.resolve(process.cwd(), process.env.DATABASE_PATH || "./data/recallcast.db");
const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });

const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (!user) {
  console.error(`No account with the email ${email} in ${file}.`);
  process.exit(1);
}

const password = randomBytes(12).toString("base64url");
const salt = randomBytes(saltLen);
const key = await scrypt(password.normalize("NFKC"), salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 });
const hash = ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");

db.exec("BEGIN IMMEDIATE");
try {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  const { changes } = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  db.exec("COMMIT");
  console.log(`Password reset for ${email}. Signed out ${changes} session(s).`);
  console.log(`New password: ${password}`);
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
} finally {
  db.close();
}
