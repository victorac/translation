import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";
import { knowledgeCap, knowledgeForBlock, knowledgeFromLegacy, knowledgeReserve, parseKnowledge, relevantNotes, splitKnowledge } from "./knowledge.js";

const KB = ["# People", "花子 = Hanako # girl, speaks politely", "太郎 -> Taro", "", "> 花子, 太郎 | The second speaker is talking to Hanako.", "> Keep honorifics.", "this line is wrong", "> | no keys", "> "].join("\n");

describe("parseKnowledge", () => {
  const k = parseKnowledge(KB);
  it("reads terms with hints, keyed and general notes", () => {
    expect(k.glossary).toEqual([
      { source: "花子", target: "Hanako", note: "girl, speaks politely" },
      { source: "太郎", target: "Taro" },
    ]);
    expect(k.notes).toEqual([
      { keys: ["花子", "太郎"], text: "The second speaker is talking to Hanako." },
      { keys: [], text: "Keep honorifics." },
    ]);
  });
  it("says how each line was read, with positions", () => {
    expect(k.lines.map((l) => l.kind)).toEqual(["comment", "term", "term", "blank", "note", "note", "problem", "problem", "problem"]);
    const bad = k.lines[6]!;
    expect(KB.slice(bad.from, bad.to)).toBe("this line is wrong");
    expect(bad.kind === "problem" && bad.message).toMatch(/Not understood/);
  });
});

describe("relevance", () => {
  const { glossary, notes } = splitKnowledge(KB);
  it("only sends what applies to the block", () => {
    const none = knowledgeForBlock(glossary, notes, "天気がいい。", 1000);
    expect(none).toEqual({ glossary: [], notes: ["Keep honorifics."], omitted: 0 });
    const some = knowledgeForBlock(glossary, notes, "花子が来た。", 1000);
    expect(some.glossary.map((g) => g.source)).toEqual(["花子"]);
    expect(some.notes).toEqual(["The second speaker is talking to Hanako.", "Keep honorifics."]);
  });
  it("leaves out what does not fit the allowance, general notes first", () => {
    const cap = estimateTokens("花子 = Hanako # girl, speaks politely") + estimateTokens("The second speaker is talking to Hanako.");
    const r = knowledgeForBlock(glossary, notes, "花子が来た。", cap);
    expect(r.glossary).toHaveLength(1);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.notes).toEqual(["The second speaker is talking to Hanako."]);
  });
  it("sets aside at most the cap, however large the knowledge", () => {
    const big = Array.from({ length: 400 }, (_, i) => `名${i} = Name${i} # a long hint about this person, ${"x".repeat(60)}`).join("\n");
    const s = splitKnowledge(big);
    expect(knowledgeReserve(s.glossary, s.notes, 8192)).toBe(knowledgeCap(8192));
    expect(knowledgeCap(8192)).toBe(1000);
    expect(knowledgeCap(2048)).toBe(409);
    expect(knowledgeReserve([], "", 4096)).toBe(0);
  });
  it("matches keys case-insensitively", () => {
    expect(relevantNotes([{ keys: ["Hanako"], text: "x" }], "HANAKO said")).toHaveLength(1);
  });
});

describe("older projects", () => {
  it("turns a glossary and free-text notes into knowledge lines", () => {
    const text = knowledgeFromLegacy([{ source: "魔王", target: "Demon King", note: "villain" }], "Hanako is a girl.\n- Narrator is a boy.");
    expect(text).toBe("魔王 = Demon King # villain\n\n> Hanako is a girl.\n> Narrator is a boy.");
    expect(parseKnowledge(text).lines.some((l) => l.kind === "problem")).toBe(false);
    expect(knowledgeFromLegacy([], undefined)).toBe("");
  });
});
