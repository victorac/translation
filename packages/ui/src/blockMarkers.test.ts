import { describe, expect, it } from "vitest";
import { blockMarkers, type PreviewBlock } from "./blockMarkers";

const block = (index: number, text: string, boundaryKind: PreviewBlock["boundaryKind"] = "paragraph", estimatedTokens = text.length): PreviewBlock => ({ index, text, boundaryKind, estimatedTokens });

describe("blockMarkers", () => {
  it("places each block at its offset in the text", () => {
    const m = blockMarkers("一。\n\n二。\n\n三。", [block(0, "一。\n\n"), block(1, "二。\n\n"), block(2, "三。", "end")])!;
    expect(m.map((x) => [x.index, x.start, x.end])).toEqual([[0, 0, 4], [1, 4, 8], [2, 8, 10]]);
    expect(m.every((x) => x.atLineStart)).toBe(true);
    expect(m.every((x) => x.warning === null)).toBe(true);
  });

  it("says when a block starts in the middle of a line (a cut), and warns about unnatural endings", () => {
    const m = blockMarkers("あいうえおかきくけこ", [block(0, "あいうえお", "hard"), block(1, "かきくけこ", "end")])!;
    expect(m[0]).toMatchObject({ atLineStart: true, warning: expect.stringContaining("middle of text") });
    expect(m[1]).toMatchObject({ atLineStart: false, start: 5, warning: null });
  });

  it("marks a block that begins after a rough cut, but not one that begins after a clean sentence end", () => {
    const m = blockMarkers("あいうえおかきくけこ。さしす", [block(0, "あいうえお", "hard"), block(1, "かきくけこ。", "sentence"), block(2, "さしす", "end")])!;
    expect(m.map((x) => x.cutBefore)).toEqual([false, true, false]);
  });

  it("counts a block that starts right after a line break as starting a line", () => {
    const m = blockMarkers("一行目\n二行目", [block(0, "一行目\n", "line"), block(1, "二行目", "end")])!;
    expect(m[1]!.atLineStart).toBe(true);
  });

  it("refuses a split that is not this text, so nothing is drawn in the wrong place", () => {
    expect(blockMarkers("changed text", [block(0, "old text", "end")])).toBeNull();
    expect(blockMarkers("longer text than the blocks", [block(0, "longer text", "end")])).toBeNull();
    expect(blockMarkers("short", [block(0, "short text", "end")])).toBeNull();
  });

  it("handles an empty text and a text with no blocks", () => {
    expect(blockMarkers("", [])).toEqual([]);
    expect(blockMarkers("x", [])).toBeNull();
  });

  it("keeps the token estimates", () => {
    expect(blockMarkers("ab", [block(0, "ab", "end", 7)])![0]!.tokens).toBe(7);
  });
});
