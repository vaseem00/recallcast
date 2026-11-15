import { describe, expect, it } from "vitest";
import { parseIsoDuration } from "./duration";

describe("parseIsoDuration", () => {
  it.each([
    ["PT45S", 45],
    ["PT1M", 60],
    ["PT4M13S", 253],
    ["PT1H", 3600],
    ["PT1H2M3S", 3723],
    ["PT10H0M1S", 36001],
    ["P1DT2H", 93600],
    ["P1D", 86400],
    ["P1W", 604800],
    ["P0D", 0],
    ["PT0S", 0],
    ["PT1.5S", 2],
    ["pt2m", 120],
    [" PT3M ", 180],
  ])("%s -> %i", (input, expected) => {
    expect(parseIsoDuration(input)).toBe(expected);
  });

  it.each(["", "P", "PT", "1H2M", "PT1H2X", "P1Y", "P1M", "PT-5S", "PTS", "hello"])("rejects %j", (input) => {
    expect(parseIsoDuration(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
  });
});
