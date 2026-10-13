import { describe, expect, it } from "vitest";
import { analysisUserMessage, mergeSuggestions, mergeSummary, parseAnalysisReply, summaryUserMessage } from "./analysis.js";
import type { KnowledgeEntry } from "./entries.js";

describe("parseAnalysisReply", () => {
  it("reads people, facts and the scene, and ignores everything else", () => {
    const r = parseAnalysisReply(
      [
        "Here is what I found:",
        "PERSON: 花子 = Hanako # girl, speaks politely",
        "- 太郎 = Taro # boy, the narrator",
        "FACT: 花子 | Addresses Taro as Yamada.",
        "SCENE: 花子, 太郎 | At the school gate Hanako greets Taro.",
        "SCENE: a second one is ignored | x",
        "NOTE: an older style of note",
        "Hope this helps!",
      ].join("\n"),
    );
    expect(r.characters).toEqual([
      { source: "花子", target: "Hanako", note: "girl, speaks politely" },
      { source: "太郎", target: "Taro", note: "boy, the narrator" },
    ]);
    expect(r.facts).toEqual([
      { about: "花子", text: "Addresses Taro as Yamada." },
      { about: null, text: "an older style of note" },
    ]);
    expect(r.scene).toEqual({ present: ["花子", "太郎"], text: "At the school gate Hanako greets Taro." });
  });

  it("treats NONE and empty replies as nothing found", () => {
    expect(parseAnalysisReply("NONE")).toEqual({ characters: [], facts: [], scene: null });
    expect(parseAnalysisReply("")).toEqual({ characters: [], facts: [], scene: null });
  });

  it("accepts a scene without names", () => {
    expect(parseAnalysisReply("SCENE: Rain falls on the school.").scene).toEqual({ present: [], text: "Rain falls on the school." });
  });

  it("limits how much one passage can add", () => {
    const many = Array.from({ length: 40 }, (_, i) => `名${i} = N${i} # x`).join("\n") + "\n" + Array.from({ length: 20 }, (_, i) => `FACT: 名0 | f${i}`).join("\n");
    const r = parseAnalysisReply(many);
    expect(r.characters).toHaveLength(20);
    expect(r.facts).toHaveLength(10);
  });
});

describe("mergeSuggestions", () => {
  let n = 0;
  const deps = { newId: () => `id${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
  const origin = { by: "model" as const, model: "m", documentTitle: "Chapter 1", block: 2 };
  const scope = { documentId: "d1", blockHash: "h2", block: 2 };
  const found = {
    characters: [{ source: "花子", target: "Hanako", note: "girl" }, { source: "太郎", target: "Taro" }],
    facts: [{ about: "花子", text: "Addresses Taro as Yamada." }, { about: "誰か", text: "about someone unlisted" }],
    scene: { present: ["花子", "太郎", "誰か"], text: "At the gate." },
  };
  const mine = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({ id: "u1", kind: "term", source: "花子", target: "Hanakko", hint: "", text: "", about: null, related: [], scope: null, origin: { by: "user" }, status: "confirmed", updatedAt: "x", ...over });

  it("adds terms, attaches facts to the person, and ties the scene to the block and the people present", () => {
    const r = mergeSuggestions([], found, origin, scope, deps);
    const [hanako, taro, fact, scene] = r.entries;
    expect(r.entries).toHaveLength(4);
    expect(hanako).toMatchObject({ kind: "term", source: "花子", hint: "girl", status: "suggested", origin });
    expect(fact).toMatchObject({ kind: "note", about: hanako!.id, text: "Addresses Taro as Yamada." });
    expect(scene).toMatchObject({ kind: "scene", text: "At the gate.", related: [hanako!.id, taro!.id], scope });
    expect(r.added).toBe(4);
  });

  it("never overwrites what the user wrote, but fills an empty hint", () => {
    const withHint = [mine({ hint: "my hint" })];
    const r = mergeSuggestions(withHint, { characters: found.characters.slice(0, 1), facts: [], scene: null }, origin, scope, deps);
    expect(r).toEqual({ entries: withHint, added: 0 });
    const filled = mergeSuggestions([mine()], { characters: found.characters.slice(0, 1), facts: [], scene: null }, origin, scope, deps);
    expect(filled.entries[0]).toMatchObject({ target: "Hanakko", hint: "girl", status: "confirmed", origin: { by: "user" } });
  });

  it("does not repeat a fact, and replaces its own earlier scene but keeps a confirmed one", () => {
    const first = mergeSuggestions([], found, origin, scope, deps).entries;
    const again = mergeSuggestions(first, { ...found, scene: { present: ["花子"], text: "Updated." } }, origin, scope, deps);
    expect(again.entries).toHaveLength(4);
    expect(again.entries[3]).toMatchObject({ text: "Updated.", related: [first[0]!.id] });
    const confirmed = first.map((e) => (e.kind === "scene" ? { ...e, status: "confirmed" as const } : e));
    expect(mergeSuggestions(confirmed, found, origin, scope, deps).entries[3]!.text).toBe("At the gate.");
  });
});

describe("summaries", () => {
  let n = 0;
  const deps = { newId: () => `s${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
  const origin = { by: "model" as const, model: "m" };

  it("adds one summary per document, replaces its own, and keeps one the user confirmed", () => {
    const first = mergeSummary([], "Summary one.", { documentId: "d1" }, origin, deps);
    expect(first.entries).toMatchObject([{ kind: "summary", text: "Summary one.", scope: { documentId: "d1" }, status: "suggested" }]);
    const second = mergeSummary(first.entries, "Summary two.", { documentId: "d1" }, origin, deps);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]!.text).toBe("Summary two.");
    const kept = mergeSummary(second.entries.map((e) => ({ ...e, status: "confirmed" as const })), "Summary three.", { documentId: "d1" }, origin, deps);
    expect(kept.updated).toBe(false);
    expect(kept.entries[0]!.text).toBe("Summary two.");
  });

  it("builds the requests as plain text", () => {
    expect(summaryUserMessage("Chapter 1", ["A.", "B."])).toBe("CHAPTER: Chapter 1\n\nSCENES:\n1. A.\n2. B.");
    expect(analysisUserMessage({ terms: [{ source: "花子", target: "Hanako", hint: "girl", facts: ["Polite."] }], previousScene: "At the gate." }, "本文")).toBe(
      "KNOWN SO FAR:\n花子 = Hanako # girl\n  fact: Polite.\nThe passage before this one: At the gate.\n\nPASSAGE:\n本文",
    );
    expect(analysisUserMessage({ terms: [] }, "本文")).toBe("PASSAGE:\n本文");
  });
});
