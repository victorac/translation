import { describe, expect, it } from "vitest";
import { entriesToDocument, parseDocument, reconcileDocument } from "./kbtext.js";
import type { KnowledgeEntry } from "./entries.js";

let n = 0;
const deps = { newId: () => `n${++n}`, now: () => "2026-02-01T00:00:00.000Z" };
const docs = [{ id: "d1", title: "Chapter 1" }, { id: "d2", title: "Chapter 2" }];
const e = (id: string, over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
  id,
  kind: "term",
  source: "",
  target: "",
  hint: "",
  category: over.kind && over.kind !== "term" ? "term" : "character",
  aliases: [],
  text: "",
  about: null,
  related: [],
  scope: null,
  origin: { by: "user" },
  status: "confirmed",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const model = { by: "model" as const, model: "qwen", documentTitle: "Chapter 1", block: 2 };

const entries: KnowledgeEntry[] = [
  e("h", { source: "花子", aliases: ["花ちゃん"], target: "Hanako", hint: "girl, the narrator's classmate", status: "suggested", origin: model }),
  e("t", { source: "太郎", target: "Taro", hint: "boy, the narrator" }),
  e("f1", { kind: "note", about: "h", text: "Addresses Taro as Taro-kun.", status: "suggested", origin: model }),
  e("f2", { kind: "note", about: "h", text: "Is the class president." }),
  e("p", { source: "学園", target: "the Academy", category: "place", hint: "the school" }),
  e("k", { source: "忍者", target: "ninja", category: "term" }),
  e("n1", { kind: "note", text: "Keep honorifics." }),
  e("su", { kind: "summary", text: "A short chapter.", scope: { documentId: "d1" } }),
  e("sc", { kind: "scene", text: "At the gate.", related: ["h", "t"], scope: { documentId: "d1", blockHashes: ["a", "b"], block: 1, blockEnd: 2 }, status: "suggested", origin: model }),
  e("x", { source: "幽霊", target: "ghost", status: "rejected" }),
];

describe("the knowledge base as a document", () => {
  const text = entriesToDocument(entries, docs);

  it("writes sections, entries with their facts under them, and marks suggestions with a question mark", () => {
    expect(text).toBe(`# Characters

## 花子 / 花ちゃん = Hanako ?  <!-- qwen · Chapter 1 · block 2 -->
girl, the narrator's classmate
- Addresses Taro as Taro-kun. ?
- Is the class president.

## 太郎 = Taro
boy, the narrator

# Places

## 学園 = the Academy
the school

# Terms

## 忍者 = ninja

# Notes

- Keep honorifics.

# Document: Chapter 1

## Summary
A short chapter.

## Blocks 1-2 | 花子, 太郎 ?  <!-- qwen · Chapter 1 · block 2 -->
At the gate.
`);
  });

  it("leaves rejected entries out", () => {
    expect(text).not.toContain("幽霊");
  });

  it("reads back exactly what was written, and changes nothing", () => {
    const r = reconcileDocument(entries, parseDocument(text), docs, deps);
    expect(r.problems).toEqual([]);
    const byId = (list: KnowledgeEntry[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    const a = byId(r.entries);
    const b = byId(entries);
    a.forEach((x, i) => expect(x).toEqual(b[i]));
    expect(a).toHaveLength(b.length);
  });
});

describe("editing the document", () => {
  const base = entriesToDocument(entries, docs);
  const apply = (edit: (t: string) => string, from = entries) => reconcileDocument(from, parseDocument(edit(base)), docs, deps);
  const find = (r: { entries: KnowledgeEntry[] }, id: string) => r.entries.find((x) => x.id === id);

  it("accepts a suggestion when the question mark is removed, and keeps what was edited", () => {
    const r = apply((t) => t.replace("= Hanako ?  <!--", "= Hanako  <!--").replace("girl, the narrator's classmate", "girl, class president, speaks politely"));
    expect(find(r, "h")).toMatchObject({ status: "confirmed", hint: "girl, class president, speaks politely", origin: { by: "user", model: "qwen" } });
    expect(find(r, "f1")).toMatchObject({ status: "suggested" }); // the fact was not accepted
  });

  it("changes a spelling and a translation without losing the entry's facts or its place in scenes", () => {
    const r = apply((t) => t.replace("花子 / 花ちゃん = Hanako", "花子 / 花ちゃん / ハナ = Hanako-chan"));
    expect(find(r, "h")).toMatchObject({ aliases: ["花ちゃん", "ハナ"], target: "Hanako-chan" });
    expect(r.entries.filter((x) => x.kind === "note" && x.about === "h")).toHaveLength(2);
    expect(find(r, "sc")!.related).toEqual(["h", "t"]);
  });

  it("remembers a deleted suggestion as rejected, with its facts, and removes a deleted confirmed entry", () => {
    const withoutHanako = apply((t) => t.slice(0, t.indexOf("## 花子")) + t.slice(t.indexOf("## 太郎")));
    // The suggestion and its suggested fact are remembered as rejected, together with the one that was already rejected.
    expect(withoutHanako.entries.filter((x) => x.status === "rejected").map((x) => x.id).sort()).toEqual(["f1", "h", "x"]);
    expect(find(withoutHanako, "f2")).toBeUndefined(); // a confirmed fact is simply gone
    expect(find(withoutHanako, "sc")!.related).toEqual(["t"]);
    const withoutTaro = apply((t) => t.replace("## 太郎 = Taro\nboy, the narrator\n\n", ""));
    expect(find(withoutTaro, "t")).toBeUndefined(); // a confirmed entry is gone, not rejected
    expect(find(withoutTaro, "sc")!.related).toEqual(["h"]);
  });

  it("adds a new entry the user typed as theirs, accepted unless it has a question mark", () => {
    const r = apply((t) => t.replace("# Places", "## 花梨 = Karin\ngirl\n- Dislikes tea. ?\n\n# Places"));
    const karin = r.entries.find((x) => x.source === "花梨")!;
    expect(karin).toMatchObject({ kind: "term", category: "character", target: "Karin", hint: "girl", status: "confirmed", origin: { by: "user" } });
    expect(r.entries.find((x) => x.text === "Dislikes tea.")).toMatchObject({ about: karin.id, status: "suggested" });
  });

  it("lets a rejected name be brought back by typing it", () => {
    const r = apply((t) => t.replace("# Places", "## 幽霊 = ghost\n\n# Places"));
    expect(r.entries.filter((x) => x.source === "幽霊")).toHaveLength(1);
    expect(find(r, "x")).toBeUndefined();
    expect(r.entries.find((x) => x.source === "幽霊")!.status).toBe("confirmed");
  });

  it("edits a scene and its summary, and says what it cannot do", () => {
    const r = apply((t) => t.replace("At the gate.", "At the school gate after class.").replace("| 花子, 太郎 ?", "| 太郎").replace("A short chapter.", "A short, quiet chapter."));
    expect(find(r, "sc")).toMatchObject({ text: "At the school gate after class.", related: ["t"], scope: { blockHashes: ["a", "b"], block: 1, blockEnd: 2 } });
    expect(find(r, "su")!.text).toBe("A short, quiet chapter.");
    const added = apply((t) => t + "\n## Block 9 | 太郎\nA scene typed by hand.\n");
    expect(added.problems[0]!.message).toMatch(/no scene to edit/);
    expect(added.entries.filter((x) => x.kind === "scene")).toHaveLength(1);
  });

  it("leaves documents that have no section alone, and points out lines it cannot place", () => {
    const withoutDoc = apply((t) => t.slice(0, t.indexOf("# Document")));
    expect(find(withoutDoc, "sc")).toBeDefined();
    expect(find(withoutDoc, "su")).toBeDefined();
    const bad = parseDocument("stray\n# Odd\n## 花子 Hanako\n- fact\n");
    expect(bad.problems.map((p) => p.line)).toEqual([1, 2, 4]);
  });
});
