import { describe, expect, it } from "vitest";
import { analysisUserMessage, findTerm, mergeSuggestions, mergeSummary, parseAnalysisReply, summaryUserMessage } from "./analysis.js";
import type { KnowledgeEntry } from "./entries.js";

const term = (id: string, source: string, target: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  kind: "term",
  source,
  target,
  hint: "",
  category: "character",
  aliases: [],
  attrs: {},
  attrFlags: [],
  text: "",
  about: null,
  related: [],
  scope: null,
  origin: { by: "user" },
  status: "confirmed",
  updatedAt: "x",
  ...over,
});

describe("parseAnalysisReply", () => {
  it("reads typed entries with their other spellings, aliases, facts and the scene", () => {
    const r = parseAnalysisReply(
      [
        "Here is what I found:",
        "CHARACTER: 花子 / 花ちゃん = Hanako | girl, speaks politely",
        "PLACE: 学園 = the Academy | the school where the story is set",
        "- TERM: 忍者 = ninja",
        "PERSON: 太郎 = Taro | boy, the narrator",
        "ALIAS: 太ちゃん = 太郎",
        "FACT: 花子 | Addresses Taro as Taro-kun.",
        "SCENE: CONTINUES | 花子, 太郎 | At the gate Hanako greets Taro.",
        "SCENE: NEW | ignored second line",
        "NOTE: an older style of note",
        "Hope this helps!",
      ].join("\n"),
    );
    expect(r.entities).toEqual([
      { category: "character", names: ["花子", "花ちゃん"], target: "Hanako", summary: "girl, speaks politely" },
      { category: "place", names: ["学園"], target: "the Academy", summary: "the school where the story is set" },
      { category: "term", names: ["忍者"], target: "ninja", summary: "" },
      { category: "character", names: ["太郎"], target: "Taro", summary: "boy, the narrator" },
    ]);
    expect(r.aliases).toEqual([{ alias: "太ちゃん", of: "太郎" }]);
    expect(r.facts).toEqual([
      { about: "花子", text: "Addresses Taro as Taro-kun." },
      { about: null, text: "an older style of note" },
    ]);
    expect(r.scene).toEqual({ continues: true, present: ["花子", "太郎"], text: "At the gate Hanako greets Taro." });
  });

  it("reads scenes written in other ways", () => {
    expect(parseAnalysisReply("SCENE: Rain falls.").scene).toEqual({ continues: false, present: [], text: "Rain falls." });
    expect(parseAnalysisReply("SCENE: NEW | 花子 | A new morning.").scene).toEqual({ continues: false, present: ["花子"], text: "A new morning." });
    expect(parseAnalysisReply("花子 = Hanako # girl").entities).toEqual([{ category: "term", names: ["花子"], target: "Hanako", summary: "girl" }]);
  });

  it("treats NONE and empty replies as nothing found", () => {
    expect(parseAnalysisReply("NONE")).toEqual({ entities: [], aliases: [], facts: [], scene: null });
    expect(parseAnalysisReply("")).toEqual({ entities: [], aliases: [], facts: [], scene: null });
  });

  it("limits how much one passage can add", () => {
    const many = Array.from({ length: 40 }, (_, i) => `CHARACTER: 名${i} = N${i} | x`).join("\n") + "\n" + Array.from({ length: 20 }, (_, i) => `FACT: 名0 | f${i}`).join("\n");
    const r = parseAnalysisReply(many);
    expect(r.entities).toHaveLength(20);
    expect(r.facts).toHaveLength(10);
  });
});

describe("recognizing something already known", () => {
  const known = [term("k", "佐藤花子", "Hanako Sato"), term("t", "田中", "Samejima", { aliases: ["田中くん"] }), term("p", "学園", "Academy", { category: "place" })];
  const find = (names: string[], target: string, category: "character" | "place" | "term" = "character") => findTerm(known, { category, names, target })?.id;

  it("matches a name or other spelling that is already listed", () => {
    expect(find(["田中くん"], "Samejima-kun")).toBe("t");
    expect(find(["学園"], "School", "place")).toBe("p");
  });
  it("matches a person written shorter or longer when the translations share a word", () => {
    expect(find(["花子"], "Hanako")).toBe("k");
    expect(find(["花子"], "Someone Else")).toBeUndefined();
  });
  it("matches the same translation within a category, but not across categories", () => {
    expect(find(["さめじま"], "samejima")).toBe("t");
    expect(find(["アカデミー"], "Academy", "term")).toBeUndefined();
  });
  it("does not merge unrelated short names", () => {
    expect(find(["魔王"], "Demon King")).toBeUndefined();
  });
});

