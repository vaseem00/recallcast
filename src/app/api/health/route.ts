import fs from "node:fs";
import { get } from "@/lib/db";
import { json } from "@/lib/http";
import { workerStatus } from "@/lib/jobs/worker";
import { storageRoot } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Storage root exists (created on first call) and the process may write to it. Cheap: no file I/O. */
function storageWritable(): boolean {
  try {
    const root = storageRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return true;
  } catch (err) {
    console.error("[health] storage check failed", err);
    return false;
  }
}

/**
 * Liveness + readiness for the platform health check (Railway polls it): one indexed SQLite
 * read (also proves node:sqlite loads inside the server bundle), an access() on the storage
 * dir and the in-process worker state. 503 when the DB query fails or storage is not
 * writable. Never returns paths, env values or error details.
 */
export async function GET() {
  let schemaVersion: number | null = null;
  try {
    const row = get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
    schemaVersion = Number(row?.version ?? 0);
  } catch (err) {
    console.error("[health] db check failed", err);
  }
  const writable = storageWritable();
  const ok = schemaVersion !== null && writable;
  return json(
    { ok, db: schemaVersion !== null, schemaVersion, worker: workerStatus(), storage: { writable } },
    ok ? 200 : 503,
  );
}
