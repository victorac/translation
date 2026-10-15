import {
  describe,
  expect,
  it,
} from "vitest";
import fc from "fast-check";
import {
  chunkSource,
  defaultIsChapterSeparator,
  type ChunkBlock,
} from "./chunker.js";
import {
  estimateTokens,
} from "./tokens.js";
import {
  dialogueJa,
  mixedUnicode,
  quotedAttribution,
  withChapters,
} from "../fixtures/samples.js";

const texts = (src: string, blocks: ChunkBlock[]) => blocks.map((b) => src.slice(b.startOffset, b.endOffset));

function assertLossless(src: string, blocks: ChunkBlock[]) {
  expect(texts(src, blocks).join("")).toBe(src);
  let pos = 0;
  for (const b of blocks) {
    expect(b.startOffset).toBe(pos);
    expect(b.endOffset).toBeGreaterThan(b.startOffset);
    pos = b.endOffset;
  }
  expect(pos).toBe(src.length);
}

function assertNoSurrogateSplit(src: string, blocks: ChunkBlock[]) {
  for (const b of blocks.slice(1)) {
    const i = b.startOffset;
    const hi = src.charCodeAt(i - 1);
    const lo = src.charCodeAt(i);
    expect(hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff).toBe(false);
  }
}

describe("chunkSource basics", () => {
  it("returns no blocks for empty text and one block for whitespace-only text", () => {
    expect(chunkSource("")).toEqual([]);
    expect(chunkSource(" \n\n ")).toHaveLength(1);
  });

  it("keeps a short document in one block ending with `end`", () => {
    const b = chunkSource(dialogueJa);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ index: 0, startOffset: 0, endOffset: dialogueJa.length, boundaryKind: "end" });
  });

  it("packs paragraphs toward the target without exceeding it when units fit", () => {
    const src = "あいうえお。\n\nかきくけこ。\n\nさしすせそ。\n\nたちつてと。";
    const b = chunkSource(src, { targetTokens: 16, maxTokens: 24 });
    assertLossless(src, b);
    expect(b.length).toBeGreaterThan(1);
    for (const x of b) expect(x.estimatedTokens).toBeLessThanOrEqual(24);
    expect(b[0]!.boundaryKind).toBe("paragraph");
  });

  it("rejects invalid limits", () => {
    expect(() => chunkSource("a", { maxTokens: 0 })).toThrow(RangeError);
    expect(() => chunkSource("a", { targetTokens: 0 })).toThrow(RangeError);
  });

  it("splits sentences on 。！？ but not on a decimal point", () => {
    const src = "値は3.14です。次へ！さらに？終わり.";
    const b = chunkSource(src, { targetTokens: 6, maxTokens: 20 });
    assertLossless(src, b);
    expect(texts(src, b).some((t) => t.includes("3.14"))).toBe(true);
    expect(texts(src, b).every((t) => !t.endsWith("3.") && !t.endsWith("3"))).toBe(true);
  });
});

describe("quotes", () => {
  it("does not split inside a quote pair when the quoted unit fits", () => {
    const b = chunkSource(quotedAttribution, { targetTokens: 12, maxTokens: 24 });
    assertLossless(quotedAttribution, b);
    expect(texts(quotedAttribution, b)[0]).toBe("「今日は晴れだ。散歩に行こう。」と彼は言った。");
  });

  it("makes a marked `quote` split when a quoted unit exceeds the maximum", () => {
    const src = "「" + "あいうえお。".repeat(10) + "」";
    const b = chunkSource(src, { targetTokens: 12, maxTokens: 14 });
    assertLossless(src, b);
    expect(b.some((x) => x.boundaryKind === "quote")).toBe(true);
    for (const x of b) expect(x.estimatedTokens).toBeLessThanOrEqual(14);
  });

  it("separates adjacent quoted lines into sentence units", () => {
    const src = "「A。」「B。」「C。」";
    const b = chunkSource(src, { targetTokens: 4, maxTokens: 5 });
    assertLossless(src, b);
    expect(texts(src, b)).toEqual(["「A。」", "「B。」", "「C。」"]);
  });
});

