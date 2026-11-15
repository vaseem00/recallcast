import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { audioPathFor, removeStoredFile, resolveStoragePath } from "@/lib/storage";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recallcast-storage-"));
process.env.STORAGE_DIR = dir;
resetEnvCache();

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("storage", () => {
  it("builds audio paths relative to STORAGE_DIR and removes files", () => {
    const { relative, absolute } = audioPathFor("abc-123");
    expect(relative).toBe("audio/abc-123.mp3");
    expect(absolute).toBe(path.join(dir, "audio", "abc-123.mp3"));
    fs.writeFileSync(absolute, "x");
    removeStoredFile(relative);
    expect(fs.existsSync(absolute)).toBe(false);
  });

  it("rejects traversal", () => {
    expect(() => resolveStoragePath("../evil")).toThrow();
    expect(() => audioPathFor("../x")).toThrow();
  });
});
