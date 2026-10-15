import {
  describe,
  expect,
  it,
} from "vitest";
import {
  glossaryLines,
  targetVariants,
  wordNoteLines,
} from "./glossary.js";
import {
  BUILTIN_PROMPTS,
  renderPrompt,
  validatePrompt,
} from "./prompts.js";

describe("glossary lines", () => {
  it("lists accepted alternatives", () => {
    expect(targetVariants("Demon King | Demon Lord|")).toEqual(["Demon King", "Demon Lord"]);
  });
  it("gives the English name to use for each word that has one, with its other spellings, and keeps notes in their own lines", () => {
    const glossary = [
      { source: "魔王", target: "Demon King|Demon Lord", note: "villain", aliases: ["魔王様"] },
      { source: "食べる", target: "", note: "use the past tense" },
    ];
    expect(glossaryLines(glossary)).toEqual(["- 魔王 / 魔王様 => Demon King (or Demon Lord)"]);
    expect(wordNoteLines(glossary)).toEqual(["- 魔王: villain", "- 食べる: use the past tense"]);
  });
});

describe("prompt styles", () => {
  it("every built-in style has what a style needs and fills in both languages", () => {
    expect(new Set(BUILTIN_PROMPTS.map((p) => p.id)).size).toBe(BUILTIN_PROMPTS.length);
    for (const p of BUILTIN_PROMPTS) {
      expect(validatePrompt(p)).toBeNull();
      const text = renderPrompt(p, "Japanese", "English");
      expect(text).not.toMatch(/\{(source|target)Language\}/);
      expect(text).toContain("English");
    }
  });

  it("treats $ in a language name literally", () => {
    expect(renderPrompt({ template: "T {sourceLanguage}" }, "$& weird $1", "x")).toBe("T $& weird $1");
  });

  it("validates custom styles with plain messages", () => {
    expect(validatePrompt({ name: " ", template: "x" })).toMatch(/name/);
    expect(validatePrompt({ name: "n", template: "  " })).toMatch(/no instructions/);
    expect(validatePrompt({ name: "n", template: "x".repeat(4001) })).toMatch(/too long/);
    expect(validatePrompt({ name: "ok", template: "Translate." })).toBeNull();
  });
});
