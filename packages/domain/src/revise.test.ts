import { describe, expect, it } from "vitest";
import { locateMessage, parseLocation, placeLocation, paragraphsOf, reviseMessage, revisedPart } from "./revise.js";

describe("reviseMessage", () => {
  it("marks the part and cuts the text around it", () => {
    const translation = `${"Before. ".repeat(100)}WRONG PART${" After.".repeat(100)}`;
    const from = translation.indexOf("WRONG");
    const m = reviseMessage([{ source: "太郎", target: "Taro" }], ["note"], "原文", translation, from, from + 10, 60);
    expect(m).toContain("[[REDO]]WRONG PART[[/REDO]]");
    expect(m).toContain("SOURCE_BLOCK:\n原文");
    expect(m.length).toBeLessThan(500);
  });
});

describe("revisedPart", () => {
  it("drops markers and keeps the space around the part", () => {
    expect(revisedPart("[[REDO]]New text.[[/REDO]]", "\nOld text. ")).toBe("\nNew text. ");
  });
  it("is null for an empty reply", () => {
    expect(revisedPart("  ", "x")).toBeNull();
  });
});

describe("parseLocation", () => {
  it("reads ranges and rejects lines that make no sense or go back", () => {
    const r = parseLocation("P1: S2-S3\nP2: S1\nP3: S4\nP4: S9", 4, 5);
    expect(r[0]).toEqual({ first: 2, last: 3 });
    expect(r[1]).toBeNull(); // goes back before P1
    expect(r[2]).toEqual({ first: 4, last: 4 });
    expect(r[3]).toBeNull(); // no such sentence
  });
});

describe("locating", () => {
  const source = "一つ目。二つ目。\n三つ目。";
  it("numbers the sentences and the paragraphs", () => {
    expect(locateMessage(source, "One.\nTwo.")).toBe("SOURCE:\nS1: 一つ目。\nS2: 二つ目。\nS3: 三つ目。\n\nTRANSLATION:\nP1: One.\nP2: Two.");
  });
  it("places paragraphs on the source from sentence ranges", () => {
    const placed = placeLocation(source, "One and two.\nThree.", [{ first: 1, last: 2 }, { first: 3, last: 3 }]);
    expect(source.slice(placed[0]!.source!.start, placed[0]!.source!.end)).toBe("一つ目。二つ目。");
    expect(source.slice(placed[1]!.source!.start, placed[1]!.source!.end)).toBe("三つ目。");
  });
  it("finds paragraphs with their place in the text", () => {
    expect(paragraphsOf("a\n\n  b ")).toEqual([{ start: 0, end: 1, text: "a" }, { start: 5, end: 6, text: "b" }]);
  });
});

describe("checking a rewritten part", () => {
  it("drops words repeated from around the part", async () => {
    const { withoutEcho, tooLong, sentenceUnits } = await import("./revise.js");
    expect(withoutEcho("had been enchanted by me. The Beast King's Fang, and then", "weapons used by adventurers in this guild, had been enchanted by me. ", ", and then more")).toBe("The Beast King's Fang");
    expect(tooLong("x".repeat(120), "The Fang of the Beast King")).toBe(true);
    expect(tooLong("The Beast King's Fang", "The Fang of the Beast King")).toBe(false);
    // two sentences inside one quote are one piece
    expect(sentenceUnits("「一つ？　二つ。」\n三つ。").map((u) => u.text)).toEqual(["「一つ？　二つ。」", "三つ。"]);
  });
});

describe("paragraphs that are split or joined", () => {
  it("clips a range that reaches into the next paragraph", () => {
    const r = parseLocation("P1: S1-S6\nP2: S3-S4", 2, 8);
    expect(r[0]).toEqual({ first: 1, last: 3 });
    expect(r[1]).toEqual({ first: 3, last: 4 });
  });
  it("grows the range over paragraphs that share source text", async () => {
    const { rewriteRange } = await import("./revise.js");
    const located = [
      { from: 0, to: 10, source: { start: 0, end: 20 } }, // one source paragraph written as two
      { from: 12, to: 20, source: { start: 0, end: 20 } },
      { from: 22, to: 40, source: { start: 22, end: 60 } },
    ];
    expect(rewriteRange(located, 14, 14)).toEqual({ from: 0, to: 20, source: { start: 0, end: 20 } });
    expect(rewriteRange(located, 30, 30)).toEqual({ from: 22, to: 40, source: { start: 22, end: 60 } });
  });
});

describe("dropContradicted", () => {
  it("marks a paragraph as not known when its name is not in the place it was mapped to", async () => {
    const { dropContradicted } = await import("./revise.js");
    const source = "花子は笑った。\n太郎は泣いた。";
    const translation = "Hanako laughed.\nTaro cried.";
    const names = [{ source: "花子", aliases: [], english: "Hanako" }, { source: "太郎", aliases: [], english: "Taro" }];
    const right = placeLocation(source, translation, [{ first: 1, last: 1 }, { first: 2, last: 2 }]);
    expect(dropContradicted(right, translation, source, names).map((p) => p.source !== null)).toEqual([true, true]);
    const wrong = placeLocation(source, translation, [{ first: 2, last: 2 }, { first: 2, last: 2 }]);
    expect(dropContradicted(wrong, translation, source, names).map((p) => p.source !== null)).toEqual([false, true]);
  });
});
