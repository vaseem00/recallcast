import { describe, expect, it } from "vitest";
import { youtubeTimestampUrl } from "./links";

describe("youtubeTimestampUrl", () => {
  it("builds the spec link, flooring seconds", () => {
    expect(youtubeTimestampUrl("dQw4w9WgXcQ", 83.7)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s");
    expect(youtubeTimestampUrl("dQw4w9WgXcQ", -3)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s");
    expect(youtubeTimestampUrl("dQw4w9WgXcQ", Number.NaN)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s");
  });

  it("encodes unexpected ids instead of injecting them", () => {
    expect(youtubeTimestampUrl("a&b=c", 1)).toBe("https://www.youtube.com/watch?v=a%26b%3Dc&t=1s");
  });
});
