import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createRevision, RevisionError, verifyRevision, blockText, type SourceRevision } from "./revision.js";
import { sha256Hex } from "./platform.js";
import { dialogueJa, mixedUnicode } from "../fixtures/samples.js";

const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const make = (text: string, extra: Partial<Parameters<typeof createRevision>[0]> = {}) =>
  createRevision({ text, sourceLanguage: "ja", targetLanguage: "en", ...extra }, { newId: counter() });

describe("createRevision", () => {
  it("AC-01: normalizes mixed newlines, keeps Unicode, and reproduces the source from blocks", () => {
    const raw = "A\r\nB\rこんにちは 👍🏽 Alice\n\n𠮷野家";
    const rev = make(raw, { targetTokens: 5, maxTokens: 8 });
    expect(rev.exactText).toBe("A\nB\nこんにちは 👍🏽 Alice\n\n𠮷野家");
    expect(rev.blocks.map((b) => blockText(rev, b)).join("")).toBe(rev.exactText);
    expect(rev.sha256).toBe(sha256Hex(rev.exactText));
    expect(verifyRevision(rev)).toEqual([]);
  });

  it("assigns unique block ids tied to the revision, with per-block hashes", () => {
    const rev = make(mixedUnicode, { targetTokens: 6, maxTokens: 10 });
    expect(rev.blocks.length).toBeGreaterThan(1);
    expect(new Set(rev.blocks.map((b) => b.id)).size).toBe(rev.blocks.length);
    for (const b of rev.blocks) {
      expect(b.revisionId).toBe(rev.id);
      expect(b.textHash).toBe(sha256Hex(blockText(rev, b)));
    }
    expect(rev.chunkSettings).toEqual({ targetTokens: 6, maxTokens: 10, estimator: "scalar-v1" });
  });

  it("AC-09: a derived revision gets new ids and records its parent; the parent is untouched", () => {
    const parent = make(dialogueJa);
    const snapshot = structuredClone(parent);
    const child = createRevision(
      { text: dialogueJa + "追記。", sourceLanguage: "ja", targetLanguage: "en", parentId: parent.id },
      { newId: counter() },
    );
    expect(child.parentId).toBe(parent.id);
    expect(parent).toEqual(snapshot);
    const real = createRevision({ text: dialogueJa, sourceLanguage: "ja", targetLanguage: "en" });
    const real2 = createRevision({ text: dialogueJa, sourceLanguage: "ja", targetLanguage: "en" });
    expect(real.id).not.toBe(real2.id);
    expect(real.blocks[0]!.id).not.toBe(real2.blocks[0]!.id);
    expect(real.sha256).toBe(real2.sha256);
  });

  it("rejects empty, oversized and over-fragmented sources with typed errors", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof RevisionError ? e.code : "other";
      }
      return "none";
    };
    expect(code(() => make(" \r\n\n "))).toBe("empty");
    expect(code(() => make("あ".repeat(20), { maxSourceBytes: 30 }))).toBe("too_large"); // 60 bytes
    expect(code(() => make("a b c d e f g h", { maxTokens: 2, targetTokens: 2, maxBlocks: 3 }))).toBe("too_many_blocks");
    expect(code(() => make("x", { maxTokens: 0 }))).toBe("invalid_options");
  });

  it("counts bytes after normalization, so CRLF input is not penalized", () => {
    expect(() => make("a\r\nb\r\nc", { maxSourceBytes: 5 })).not.toThrow();
  });

  it("is lossless for arbitrary text at arbitrary limits", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", minLength: 1, maxLength: 200 }), fc.integer({ min: 4, max: 50 }), (s, max) => {
        if (s.trim() === "") return;
        const rev = make(s, { maxTokens: max, targetTokens: max, maxBlocks: 10_000 });
        expect(verifyRevision(rev)).toEqual([]);
        expect(rev.blocks.map((b) => blockText(rev, b)).join("")).toBe(rev.exactText);
      }),
      { numRuns: 200 },
    );
  });
});

describe("verifyRevision", () => {
  const base = () => make("一つ目。\n\n二つ目。\n\n三つ目。", { targetTokens: 5, maxTokens: 6 });
  const codes = (r: SourceRevision) => verifyRevision(r).map((p) => p.code);

  it("reports tampered text, hashes, offsets and ids without repairing anything", () => {
    const r1 = base();
    r1.exactText = r1.exactText.replace("二", "2");
    expect(codes(r1)).toEqual(expect.arrayContaining(["hash_mismatch", "block_hash_mismatch"]));

    const r2 = base();
    r2.blocks[1]!.startOffset += 1;
    expect(codes(r2)).toContain("block_gap");

    const r3 = base();
    r3.blocks.pop();
    expect(codes(r3)).toContain("incomplete_coverage");

    const r4 = base();
    r4.blocks[1]!.id = r4.blocks[0]!.id;
    expect(codes(r4)).toContain("block_duplicate_id");

    const r5 = base();
    r5.blocks[0]!.revisionId = "other";
    expect(codes(r5)).toContain("block_revision");

    const r6 = base();
    r6.blocks[1]!.index = 7;
    expect(codes(r6)).toContain("block_index");

    const r7 = base();
    const before = structuredClone(r7);
    r7.exactText = "a\r\nb";
    expect(codes(r7)).toContain("text_not_normalized");
    expect(before.exactText).not.toBe(r7.exactText);
  });

  it("flags a block that starts inside a surrogate pair", () => {
    const rev = make("👍👍👍");
    rev.blocks = [
      { ...rev.blocks[0]!, endOffset: 3, textHash: sha256Hex(rev.exactText.slice(0, 3)) },
      { ...rev.blocks[0]!, id: "b2", index: 1, startOffset: 3, textHash: sha256Hex(rev.exactText.slice(3)) },
    ];
    expect(codes(rev)).toContain("block_splits_surrogate");
  });
});
