import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "@/lib/env";

/**
 * Generated-file storage (audio). Paths are stored in the DB RELATIVE to
 * STORAGE_DIR (e.g. "audio/<episodeId>.mp3") so the root can move on deploy.
 *
 * Always build filesystem paths through these helpers: they carry the
 * turbopackIgnore hint that stops Turbopack from tracing the whole project.
 */

/** Absolute storage root (STORAGE_DIR resolved against process.cwd()). */
export function storageRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), getEnv().STORAGE_DIR);
}

/** Relative + absolute path for an episode's MP3; creates the audio dir. */
export function audioPathFor(episodeId: string): { relative: string; absolute: string } {
  if (!/^[A-Za-z0-9-]+$/.test(episodeId)) throw new Error("Invalid episode id");
  const relative = `audio/${episodeId}.mp3`;
  const absolute = resolveStoragePath(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return { relative, absolute };
}

/** Resolves a stored relative path; throws if it escapes the storage root. */
export function resolveStoragePath(relative: string): string {
  const root = storageRoot();
  const abs = path.resolve(/*turbopackIgnore: true*/ root, relative);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path escapes storage root");
  return abs;
}

/** Deletes a stored file if present (ignores missing files). */
export function removeStoredFile(relative: string | null | undefined): void {
  if (!relative) return;
  try {
    fs.rmSync(resolveStoragePath(relative), { force: true });
  } catch (err) {
    console.warn("[storage] failed to remove", relative, err);
  }
}
