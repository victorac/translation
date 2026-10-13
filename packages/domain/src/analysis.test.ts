import { describe, expect, it } from "vitest";
import { SUGGESTED_HEADER, analysisUserMessage, mergeAnalysis, parseAnalysisReply } from "./analysis.js";

describe("parseAnalysisReply", () => {
  it("reads people and notes and ignores everything else", () => {
    const r = parseAnalysisReply(
      ["Here is what I found:", "- 花子 = Hanako # girl, speaks politely", "2. 太郎 → Taro # boy, the narrator", "NOTE: The second speaker is talking to Hanako.", "note: the narrator is a boy", "Hope this helps!"].join("\n"),
    );
    expect(r.characters).toEqual([
      { source: "花子", target: "Hanako", note: "girl, speaks politely" },
      { source: "太郎", target: "Taro", note: "boy, the narrator" },
    ]);
    expect(r.notes).toEqual(["The second speaker is talking to Hanako.", "the narrator is a boy"]);
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
  const found = { characters: [{ source: "花子", target: "Hanako", note: "girl" }], notes: ["Hanako is the one being addressed."] };

  it("adds new people and puts new notes under one header", () => {
    const r = mergeAnalysis({ glossary: [], notes: "My own note." }, found);
    expect(r.glossary).toEqual(found.characters);
    expect(r.notes).toBe(`My own note.\n\n${SUGGESTED_HEADER}\n- Hanako is the one being addressed.`);
    const again = mergeAnalysis(r, { characters: [], notes: ["Another fact."] });
    expect(again.notes.split(SUGGESTED_HEADER)).toHaveLength(2);
    expect(again.notes.endsWith("- Another fact.")).toBe(true);
  });

  it("never overwrites what the user wrote", () => {
    const mine = { glossary: [{ source: "花子", target: "Hanakko", note: "my hint" }], notes: "" };
    expect(mergeAnalysis(mine, found).glossary).toEqual(mine.glossary);
    const noHint = { glossary: [{ source: "花子", target: "Hanakko" }], notes: "" };
    expect(mergeAnalysis(noHint, found).glossary).toEqual([{ source: "花子", target: "Hanakko", note: "girl" }]);
  });

  it("does not repeat a note that is already there", () => {
    const r = mergeAnalysis({ glossary: [], notes: "hanako is the one being addressed." }, found);
    expect(r.notes).toBe("hanako is the one being addressed.");
  });
});

describe("analysisUserMessage", () => {
  it("lists what is known before the passage", () => {
    const m = analysisUserMessage({ glossary: [{ source: "花子", target: "Hanako", note: "girl" }], notes: "A note." }, "本文");
    expect(m).toBe("KNOWN SO FAR:\n花子 = Hanako # girl\nA note.\n\nPASSAGE:\n本文");
    expect(analysisUserMessage({ glossary: [], notes: "" }, "本文")).toBe("PASSAGE:\n本文");
  });
});
