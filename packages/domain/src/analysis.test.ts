import { describe, expect, it } from "vitest";
import { analysisUserMessage, mergeSuggestions, parseAnalysisReply } from "./analysis.js";

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

describe("mergeSuggestions", () => {
  let n = 0;
  const deps = { newId: () => `id${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
  const origin = { by: "model" as const, model: "m", documentTitle: "Chapter 1", block: 2 };
  const found = { characters: [{ source: "花子", target: "Hanako", note: "girl" }], notes: [{ keys: ["花子"], text: "Hanako is the one being addressed." }] };
  const mine = (over = {}) => ({ id: "u1", kind: "term" as const, source: "花子", target: "Hanakko", hint: "", keys: [], text: "", origin: { by: "user" as const }, status: "confirmed" as const, updatedAt: "x", ...over });

  it("adds new terms and notes as suggestions that remember where they came from", () => {
    const r = mergeSuggestions([], found, origin, deps);
    expect(r.added).toBe(2);
    expect(r.entries).toMatchObject([
      { kind: "term", source: "花子", target: "Hanako", hint: "girl", origin, status: "suggested" },
      { kind: "note", keys: ["花子"], text: "Hanako is the one being addressed.", origin, status: "suggested" },
    ]);
  });

  it("never overwrites what the user wrote, but fills an empty hint", () => {
    const withHint = [mine({ hint: "my hint" })];
    expect(mergeSuggestions(withHint, { characters: found.characters, notes: [] }, origin, deps)).toEqual({ entries: withHint, added: 0 });
    const r = mergeSuggestions([mine()], { characters: found.characters, notes: [] }, origin, deps);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ target: "Hanakko", hint: "girl", status: "confirmed", origin: { by: "user" } });
  });

  it("does not repeat a note that is already there", () => {
    const note = { ...mine(), id: "n1", kind: "note" as const, source: "", target: "", keys: [], text: "hanako is the one being addressed." };
    expect(mergeSuggestions([note], { characters: [], notes: found.notes }, origin, deps).added).toBe(0);
  });
});

describe("analysisUserMessage", () => {
  it("lists what is known before the passage", () => {
    const m = analysisUserMessage({ glossary: [{ source: "花子", target: "Hanako", note: "girl" }], notes: ["A note."] }, "本文");
    expect(m).toBe("KNOWN SO FAR:\n花子 = Hanako # girl\nA note.\n\nPASSAGE:\n本文");
    expect(analysisUserMessage({ glossary: [], notes: [] }, "本文")).toBe("PASSAGE:\n本文");
  });
});
