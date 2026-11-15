import { describe, expect, it } from "vitest";
import { isValidPlaylistId, isValidVideoId, parseYouTubeUrl, type ParsedYouTubeUrl } from "./parse";

const VID = "dQw4w9WgXcQ";
const PL = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";
const video = (videoId: string = VID): ParsedYouTubeUrl => ({ kind: "video", videoId });
const playlist = (playlistId: string = PL): ParsedYouTubeUrl => ({ kind: "playlist", playlistId });

const cases: Array<[label: string, input: string, expected: ParsedYouTubeUrl]> = [
  // ---- playlists ----
  ["playlist page", `https://www.youtube.com/playlist?list=${PL}`, playlist()],
  ["playlist page without www", `https://youtube.com/playlist?list=${PL}`, playlist()],
  ["playlist page on http", `http://www.youtube.com/playlist?list=${PL}`, playlist()],
  ["playlist on m.youtube.com", `https://m.youtube.com/playlist?list=${PL}`, playlist()],
  ["playlist on music.youtube.com", `https://music.youtube.com/playlist?list=${PL}`, playlist()],
  ["playlist with extra params", `https://www.youtube.com/playlist?si=abc123&list=${PL}&feature=share`, playlist()],
  ["playlist with fragment", `https://www.youtube.com/playlist?list=${PL}#top`, playlist()],
  ["uploads (UU) playlist", "https://www.youtube.com/playlist?list=UUBR8-60-B28hp2BmDPdntcQ", playlist("UUBR8-60-B28hp2BmDPdntcQ")],
  ["OL album playlist", "https://music.youtube.com/playlist?list=OLAK5uy_kM8k2fYV1bJ0Qz5tVw0Q", playlist("OLAK5uy_kM8k2fYV1bJ0Qz5tVw0Q")],
  ["watch with v and list -> playlist", `https://www.youtube.com/watch?v=${VID}&list=${PL}`, playlist()],
  ["watch with list first then v -> playlist", `https://www.youtube.com/watch?list=${PL}&v=${VID}&index=3`, playlist()],
  ["watch with list only", `https://www.youtube.com/watch?list=${PL}`, playlist()],
  ["music watch with list", `https://music.youtube.com/watch?v=${VID}&list=${PL}`, playlist()],
  ["youtu.be with list -> playlist", `https://youtu.be/${VID}?list=${PL}`, playlist()],
  ["embed videoseries", `https://www.youtube.com/embed/videoseries?list=${PL}`, playlist()],
  ["embed with list", `https://www.youtube-nocookie.com/embed/${VID}?list=${PL}`, playlist()],
  ["scheme-less playlist", `youtube.com/playlist?list=${PL}`, playlist()],
  ["scheme-less www playlist", `www.youtube.com/playlist?list=${PL}`, playlist()],
  ["protocol-relative playlist", `//www.youtube.com/playlist?list=${PL}`, playlist()],
  ["surrounding whitespace is trimmed", `   https://www.youtube.com/playlist?list=${PL}\n\t`, playlist()],
  ["uppercase host", `HTTPS://WWW.YOUTUBE.COM/playlist?list=${PL}`, playlist()],
  ["trailing dot host", `https://www.youtube.com./playlist?list=${PL}`, playlist()],

  // ---- videos ----
  ["watch", `https://www.youtube.com/watch?v=${VID}`, video()],
  ["watch with timestamp", `https://www.youtube.com/watch?v=${VID}&t=42s`, video()],
  ["watch with feature first", `https://www.youtube.com/watch?feature=shared&v=${VID}`, video()],
  ["m.youtube watch", `https://m.youtube.com/watch?v=${VID}`, video()],
  ["music watch", `https://music.youtube.com/watch?v=${VID}`, video()],
  ["youtu.be", `https://youtu.be/${VID}`, video()],
  ["youtu.be with si and t", `https://youtu.be/${VID}?si=XyZ&t=10`, video()],
  ["youtu.be scheme-less", `youtu.be/${VID}`, video()],
  ["shorts", `https://www.youtube.com/shorts/${VID}`, video()],
  ["shorts with trailing slash and query", `https://youtube.com/shorts/${VID}/?feature=share`, video()],
  ["embed", `https://www.youtube.com/embed/${VID}`, video()],
  ["nocookie embed", `https://www.youtube-nocookie.com/embed/${VID}?start=30`, video()],
  ["live", `https://www.youtube.com/live/${VID}?si=abc`, video()],
  ["legacy /v/", `https://www.youtube.com/v/${VID}`, video()],
  ["id with dash and underscore", "https://youtu.be/a_b-C1d2E3f", video("a_b-C1d2E3f")],
  ["mix (RD) list falls back to the video", `https://www.youtube.com/watch?v=${VID}&list=RD${VID}&start_radio=1`, video()],
  ["invalid list falls back to the video", `https://www.youtube.com/watch?v=${VID}&list=WL`, video()],
  ["liked-videos list falls back to the video", `https://www.youtube.com/watch?v=${VID}&list=LL`, video()],

  // ---- rejected ----
  ["empty string", "", null],
  ["whitespace only", "   \n ", null],
  ["bare video id", VID, null],
  ["bare playlist id", PL, null],
  ["plain words", "not a url at all", null],
  ["javascript: URL", "javascript:alert(document.cookie)//youtube.com/watch?v=dQw4w9WgXcQ", null],
  ["javascript: with youtube host lookalike", `javascript://www.youtube.com/watch?v=${VID}%0aalert(1)`, null],
  ["data: URL", `data:text/html,<a href="https://youtu.be/${VID}">x</a>`, null],
  ["ftp scheme", `ftp://www.youtube.com/watch?v=${VID}`, null],
  ["file scheme", `file:///www.youtube.com/watch?v=${VID}`, null],
  ["host suffix attack", `https://youtube.com.evil.com/watch?v=${VID}`, null],
  ["www host suffix attack", `https://www.youtube.com.evil.com/playlist?list=${PL}`, null],
  ["host prefix attack", `https://evilyoutube.com/watch?v=${VID}`, null],
  ["subdomain of evil", `https://youtube.evil.com/watch?v=${VID}`, null],
  ["youtu.be lookalike", `https://youtu.be.evil.com/${VID}`, null],
  ["userinfo trick", `https://www.youtube.com@evil.com/watch?v=${VID}`, null],
  ["credentials on youtube host", `https://user:pass@www.youtube.com/watch?v=${VID}`, null],
  ["custom port", `https://www.youtube.com:8443/watch?v=${VID}`, null],
  ["unknown subdomain", `https://studio.youtube.com/video/${VID}/edit`, null],
  ["google.com redirect", `https://www.google.com/url?q=https://www.youtube.com/watch?v=${VID}`, null],
  ["channel page", "https://www.youtube.com/@veritasium", null],
  ["channel videos tab", "https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA/videos", null],
  ["home page", "https://www.youtube.com/", null],
  ["watch without params", "https://www.youtube.com/watch", null],
  ["video id too short", "https://www.youtube.com/watch?v=dQw4w9WgXc", null],
  ["video id too long", "https://www.youtube.com/watch?v=dQw4w9WgXcQQ", null],
  ["video id with bad chars", "https://www.youtube.com/watch?v=dQw4w9Wg%3CQ", null],
  ["youtu.be with extra path", `https://youtu.be/${VID}/extra`, null],
  ["youtu.be root", "https://youtu.be/", null],
  ["shorts without id", "https://www.youtube.com/shorts/", null],
  ["playlist without list", "https://www.youtube.com/playlist", null],
  ["playlist with short list id", "https://www.youtube.com/playlist?list=WL", null],
  ["playlist with injection chars", `https://www.youtube.com/playlist?list=${PL}%22%3E%3Cscript%3E`, null],
  ["mix playlist only", `https://www.youtube.com/playlist?list=RD${VID}`, null],
  ["embedded whitespace", `https://www.you tube.com/watch?v=${VID}`, null],
  ["embedded newline", `https://www.youtube.com/watch?v=${VID}\nhttps://evil.com`, null],
  ["very long input", `https://www.youtube.com/watch?v=${VID}&x=${"a".repeat(3000)}`, null],
];

describe("parseYouTubeUrl", () => {
  it("has a large table", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases)("%s", (_label, input, expected) => {
    expect(parseYouTubeUrl(input)).toEqual(expected);
  });

  it("returns null for non-string input at runtime", () => {
    expect(parseYouTubeUrl(undefined as unknown as string)).toBeNull();
    expect(parseYouTubeUrl(42 as unknown as string)).toBeNull();
  });
});

describe("id validators", () => {
  it("validates video ids", () => {
    expect(isValidVideoId(VID)).toBe(true);
    expect(isValidVideoId("short")).toBe(false);
    expect(isValidVideoId("dQw4w9WgXc/")).toBe(false);
  });

  it("validates playlist ids", () => {
    expect(isValidPlaylistId(PL)).toBe(true);
    expect(isValidPlaylistId("WL")).toBe(false);
    expect(isValidPlaylistId("PL bad id here")).toBe(false);
  });
});