describe("chapter separators", () => {
  it("recognises dividers", () => {
    for (const l of ["***", "* * *", "---", "＊＊＊", "◆◆◆", "===="]) expect(defaultIsChapterSeparator(l)).toBe(true);
    for (const l of ["**", "abc", "-*-", "第一章", ""]) expect(defaultIsChapterSeparator(l)).toBe(false);
  });

  it("never packs across a separator; the separator opens the next block", () => {
    const b = chunkSource(withChapters, { targetTokens: 600, maxTokens: 900 });
    assertLossless(withChapters, b);
    const t = texts(withChapters, b);
    expect(t).toHaveLength(3);
    expect(t[1]!.startsWith("***")).toBe(true);
    expect(t[2]!.startsWith("* * *")).toBe(true);
    expect(b[0]!.boundaryKind).toBe("chapter");
  });
});

describe("oversized spans and Unicode", () => {
  it("hard-splits uninterrupted text on scalar boundaries", () => {
    const src = "👍".repeat(25);
    const b = chunkSource(src, { targetTokens: 10, maxTokens: 10 });
    assertLossless(src, b);
    assertNoSurrogateSplit(src, b);
    expect(b.map((x) => x.estimatedTokens)).toEqual([10, 10, 5]);
    expect(b[0]!.boundaryKind).toBe("hard");
  });

  it("uses whitespace boundaries for long Latin text before hard splitting", () => {
    const src = "word ".repeat(20);
    const b = chunkSource(src, { targetTokens: 12, maxTokens: 12 });
    assertLossless(src, b);
    expect(b.some((x) => x.boundaryKind === "whitespace")).toBe(true);
    for (const t of texts(src, b)) expect(t.endsWith(" ")).toBe(true);
  });

  it("keeps mixed Unicode intact", () => {
    for (const max of [3, 5, 9, 40]) {
      const b = chunkSource(mixedUnicode, { targetTokens: max, maxTokens: max });
      assertLossless(mixedUnicode, b);
      assertNoSurrogateSplit(mixedUnicode, b);
      for (const x of b) expect(x.estimatedTokens).toBeLessThanOrEqual(max);
    }
  });

  it("is deterministic", () => {
    const o = { targetTokens: 8, maxTokens: 12 };
    expect(chunkSource(dialogueJa, o)).toEqual(chunkSource(dialogueJa, o));
  });
});

describe("properties", () => {
  const piece = fc.constantFrom(
    "こんにちは", "「", "」", "。", "！", "\n", "\n\n", " ", "Hello", ".", "👍🏽", "𠮷", "***\n", "* * *\n",
    "\r\n", "a", "『", "』", "3.14", "　",
  );
  const structured = fc.array(piece, { maxLength: 120 }).map((a) => a.join(""));
  const anyText = fc.oneof(structured, fc.string({ unit: "binary", maxLength: 300 }));
  const limits = fc.integer({ min: 4, max: 60 }).chain((max) =>
    fc.integer({ min: 1, max }).map((target) => ({ maxTokens: max, targetTokens: target })),
  );

  it("is lossless, contiguous, scalar-safe and within maxTokens", () => {
    fc.assert(
      fc.property(anyText, limits, (src, o) => {
        const b = chunkSource(src, o);
        assertLossless(src, b);
        assertNoSurrogateSplit(src, b);
        for (const x of b) expect(x.estimatedTokens).toBeLessThanOrEqual(o.maxTokens);
        for (const x of b) expect(x.estimatedTokens).toBe(estimateTokens(src.slice(x.startOffset, x.endOffset)));
        expect(b.map((x) => x.index)).toEqual(b.map((_, i) => i));
        if (b.length) expect(b[b.length - 1]!.boundaryKind).toBe("end");
      }),
      { numRuns: 500 },
    );
  });

  it("starts a block at every chapter separator line", () => {
    fc.assert(
      fc.property(structured, (src) => {
        const b = chunkSource(src, { targetTokens: 40, maxTokens: 60 });
        const starts = new Set(b.map((x) => x.startOffset));
        let pos = 0;
        for (const line of src.split("\n")) {
          if (line.trim() !== "" && defaultIsChapterSeparator(line)) {
            const leadingOnly = src.slice(0, pos).trim() === "";
            expect(starts.has(pos) || leadingOnly).toBe(true);
          }
          pos += line.length + 1;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is lossless at default limits on large input", () => {
    const src = ("彼は言った。「そうだね。」\n\n" + "x".repeat(50) + "。").repeat(500);
    const b = chunkSource(src);
    assertLossless(src, b);
    for (const x of b) expect(x.estimatedTokens).toBeLessThanOrEqual(900);
  });
});
