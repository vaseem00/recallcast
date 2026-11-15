import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { all, applyMigration, closeDb, get, getDb, MIGRATIONS, openDatabase, run, transaction } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { newId } from "@/lib/ids";
import type { UserRow } from "@/lib/types";

function insertUser(email: string): string {
  const id = newId();
  run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", id, email, "x", Date.now());
  return id;
}

describe("db (in-memory singleton)", () => {
  afterEach(() => {
    closeDb();
  });

  it("migrates and creates every table", () => {
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((r) => r.name);
    expect(tables).toEqual(
      [
        "cards",
        "episodes",
        "jobs",
        "knowledge",
        "moments",
        "playlist_creations",
        "playlist_events",
        "playlists",
        "rate_limit_hits",
        "reviews",
        "schema_migrations",
        "sessions",
        "shares",
        "signup_events",
        "transcripts",
        "users",
        "videos",
      ].sort(),
    );
    const v = get<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations");
    expect(Number(v?.v)).toBe(MIGRATIONS.at(-1)!.version);
  });

  it("inserts and reads a user; email is unique case-insensitively", () => {
    const id = insertUser("Ada@Example.com");
    const row = get<UserRow>("SELECT * FROM users WHERE email = ?", "ada@example.com");
    expect(row?.id).toBe(id);
    expect(row?.email).toBe("Ada@Example.com");
    expect(() => insertUser("ADA@example.com")).toThrow(/UNIQUE/);
  });

  it("supports named parameters", () => {
    const id = insertUser("named@example.com");
    const row = get<UserRow>("SELECT * FROM users WHERE id = :id", { id });
    expect(row?.email).toBe("named@example.com");
  });

  it("enforces foreign keys and cascades deletes", () => {
    expect(Number(get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys)).toBe(1);
    expect(() =>
      run(
        "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        "s1",
        "missing-user",
        1,
        2,
      ),
    ).toThrow(/FOREIGN KEY/);

    const userId = insertUser("fk@example.com");
    const t = Date.now();
    const playlistId = newId();
    run(
      `INSERT INTO playlists (id, user_id, source_url, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'video', ?, ?)`,
      playlistId,
      userId,
      "https://youtu.be/abc",
      t,
      t,
    );
    const videoId = newId();
    run(
      "INSERT INTO videos (id, playlist_id, youtube_video_id, position) VALUES (?, ?, ?, 0)",
      videoId,
      playlistId,
      "abc",
    );
    run("DELETE FROM playlists WHERE id = ?", playlistId);
    expect(get("SELECT id FROM videos WHERE id = ?", videoId)).toBeUndefined();
  });

  it("rejects values outside CHECK enums", () => {
    const userId = insertUser("check@example.com");
    expect(() =>
      run(
        `INSERT INTO playlists (id, user_id, source_url, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, 'video', 'bogus', 1, 1)`,
        newId(),
        userId,
        "u",
      ),
    ).toThrow(/CHECK/);
  });

  it("transaction commits, rolls back on error, and nests with savepoints", () => {
    transaction(() => {
      insertUser("tx1@example.com");
    });
    expect(get("SELECT id FROM users WHERE email = ?", "tx1@example.com")).toBeDefined();

    expect(() =>
      transaction(() => {
        insertUser("tx2@example.com");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(get("SELECT id FROM users WHERE email = ?", "tx2@example.com")).toBeUndefined();

    transaction(() => {
      insertUser("outer@example.com");
      expect(() =>
        transaction(() => {
          insertUser("inner@example.com");
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(get("SELECT id FROM users WHERE email = ?", "outer@example.com")).toBeDefined();
    expect(get("SELECT id FROM users WHERE email = ?", "inner@example.com")).toBeUndefined();
    expect(getDb().isTransaction).toBe(false);
  });
});

describe("db (file on disk)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-db-"));
  const file = path.join(dir, "nested", "test.db");

  afterAll(() => {
    closeDb();
    process.env.DATABASE_PATH = ":memory:";
    resetEnvCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the parent dir, uses WAL, and migrations are idempotent across reopen", () => {
    const db1 = openDatabase(file);
    expect(String((db1.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode)).toBe("wal");
    db1.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
      "u1",
      "disk@example.com",
      "x",
      1,
    );
    db1.close();

    process.env.DATABASE_PATH = file;
    resetEnvCache();
    closeDb();
    const row = get<UserRow>("SELECT * FROM users WHERE id = ?", "u1");
    expect(row?.email).toBe("disk@example.com");
    const count = get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations");
    expect(Number(count?.n)).toBe(MIGRATIONS.length);
  });

  // Two processes opening a fresh DB together: both pre-read an empty schema_migrations, the
  // first applies migration 1. Before the fix the second then ran CREATE TABLE users again and
  // failed ("table users already exists"); now the check under the lock skips it.
  it("applying a migration another connection already applied is a no-op, not an error", () => {
    const raceFile = path.join(dir, "race.db");
    const a = openDatabase(raceFile);
    try {
      for (const m of MIGRATIONS) expect(applyMigration(a, m)).toBe(false);
      const n = (a.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
      expect(Number(n)).toBe(MIGRATIONS.length);
      expect(a.isTransaction).toBe(false);
    } finally {
      a.close();
    }
  });
});
