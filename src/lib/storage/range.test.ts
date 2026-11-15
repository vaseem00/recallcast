import { describe, expect, it } from "vitest";
import { contentRange, parseRange, unsatisfiedRange } from "./range";

describe("parseRange", () => {
  const size = 1000;

  it("no header / other units / multiple ranges -> full body", () => {
    expect(parseRange(null, size)).toEqual({ type: "none" });
    expect(parseRange(undefined, size)).toEqual({ type: "none" });
    expect(parseRange("", size)).toEqual({ type: "none" });
    expect(parseRange("items=0-5", size)).toEqual({ type: "none" });
    expect(parseRange("bytes=0-10, 20-30", size)).toEqual({ type: "none" });
  });

  it("closed, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-0", size)).toEqual({ type: "range", start: 0, end: 0 });
    expect(parseRange("bytes=0-499", size)).toEqual({ type: "range", start: 0, end: 499 });
    expect(parseRange("bytes=500-", size)).toEqual({ type: "range", start: 500, end: 999 });
    expect(parseRange("bytes=0-", size)).toEqual({ type: "range", start: 0, end: 999 });
    expect(parseRange("bytes=-100", size)).toEqual({ type: "range", start: 900, end: 999 });
    expect(parseRange("bytes=-5000", size)).toEqual({ type: "range", start: 0, end: 999 });
    expect(parseRange("BYTES = 10 - 20", size)).toEqual({ type: "range", start: 10, end: 20 });
    expect(parseRange("bytes=10-20,", size)).toEqual({ type: "range", start: 10, end: 20 });
  });

  it("clamps an end beyond the file", () => {
    expect(parseRange("bytes=900-5000", size)).toEqual({ type: "range", start: 900, end: 999 });
    expect(parseRange("bytes=999-999", size)).toEqual({ type: "range", start: 999, end: 999 });
  });

  it.each([
    "bytes=1000-",
    "bytes=1000-1001",
    "bytes=5000-6000",
    "bytes=-0",
    "bytes=20-10",
    "bytes=-",
    "bytes=",
    "bytes=abc",
    "bytes=1-2-3",
    "bytes=0x10-20",
    "bytes=-1.5",
    "bytes 0-10",
    "bytes=99999999999999999999-",
  ])("%j is unsatisfiable", (h) => {
    expect(parseRange(h, size)).toEqual({ type: "unsatisfiable" });
  });

  it("any range on an empty file is unsatisfiable", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ type: "unsatisfiable" });
    expect(parseRange("bytes=-10", 0)).toEqual({ type: "unsatisfiable" });
    expect(parseRange(null, 0)).toEqual({ type: "none" });
  });

  it("formats Content-Range", () => {
    expect(contentRange(0, 99, 1000)).toBe("bytes 0-99/1000");
    expect(unsatisfiedRange(1000)).toBe("bytes */1000");
  });
});
