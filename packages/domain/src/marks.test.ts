import {
  describe,
  expect,
  it,
} from "vitest";
import {
  sourceMarks,
  translationMarks,
} from "./marks.js";
import type { Word } from "./work.js";

const word = (source: string, english: string, over: Partial<Word> = {}): Word => ({ source, english, kind: "character", aliases: [], reading: "", known: true, ...over });

describe("marking the words of the glossary", () => {
  it("marks a word in the source by kind and status, and not a short name inside a longer one", () => {
    const words = [word("水瀬灯", "Akari Minase"), word("灯", ""), word("灯籠祭", "", { kind: "term", suggestions: { english: ["Lantern Festival"] } })];
    expect(sourceMarks("水瀬灯は灯籠祭に行った。灯、と呼ばれた。", words)).toEqual([
      { start: 0, end: 3, source: "水瀬灯", kind: "character", status: "fixed" },
      { start: 4, end: 7, source: "灯籠祭", kind: "term", status: "suggested" },
      { start: 12, end: 13, source: "灯", kind: "character", status: "suggested" },
    ]);
  });

  it("leaves out an ignored word", () => {
    expect(sourceMarks("山田が来た。", [word("山田", "Yamada", { use: false })])).toEqual([]);
  });

  it("finds the English name in any case, as a whole word, the longer name first", () => {
    const words = [word("水瀬灯", "Akari Minase"), word("水瀬", "Minase", { kind: "family" }), word("灯籠祭", "Lantern Festival", { kind: "term" })];
    const text = "Akari Minase went to the lantern festivals. The Minase house; Minases.";
    expect(translationMarks(text, words).map((m) => text.slice(m.start, m.end))).toEqual(["Akari Minase", "lantern festivals", "Minase"]);
  });

  it("marks a suggested English name as a suggestion, and a word with none not at all", () => {
    const words = [word("灯", "", { suggestions: { english: ["Akari"] } }), word("山田", "")];
    expect(translationMarks("Akari's lamp, Akarin.", words)).toEqual([{ start: 0, end: 5, source: "灯", kind: "character", status: "suggested" }]);
  });
});
