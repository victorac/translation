import { describe, expect, it } from "vitest";
import { SUGGESTED_HEADER, analysisUserMessage, mergeAnalysis, parseAnalysisReply } from "./analysis.js";
import { parseKnowledge } from "./knowledge.js";

describe("parseAnalysisReply", () => {
  it("reads people and notes and ignores everything else", () => {
    const r = parseAnalysisReply(
      ["Here is what I found:", "- 花子 = Hanako # girl, speaks politely", "2. 太郎 → Taro # boy, the narrator", "NOTE: 花子, 太郎 | The second speaker is talking to Hanako.", "note: the narrator is a boy", "Hope this helps!"].join("\n"),
    );
    expect(r.characters).toEqual([
      { source: "花子", target: "Hanako", note: "girl, speaks politely" },
      { source: "太郎", target: "Taro", note: "boy, the narrator" },
    ]);
    expect(r.notes).toEqual([
      { keys: ["花子", "太郎"], text: "The second speaker is talking to Hanako." },
      { keys: [], text: "the narrator is a boy" },
    ]);
  });

  it("treats NONE and empty replies as nothing found", () => {
    expect(parseAnalysisReply("NONE")).toEqual({ characters: [], notes: [] });
    expect(parseAnalysisReply("")).toEqual({ characters: [], notes: [] });
  });

  it("limits how much one passage can add", () => {
    const many = Array.from({ length: 40 }, (_, i) => `名${i} = N${i} # x`).join("\n") + "\n" + Array.from({ length: 20 }, (_, i) => `NOTE: n${i}`).join("\n");
    const r = parseAnalysisReply(many);
    expect(r.characters).toHaveLength(20);
    expect(r.notes).toHaveLength(8);
  });
});

describe("mergeAnalysis", () => {
  const found = { characters: [{ source: "花子", target: "Hanako", note: "girl" }], notes: [{ keys: ["花子"], text: "Hanako is the one being addressed." }] };

  it("adds new lines at the end under one heading, and they read back correctly", () => {
    const first = mergeAnalysis("魔王 = Demon King\n", found);
    expect(first).toBe(`魔王 = Demon King\n\n${SUGGESTED_HEADER}\n花子 = Hanako # girl\n> 花子 | Hanako is the one being addressed.\n`);
    const again = mergeAnalysis(first, { characters: [], notes: [{ keys: [], text: "Another fact." }] });
    expect(again.split(SUGGESTED_HEADER)).toHaveLength(2);
    const k = parseKnowledge(again);
    expect(k.glossary.map((g) => g.source)).toEqual(["魔王", "花子"]);
    expect(k.notes).toHaveLength(2);
    expect(k.lines.some((l) => l.kind === "problem")).toBe(false);
  });

  it("never overwrites what the user wrote, but fills an empty hint in place", () => {
    const mine = "花子 = Hanakko # my hint\n";
    expect(mergeAnalysis(mine, { characters: found.characters, notes: [] })).toBe(mine);
    expect(mergeAnalysis("花子 = Hanakko\n魔王 = Demon King", { characters: found.characters, notes: [] })).toBe("花子 = Hanakko # girl\n魔王 = Demon King");
  });

  it("does not repeat a note that is already there", () => {
    const text = "> hanako is the one being addressed.\n";
    expect(mergeAnalysis(text, found)).toContain("花子 = Hanako");
    expect(mergeAnalysis(text, { characters: [], notes: found.notes })).toBe(text);
  });
});

describe("analysisUserMessage", () => {
  it("lists what is known before the passage", () => {
    const m = analysisUserMessage({ glossary: [{ source: "花子", target: "Hanako", note: "girl" }], notes: ["A note."] }, "本文");
    expect(m).toBe("KNOWN SO FAR:\n花子 = Hanako # girl\nA note.\n\nPASSAGE:\n本文");
    expect(analysisUserMessage({ glossary: [], notes: [] }, "本文")).toBe("PASSAGE:\n本文");
  });
});
