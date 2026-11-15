import { describe, expect, it } from "vitest";
import { cleanCaptionText, decodeEntities, parseJson3, parseTimedTextXml } from "./captions";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities, including double-escaped ones", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s &#x2014; ok")).toBe(
      "Tom & Jerry <3 \"hi\" it's — ok",
    );
    expect(decodeEntities("it&amp;#39;s")).toBe("it's");
  });

  it("leaves unknown or invalid entities alone", () => {
    expect(decodeEntities("&bogus; &#99999999;")).toBe("&bogus; &#99999999;");
  });
});

describe("cleanCaptionText", () => {
  it("collapses whitespace and strips zero-width marks", () => {
    expect(cleanCaptionText("  a\n b​\tc  ")).toBe("a b c");
    expect(cleanCaptionText("wo​rd")).toBe("word");
  });
});

describe("parseJson3", () => {
  it("maps events to segments in seconds and skips empty events", () => {
    const body = {
      events: [
        { tStartMs: 0, dDurationMs: 120000, id: 1 }, // window event, no segs
        { tStartMs: 1500, dDurationMs: 2500, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
        { tStartMs: 4000, dDurationMs: 10, segs: [{ utf8: "\n" }] },
        { tStartMs: 4100, segs: [{ utf8: "no duration" }] },
        { tStartMs: "bad", segs: [{ utf8: "x" }] },
      ],
    };
    expect(parseJson3(body)).toEqual([
      { start: 1.5, dur: 2.5, text: "Hello world" },
      { start: 4.1, dur: 0, text: "no duration" },
    ]);
  });

  it("returns [] for junk", () => {
    expect(parseJson3(null)).toEqual([]);
    expect(parseJson3("x")).toEqual([]);
    expect(parseJson3({ events: "nope" })).toEqual([]);
  });
});

describe("parseTimedTextXml", () => {
  it("parses the legacy <text start dur> format", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
      '<text start="0.5" dur="2.1">it&amp;#39;s a &lt;test&gt;</text>' +
      '<text start="2.6" dur="1">second\nline</text>' +
      '<text start="4">   </text>' +
      "</transcript>";
    expect(parseTimedTextXml(xml)).toEqual([
      { start: 0.5, dur: 2.1, text: "it's a <test>" },
      { start: 2.6, dur: 1, text: "second line" },
    ]);
  });

  it("parses the srv3 <p t d> format with nested spans", () => {
    const xml =
      '<timedtext format="3"><body>' +
      '<p t="1000" d="2000"><s>Hello</s><s t="500"> there</s></p>' +
      '<p t="3500" d="1500">General &amp; specific</p>' +
      "</body></timedtext>";
    expect(parseTimedTextXml(xml)).toEqual([
      { start: 1, dur: 2, text: "Hello there" },
      { start: 3.5, dur: 1.5, text: "General & specific" },
    ]);
  });

  it("returns [] for empty or non-caption payloads", () => {
    expect(parseTimedTextXml("")).toEqual([]);
    expect(parseTimedTextXml("<html><body>captcha</body></html>")).toEqual([]);
  });
});
