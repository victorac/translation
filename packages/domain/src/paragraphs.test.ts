import {
  describe,
  expect,
  it,
} from "vitest";
import {
  answerOf,
  missingNames,
  paragraphMessage,
  paragraphsOf,
  paragraphSystem,
} from "./paragraphs.js";

const request = {
  glossary: [{ source: "太郎", target: "Taro", note: "a boy" }, { source: "食べる", target: "", note: "use the past tense" }],
  notes: ["note"],
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  before: [{ source: "前。", translation: "Before." }],
  paragraph: "本文。",
  next: [{ source: "後。", translation: null }],
};

describe("paragraphMessage", () => {
  it("puts the background first, the paragraphs around it for reference, and the paragraph and the task last", () => {
    const m = paragraphMessage(request);
    expect(m).toContain("GLOSSARY:\n- 太郎 => Taro\n");
    expect(m).toContain("WORD NOTES (instructions about how to translate particular words; follow them):\n- 太郎: a boy\n- 食べる: use the past tense");
    expect(m).toContain("CONTEXT (the paragraphs before this one, with their translations; reference only, do not translate):\nJAPANESE: 前。\nENGLISH: Before.");
    expect(m).toContain("NEXT (the paragraphs after this one, so that you know where the story goes; reference only, do not translate):\nJAPANESE: 後。");
    expect(m).toContain("JAPANESE PARAGRAPH TO TRANSLATE:\n本文。");
    expect(m.trimEnd().endsWith("Translate that paragraph into English. Reply with its translation only, as one paragraph.")).toBe(true);
    expect(m).not.toContain("REJECTED");
  });
  it("shows the translation of the next paragraph when it has one, and a rejected version only when given", () => {
    const m = paragraphMessage({ ...request, next: [{ source: "後。", translation: "After." }, { source: "更に。", translation: null }], rejected: "Old words." });
    expect(m).toContain("JAPANESE: 後。\nENGLISH: After.\n\nJAPANESE: 更に。");
    expect(m).toContain("REJECTED VERSION");
  });
  it("leaves out the sections that have nothing in them", () => {
    const m = paragraphMessage({ ...request, before: [], next: [], notes: [], glossary: [] });
    expect(m).not.toMatch(/CONTEXT|NEXT|GLOSSARY|NOTES/);
  });
  it("has the style as guidance for tone, not as the task", () => {
    const system = paragraphSystem("Be literary.", "Japanese", "English");
    expect(system).toContain("Style of the whole translation (it applies to tone and wording only");
    expect(system).toContain("Be literary.");
    expect(system).toContain("one paragraph at a time");
  });
});

describe("answerOf", () => {
  it("takes the reply without a code fence or a label in front", () => {
    expect(answerOf("New text.", "English")).toBe("New text.");
    expect(answerOf("English: New text.", "English")).toBe("New text.");
    expect(answerOf("```\nNew text.\n```", "English")).toBe("New text.");
    expect(answerOf("  ", "English")).toBeNull();
  });
});

describe("missingNames", () => {
  it("lists the glossary names of the paragraph that the translation does not use", () => {
    const glossary = [{ source: "花子", target: "Hanako" }, { source: "太郎", target: "Taro|Tarou" }, { source: "食べる", target: "" }];
    expect(missingNames(glossary, "花子と太郎。", "Hanako and Taro.")).toEqual([]);
    expect(missingNames(glossary, "花子と太郎。", "She and Tarou.")).toEqual(["花子 => Hanako"]);
    expect(missingNames(glossary, "他の人。", "Someone.")).toEqual([]); // not in the paragraph
  });
  it("lets a short form of a name be translated as part of the name", () => {
    const glossary = [{ source: "山田太郎", target: "Taro Yamada", aliases: ["太郎"] }];
    expect(missingNames(glossary, "「太郎、行くぞ」", "\"Taro, let's go.\"")).toEqual([]);
    expect(missingNames(glossary, "「太郎、行くぞ」", "\"Let's go.\"")).toEqual(["山田太郎 => Taro Yamada"]);
    // when the whole name is in the paragraph, the whole English name is wanted
    expect(missingNames(glossary, "山田太郎は笑った。", "Taro laughed.")).toEqual(["山田太郎 => Taro Yamada"]);
  });
});

describe("paragraphs", () => {
  it("finds the paragraphs with their place in the text", () => {
    expect(paragraphsOf("a\n\n  b ")).toEqual([{ start: 0, end: 1, text: "a" }, { start: 5, end: 6, text: "b" }]);
  });
  });
