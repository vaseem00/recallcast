import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { audioPathFor, storageRoot } from "@/lib/storage";

/**
 * Audio file helpers on top of src/lib/storage.ts.
 *
 * Episode audio lives at <STORAGE_DIR>/audio/<episodeId>.mp3 and the DB stores the
 * RELATIVE path "audio/<episodeId>.mp3". Everything read from the DB goes through
 * resolveAudioPath(), which only accepts that exact shape, so a tampered or corrupt
 * audio_path can never point outside the audio directory.
 */

const AUDIO_DIR = "audio";
const AUDIO_REL_RE = /^audio\/[A-Za-z0-9-]{1,128}\.mp3$/;

/** Absolute path of the audio directory (not created). */
export function audioRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ storageRoot(), AUDIO_DIR);
}

/** True when `p` is inside `root` (not equal to it, no traversal, same drive). */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves a stored relative audio path ("audio/<id>.mp3") to an absolute path under
 * the audio directory. Throws on anything else: absolute paths, "..", backslashes,
 * NUL bytes, other directories or extensions.
 */
export function resolveAudioPath(relative: string): string {
  if (typeof relative !== "string" || !AUDIO_REL_RE.test(relative)) {
    throw new Error("Invalid audio path");
  }
  const root = audioRoot();
  const abs = path.resolve(/*turbopackIgnore: true*/ storageRoot(), relative);
  if (!isInside(root, abs)) throw new Error("Audio path escapes the audio directory");
  return abs;
}

/** Relative + absolute path for an episode's MP3 (creates the audio directory). */
export function audioFileFor(episodeId: string): { relative: string; absolute: string } {
  return audioPathFor(episodeId);
}

/** Size and mtime of a stored audio file, or null when it is missing / not a regular file. */
export function statAudio(relative: string): { absolute: string; size: number; mtimeMs: number } | null {
  const absolute = resolveAudioPath(relative);
  try {
    const st = fs.statSync(absolute);
    if (!st.isFile()) return null;
    return { absolute, size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `data` to `absolute` atomically: write a unique temp file in the same directory,
 * fsync it, then rename over the target. Readers never see a half-written file.
 * On Windows a rename can fail briefly with EPERM/EBUSY while another process has the
 * target open (e.g. it is being streamed), so the rename is retried a few times.
 */
export function writeFileAtomic(absolute: string, data: Uint8Array): void {
  const dir = path.dirname(absolute);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absolute)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx");
    let written = 0;
    while (written < data.length) {
      written += fs.writeSync(fd, data, written, data.length - written);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, absolute);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (attempt >= 5 || !RENAME_RETRY_CODES.has(code)) throw err;
        sleepSync(50 * (attempt + 1));
      }
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Writes an episode's MP3 atomically to its relative path ("audio/<id>.mp3"). */
export function writeAudio(relative: string, data: Uint8Array): string {
  const absolute = resolveAudioPath(relative);
  writeFileAtomic(absolute, data);
  return absolute;
}

/** Deletes a stored audio file. Returns true when a file was removed. Invalid paths are ignored (logged). */
export function deleteAudio(relative: string | null | undefined): boolean {
  if (!relative) return false;
  let absolute: string;
  try {
    absolute = resolveAudioPath(relative);
  } catch {
    console.warn("[storage] refusing to delete invalid audio path", JSON.stringify(relative));
    return false;
  }
  try {
    fs.unlinkSync(absolute);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    console.warn("[storage] failed to delete audio", relative, err);
    return false;
  }
}