describe("mergeSuggestions", () => {
  let n = 0;
  const deps = { newId: () => `id${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
  const origin = { by: "model" as const, model: "m", documentTitle: "Chapter 1", block: 2 };
  const scope = (block: number) => ({ documentId: "d1", blockHash: `h${block}`, block });
  const empty = { entities: [], aliases: [], facts: [], scene: null };
  const found = {
    entities: [
      { category: "character" as const, names: ["花子", "花ちゃん"], target: "Hanako", summary: "girl" },
      { category: "character" as const, names: ["太郎"], target: "Taro", summary: "" },
    ],
    aliases: [],
    facts: [{ about: "花ちゃん", text: "Addresses Taro as Taro-kun." }, { about: "誰か", text: "about someone unlisted" }],
    scene: { continues: false, present: ["花子", "太郎", "誰か"], text: "At the gate." },
  };

  it("adds typed terms with their other spellings, attaches facts, and starts a scene tied to the block and the people present", () => {
    const r = mergeSuggestions([], found, origin, scope(2), deps);
    const [hanako, taro, fact, scene] = r.entries;
    expect(r.entries).toHaveLength(4);
    expect(hanako).toMatchObject({ kind: "term", source: "花子", aliases: ["花ちゃん"], category: "character", hint: "girl", status: "suggested", origin });
    expect(fact).toMatchObject({ kind: "note", about: hanako!.id, text: "Addresses Taro as Taro-kun." }); // found through the other spelling
    expect(scene).toMatchObject({ kind: "scene", text: "At the gate.", related: [hanako!.id, taro!.id], scope: { documentId: "d1", blockHashes: ["h2"], block: 2 } });
    expect(r.added).toBe(4);
  });

  it("recognizes a known person written another way instead of adding a duplicate, and remembers the new spelling", () => {
    const first = mergeSuggestions([], found, origin, scope(2), deps).entries;
    const again = mergeSuggestions(first, { ...empty, entities: [{ category: "character", names: ["花子さん"], target: "Hanako", summary: "girl" }] }, origin, scope(3), deps);
    expect(again.entries.filter((e) => e.kind === "term")).toHaveLength(2);
    expect(again.entries[0]!.aliases).toEqual(["花ちゃん", "花子さん"]);
    const viaAlias = mergeSuggestions(first, { ...empty, aliases: [{ alias: "ハナ", of: "花子" }] }, origin, scope(3), deps);
    expect(viaAlias.entries[0]!.aliases).toContain("ハナ");
  });

  it("refines a suggested summary, but offers a better one as a fact when the user has confirmed the entry", () => {
    const update = { ...empty, entities: [{ category: "character" as const, names: ["花子"], target: "Hanako", summary: "girl, the class president" }] };
    const mine = [term("u", "花子", "Hanako", { hint: "girl", status: "confirmed" })];
    const keep = mergeSuggestions(mine, update, origin, scope(3), deps);
    expect(keep.entries[0]!.hint).toBe("girl");
    expect(keep.entries[1]).toMatchObject({ kind: "note", about: "u", text: "girl, the class president", status: "suggested" });
    const suggested = [term("s", "花子", "Hanako", { hint: "girl", status: "suggested" })];
    expect(mergeSuggestions(suggested, update, origin, scope(3), deps).entries[0]!.hint).toBe("girl, the class president");
    expect(mergeSuggestions([term("e", "花子", "Hanako")], { ...empty, entities: [{ category: "character", names: ["花子"], target: "Hanako", summary: "girl" }] }, origin, scope(3), deps).entries[0]!.hint).toBe("girl"); // fills an empty summary
  });

  it("extends the scene before it when the passage continues it, and starts a new one otherwise", () => {
    const first = mergeSuggestions([], { ...empty, scene: { continues: false, present: [], text: "Morning at the gate." } }, origin, scope(1), deps).entries;
    const second = mergeSuggestions(first, { ...empty, scene: { continues: true, present: [], text: "Morning at the gate, then class begins." } }, origin, scope(2), deps);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({ text: "Morning at the gate, then class begins.", scope: { blockHashes: ["h1", "h2"], block: 1, blockEnd: 2 } });
    const third = mergeSuggestions(second.entries, { ...empty, scene: { continues: false, present: [], text: "Evening." } }, origin, scope(3), deps);
    expect(third.entries).toHaveLength(2);
    expect(third.entries[1]!.scope).toMatchObject({ blockHashes: ["h3"], block: 3 });
    // The next block continues the new scene, not the old one.
    const fourth = mergeSuggestions(third.entries, { ...empty, scene: { continues: true, present: [], text: "Evening, later." } }, origin, scope(4), deps);
    expect(fourth.entries[1]!.scope).toMatchObject({ blockHashes: ["h3", "h4"], blockEnd: 4 });
  });

  it("does not change a scene the user confirmed, and starts a new one instead", () => {
    const confirmed = mergeSuggestions([], { ...empty, scene: { continues: false, present: [], text: "Mine." } }, origin, scope(1), deps).entries.map((e) => ({ ...e, status: "confirmed" as const }));
    const r = mergeSuggestions(confirmed, { ...empty, scene: { continues: true, present: [], text: "Model's." } }, origin, scope(2), deps);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]!.text).toBe("Mine.");
    const reread = mergeSuggestions(confirmed, { ...empty, scene: { continues: false, present: [], text: "Other." } }, origin, scope(1), deps);
    expect(reread.entries).toEqual(confirmed);
  });
});

describe("summaries and requests", () => {
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

  it("shows known entries in the same format the model writes, with the scene before the passage", () => {
    expect(summaryUserMessage("Chapter 1", ["A.", "B."])).toBe("CHAPTER: Chapter 1\n\nSCENES:\n1. A.\n2. B.");
    expect(
      analysisUserMessage(
        { terms: [{ category: "character", source: "花子", aliases: ["花ちゃん"], target: "Hanako", hint: "girl", facts: ["Polite."] }], previousScene: { text: "At the gate.", from: 2, to: 4 } },
        "本文",
      ),
    ).toBe("KNOWN SO FAR:\nCHARACTER: 花子 / 花ちゃん = Hanako | girl\n  fact: Polite.\nThe scene before this passage (blocks 2 to 4): At the gate.\n\nPASSAGE:\n本文");
    expect(analysisUserMessage({ terms: [] }, "本文")).toBe("PASSAGE:\n本文");
  });
});
