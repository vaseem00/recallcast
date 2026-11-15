#!/usr/bin/env node
// Online SQLite backup with no sqlite3 binary: VACUUM INTO via Node's built-in node:sqlite.
// Safe while the server runs (WAL mode; VACUUM INTO reads one consistent snapshot).
//
// Usage:
//   node scripts/backup.mjs [outDir]
// Reads DATABASE_PATH (default ./data/recallcast.db). outDir defaults to
// BACKUP_DIR, else a "backups" folder next to the database. Writes
// recallcast-YYYYMMDD-HHMMSS.db and prints its path. Keeps the newest BACKUP_KEEP
// files (default 7; 0 keeps all).
import fs from "node:fs";
import path from "node:path";

const sqlite = process.getBuiltinModule?.("node:sqlite");
if (!sqlite) {
  console.error("node:sqlite is unavailable: use Node.js >= 22.13");
  process.exit(1);
}

const dbPath = path.resolve(process.env.DATABASE_PATH || "./data/recallcast.db");
if (!fs.existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(1);
}
const outDir = path.resolve(process.argv[2] || process.env.BACKUP_DIR || path.join(path.dirname(dbPath), "backups"));
const keep = Number.parseInt(process.env.BACKUP_KEEP ?? "7", 10);

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const target = path.join(outDir, `recallcast-${stamp}.db`);
if (fs.existsSync(target)) {
  console.error(`backup already exists: ${target}`);
  process.exit(1);
}

const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("VACUUM INTO ?").run(target);
  const check = new sqlite.DatabaseSync(target, { readOnly: true });
  try {
    const row = check.prepare("PRAGMA integrity_check").get();
    const verdict = row && Object.values(row)[0];
    if (verdict !== "ok") throw new Error(`integrity_check on the backup: ${verdict}`);
  } finally {
    check.close();
  }
} finally {
  db.close();
}

const size = fs.statSync(target).size;
console.log(`backup written: ${target} (${size} bytes)`);

if (Number.isFinite(keep) && keep > 0) {
  const old = fs
    .readdirSync(outDir)
    .filter((f) => /^recallcast-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) {
    fs.rmSync(path.join(outDir, f), { force: true });
    console.log(`removed old backup: ${f}`);
  }
}
