import { describe, expect, it } from "vitest";
import { answerOf, joinParts, missingNames, paragraphMessage, paragraphsOf, paragraphSystem } from "./paragraphs.js";

const request = {
  glossary: [{ source: "太郎", target: "Taro", note: "a boy" }, { source: "食べる", target: "", note: "use the past tense" }],
  notes: ["note"],
  sourceLanguage: "Japanese",
  previous: null,
  sourceBefore: ["前。"],
  paragraph: "本文。",
  sourceAfter: ["後。"],
  translatedBefore: ["Before."],
  translatedAfter: [],
};

describe("paragraphMessage", () => {
  it("puts the background first, the translation so far with an empty place next, and the task last", () => {
    const m = paragraphMessage(request);
    expect(m).toContain("GLOSSARY:\n- 太郎 => Taro\n");
    expect(m).toContain("WORD NOTES (instructions about how to translate particular words; follow them):\n- 太郎: a boy\n- 食べる: use the past tense");
    expect(m).toContain("JAPANESE TEXT AROUND THE PARAGRAPH (reference only; the paragraph is one of these):\n前。\n\n本文。\n\n後。");
    expect(m).toContain("TRANSLATION SO FAR:\nBefore.\n\n[[HERE]][[/HERE]]");
    expect(m).toContain("JAPANESE PARAGRAPH TO TRANSLATE:\n本文。");
    expect(m.trimEnd().endsWith("between [[HERE]] and [[/HERE]].")).toBe(true);
    expect(m).not.toContain("REJECTED");
  });
  it("shows the paragraphs after it when they are known, and a rejected version only when given", () => {
    const m = paragraphMessage({ ...request, translatedAfter: ["After."], rejected: "Old words." });
    expect(m).toContain("[[HERE]][[/HERE]]\n\nAfter.");
    expect(m).toContain("REJECTED VERSION");
  });
  it("leaves out the text around a lone paragraph", () => {
    expect(paragraphMessage({ ...request, sourceBefore: [], sourceAfter: [], translatedBefore: [] })).not.toContain("TEXT AROUND");
  });
  it("has the style only as guidance, and none for the standard one", () => {
    expect(paragraphSystem(null, "Japanese", "English")).not.toContain("Style of the whole translation");
    expect(paragraphSystem("Be literary.", "Japanese", "English")).toContain("Be literary.");
  });
});

describe("answerOf", () => {
  it("takes what is between the markers, or the whole reply without them", () => {
    expect(answerOf("Sure! [[HERE]]New text.[[/HERE]] Done.")).toBe("New text.");
    expect(answerOf("New text.")).toBe("New text.");
    expect(answerOf("  ")).toBeNull();
  });
});

describe("missingNames", () => {
  it("lists the glossary names of the paragraph that the translation does not use", () => {
    const glossary = [{ source: "花子", target: "Hanako" }, { source: "太郎", target: "Taro|Tarou" }, { source: "食べる", target: "" }];
    expect(missingNames(glossary, "花子と太郎。", "Hanako and Taro.")).toEqual([]);
    expect(missingNames(glossary, "花子と太郎。", "She and Tarou.")).toEqual(["花子 => Hanako"]);
    expect(missingNames(glossary, "他の人。", "Someone.")).toEqual([]); // not in the paragraph
  });
});

describe("paragraphs", () => {
  it("finds the paragraphs with their place in the text", () => {
    expect(paragraphsOf("a\n\n  b ")).toEqual([{ start: 0, end: 1, text: "a" }, { start: 5, end: 6, text: "b" }]);
  });
  it("joins the translated ones with a blank line", () => {
    expect(joinParts(["A.", " ", "B. "])).toBe("A.\n\nB.");
  });
});
