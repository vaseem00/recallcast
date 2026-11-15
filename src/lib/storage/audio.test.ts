import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import {
  audioFileFor,
  audioRoot,
  deleteAudio,
  isInside,
  resolveAudioPath,
  statAudio,
  writeAudio,
  writeFileAtomic,
} from "./audio";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-audio-"));
process.env.STORAGE_DIR = dir;
resetEnvCache();

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveAudioPath", () => {
  it("resolves audio/<id>.mp3 under <STORAGE_DIR>/audio", () => {
    expect(audioRoot()).toBe(path.join(dir, "audio"));
    expect(resolveAudioPath("audio/0b8e4c1e-1111-4222-8333-944445555666.mp3")).toBe(
      path.join(dir, "audio", "0b8e4c1e-1111-4222-8333-944445555666.mp3"),
    );
  });

  it.each([
    "../audio/x.mp3",
    "audio/../x.mp3",
    "audio/../../etc/passwd",
    "audio/..%2fx.mp3",
    "audio\\x.mp3",
    "audio/x.mp3\u0000.txt",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "C:/x/audio/x.mp3",
    "\\\\server\\share\\audio\\x.mp3",
    "audio/x.wav",
    "audio/sub/x.mp3",
    "other/x.mp3",
    "audio/.mp3",
    "audio/x.mp3 ",
    "",
  ])("rejects %j", (p) => {
    expect(() => resolveAudioPath(p)).toThrow();
  });

  it("rejects non-strings", () => {
    expect(() => resolveAudioPath(undefined as unknown as string)).toThrow();
    expect(() => resolveAudioPath(42 as unknown as string)).toThrow();
  });

  it("isInside", () => {
    const root = path.join(dir, "audio");
    expect(isInside(root, path.join(root, "a.mp3"))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, path.join(dir, "audio2", "a.mp3"))).toBe(false);
    expect(isInside(root, path.join(dir, "a.mp3"))).toBe(false);
  });
});

describe("write / stat / delete", () => {
  it("writes atomically, stats and deletes an episode file", () => {
    const { relative, absolute } = audioFileFor("ep-1");
    expect(relative).toBe("audio/ep-1.mp3");
    expect(writeAudio(relative, Buffer.from("first"))).toBe(absolute);
    writeAudio(relative, Buffer.from("second version"));
    expect(fs.readFileSync(absolute, "utf8")).toBe("second version");
    expect(statAudio(relative)).toMatchObject({ absolute, size: 14 });
    // Only the final file remains (no temp files).
    expect(fs.readdirSync(path.dirname(absolute)).filter((f) => f.includes("ep-1"))).toEqual(["ep-1.mp3"]);

    expect(deleteAudio(relative)).toBe(true);
    expect(fs.existsSync(absolute)).toBe(false);
    expect(statAudio(relative)).toBeNull();
    expect(deleteAudio(relative)).toBe(false);
  });

  it("deleteAudio ignores null and refuses traversal without touching the file", () => {
    const outside = path.join(dir, "keep.mp3");
    fs.writeFileSync(outside, "keep");
    expect(deleteAudio(null)).toBe(false);
    expect(deleteAudio(undefined)).toBe(false);
    expect(deleteAudio("audio/../keep.mp3")).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("statAudio returns null for a directory", () => {
    fs.mkdirSync(path.join(dir, "audio", "dir.mp3"), { recursive: true });
    expect(statAudio("audio/dir.mp3")).toBeNull();
  });

  it("writeFileAtomic creates parent dirs, handles large buffers and leaves no temp file on failure", () => {
    const target = path.join(dir, "nested", "deep", "big.bin");
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    writeFileAtomic(target, big);
    expect(fs.statSync(target).size).toBe(big.length);

    // Target is a directory -> rename fails; the temp file must be cleaned up.
    const asDir = path.join(dir, "nested", "isdir");
    fs.mkdirSync(asDir);
    fs.writeFileSync(path.join(asDir, "child"), "x");
    expect(() => writeFileAtomic(asDir, Buffer.from("data"))).toThrow();
    expect(fs.readdirSync(path.join(dir, "nested")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
