import { describe, expect, it } from "vitest";
import { backupMaterial, fitMaterial, knowledgeCap, knowledgeReserve, parseKnowledge, splitKnowledge } from "./knowledge.js";
import { estimateTokens } from "./tokens.js";

const KB = ["# People", "花子 = Hanako # girl, speaks politely", "太郎 -> Taro", "", "> The second speaker is talking to Hanako.", "> names | an older note that named words", "this line is wrong", "> "].join("\n");

describe("parseKnowledge", () => {
  const k = parseKnowledge(KB);
  it("reads terms with hints and notes, dropping words older notes were tied to", () => {
    expect(k.glossary).toEqual([
      { source: "花子", target: "Hanako", note: "girl, speaks politely" },
      { source: "太郎", target: "Taro" },
    ]);
    expect(k.notes).toEqual([{ text: "The second speaker is talking to Hanako." }, { text: "an older note that named words" }]);
  });
  it("says how each line was read, with positions", () => {
    expect(k.lines.map((l) => l.kind)).toEqual(["comment", "term", "term", "blank", "note", "note", "problem", "problem"]);
    const bad = k.lines[6]!;
    expect(KB.slice(bad.from, bad.to)).toBe("this line is wrong");
  });
});

describe("what fits", () => {
  const { glossary, notes } = splitKnowledge(KB);
  it("keeps terms before notes and leaves out what does not fit the allowance", () => {
    const m = { glossary, notes: ["The second speaker is talking to Hanako."] };
    expect(fitMaterial(m, 1000)).toEqual({ ...m, omitted: 0 });
    const room = estimateTokens("花子 = Hanako # girl, speaks politely") + estimateTokens("太郎 = Taro");
    const r = fitMaterial(m, room);
    expect(r.glossary).toHaveLength(2);
    expect(r.notes).toEqual([]);
    expect(r.omitted).toBe(1);
  });
  it("sets aside at most the cap, however much is known", () => {
    const big = Array.from({ length: 400 }, (_, i) => `名${i} = Name${i} # a long hint about this person, ${"x".repeat(60)}`).join("\n");
    const s = splitKnowledge(big);
    expect(knowledgeReserve(s.glossary, s.notes, 8192)).toBe(knowledgeCap(8192));
    expect(knowledgeCap(8192)).toBe(1000);
    expect(knowledgeCap(2048)).toBe(409);
    expect(knowledgeReserve([], "", 4096)).toBe(0);
  });
  it("has a backup for blocks nobody looked through: terms that appear, and all notes", () => {
    const b = backupMaterial(glossary, notes, "花子が来た。");
    expect(b.glossary.map((g) => g.source)).toEqual(["花子"]);
    expect(b.notes).toHaveLength(2);
  });
});
