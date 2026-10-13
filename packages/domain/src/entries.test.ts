import { describe, expect, it } from "vitest";
import { blockMaterial, entriesFromLegacy, entriesFromText, entriesToText, entryProblems, normalizeEntry, splitEntries, type KnowledgeEntry } from "./entries.js";

let n = 0;
const deps = { newId: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };

describe("entries", () => {
  const { entries, unreadable } = entriesFromText("魔王 = Demon King # villain\n> He speaks formally.\n> Keep honorifics.\nnot a line", { by: "user" }, "confirmed", deps);

  it("reads pasted lines into terms and notes and counts the unreadable ones", () => {
    expect(unreadable).toBe(1);
    expect(entries).toMatchObject([
      { kind: "term", source: "魔王", target: "Demon King", hint: "villain", status: "confirmed", origin: { by: "user" } },
      { kind: "note", text: "He speaks formally." },
      { kind: "note", text: "Keep honorifics." },
    ]);
  });

  it("gives a run what it needs and writes the same lines back out", () => {
    const s = splitEntries(entries);
    expect(s.glossary).toEqual([{ source: "魔王", target: "Demon King", note: "villain" }]);
    expect(s.notes).toBe("> He speaks formally.\n> Keep honorifics.");
    expect(entriesToText(entries)).toBe("魔王 = Demon King # villain\n\n> He speaks formally.\n> Keep honorifics.");
  });

  it("explains what is missing", () => {
    const base = { kind: "term" as const, source: "", target: "", hint: "", category: "term" as const, aliases: [], text: "", about: null };
    expect(entryProblems(base)).toHaveLength(2);
    expect(entryProblems({ ...base, source: "a", target: "b" })).toEqual([]);
    expect(entryProblems({ ...base, kind: "note" })).toEqual(["Enter the text."]);
  });

  it("brings an older project's glossary and notes over", () => {
    const e = entriesFromLegacy([{ source: "魔王", target: "Demon King" }], "A fact.\n- Another.", undefined, deps);
    expect(e.map((x) => x.kind)).toEqual(["term", "note", "note"]);
    expect(entriesFromLegacy([], undefined, "勇者 = Hero", deps)).toHaveLength(1);
  });
});

describe("the background for one block", () => {
  const e = (id: string, over: Partial<KnowledgeEntry>): KnowledgeEntry => ({ id, kind: "term", source: "", target: "", hint: "", category: "term" as const, aliases: [], text: "", about: null, related: [], scope: null, origin: { by: "user" }, status: "confirmed", updatedAt: "t", ...over });
  const entries = [
    e("hanako", { source: "花子", target: "Hanako", hint: "girl" }),
    e("taro", { source: "太郎", target: "Taro" }),
    e("ghost", { source: "幽霊", target: "Ghost" }),
    e("f1", { kind: "note", about: "hanako", text: "Addresses Taro as Yamada." }),
    e("f2", { kind: "note", about: "ghost", text: "Never speaks." }),
    e("n1", { kind: "note", text: "Keep honorifics." }),
    e("sc", { kind: "scene", text: "At the gate.", related: ["taro"], scope: { documentId: "d1", blockHash: "h1", block: 1 } }),
    e("su", { kind: "summary", text: "A short chapter.", scope: { documentId: "d1" } }),
  ];

  it("combines the scene, the summary, the chosen terms, the people present and the facts about them", () => {
    const m = blockMaterial(entries, ["hanako"], "h1", "d1")!;
    expect(m.scene).toBe("At the gate.");
    expect(m.summary).toBe("A short chapter.");
    expect(m.glossary.map((g) => g.source)).toEqual(["花子", "太郎"]); // 太郎 is present in the scene, though not chosen
    expect(m.notes).toEqual(["Hanako: Addresses Taro as Yamada."]); // the facts of terms that were not used stay out
  });

  it("includes a plain note only when it was chosen, and another block's scene never leaks in", () => {
    expect(blockMaterial(entries, ["n1"], "h2", "d1")).toMatchObject({ notes: ["Keep honorifics."], glossary: [] });
    expect(blockMaterial(entries, ["n1"], "h2", "d1")!.scene).toBeUndefined();
    expect(blockMaterial(entries, ["n1"], "h2", "other")!.summary).toBeUndefined();
  });

  it("says nobody has looked when there is nothing chosen and no scene", () => {
    expect(blockMaterial(entries, null, "h2", "d1")).toBeNull();
    expect(blockMaterial(entries, null, "h1", "d1")!.glossary.map((g) => g.source)).toEqual(["太郎"]);
    expect(blockMaterial([], [], "h", "d")).toBeNull();
  });

  it("writes terms and facts back as lines, and fills in fields an older file lacks", () => {
    expect(entriesToText(entries)).toContain("> Hanako: Addresses Taro as Yamada.");
    expect(splitEntries(entries).glossary).toHaveLength(3);
    expect(normalizeEntry({ id: "x", kind: "term", origin: { by: "user" }, status: "confirmed", updatedAt: "t", source: "a", target: "b" })).toMatchObject({ about: null, related: [], scope: null, hint: "" });
  });
});
