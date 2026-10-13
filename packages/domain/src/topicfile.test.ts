import { describe, expect, it } from "vitest";
import { DEFAULT_CLASSES_TEXT, LEGACY_CLASSES_TEXT, parseClasses } from "./classes.js";
import type { KnowledgeEntry } from "./entries.js";
import { applyFile, backlinksOf, CLASSES_ID, fileText, listFiles, newTopic, resolveName, type FileContext } from "./topicfile.js";

let n = 0;
const deps = { newId: () => `n${++n}`, now: () => "2026-02-01T00:00:00.000Z" };
const model = { by: "model" as const, model: "qwen", documentTitle: "Chapter 1", block: 2 };
const e = (id: string, over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
  id,
  kind: "term",
  source: "",
  target: "",
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
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const base = (over: Partial<KnowledgeEntry>) => e("x", { ...over, category: over.kind && over.kind !== "term" ? "term" : (over.category ?? "character") });

const entries: KnowledgeEntry[] = [
  base({ id: "h", source: "花子", aliases: ["花ちゃん"], target: "Hanako", hint: "the narrator's classmate", attrs: { gender: ["female"], family: ["佐藤家"], "member of": ["学園生徒会"], "lives in": ["学園"] }, attrFlags: ["gender"], status: "suggested", origin: model }),
  base({ id: "t", source: "太郎", target: "Taro", hint: "the narrator", attrs: { gender: ["male"] } }),
  base({ id: "f", source: "佐藤家", target: "the Sato family", category: "family" }),
  base({ id: "a", source: "学園", target: "the Academy", category: "place" }),
  base({ id: "o", source: "学園生徒会", target: "the student council", category: "organization", attrs: { "based in": ["学園"] } }),
  base({ id: "f1", kind: "note", about: "h", text: "Addresses [[太郎]] as Taro-kun.", status: "suggested", origin: model }),
  base({ id: "f2", kind: "note", about: "h", text: "Is the class president." }),
  base({ id: "su", kind: "summary", text: "A short chapter.", scope: { documentId: "d1" } }),
  base({ id: "sc", kind: "scene", text: "At the gate.", related: ["h", "t"], scope: { documentId: "d1", blockHashes: ["a", "b"], block: 1, blockEnd: 2 }, status: "suggested", origin: model }),
  base({ id: "x", source: "幽霊", target: "ghost", status: "rejected" }),
];
const live = entries.filter((x) => x.status !== "rejected");
const ctx: FileContext = { entries: live, classes: parseClasses(DEFAULT_CLASSES_TEXT).classes, classesText: DEFAULT_CLASSES_TEXT, docs: [{ id: "d1", title: "Chapter 1" }] };

describe("classes", () => {
  it("explains itself, in comments that do not count as classes", () => {
    expect(DEFAULT_CLASSES_TEXT).toContain("aliases: other ways it is written, separated by commas");
    expect(DEFAULT_CLASSES_TEXT).toContain("choice(a, b)");
    expect(parseClasses(DEFAULT_CLASSES_TEXT).problems).toEqual([]);
    expect(LEGACY_CLASSES_TEXT.startsWith("# character")).toBe(true);
    expect(parseClasses(LEGACY_CLASSES_TEXT).classes).toEqual(parseClasses(DEFAULT_CLASSES_TEXT).classes);
  });

  it("reads the default classes without problems", () => {
    const r = parseClasses(DEFAULT_CLASSES_TEXT);
    expect(r.problems).toEqual([]);
    expect(r.classes.map((c) => c.name)).toEqual(["character", "place", "organization", "family", "term"]);
    expect(r.classes[0]!.attributes[0]).toEqual({ key: "gender", kind: "choice", choices: ["male", "female", "other", "unknown"] });
    expect(r.classes[0]!.attributes.find((a) => a.key === "member of")).toEqual({ key: "member of", kind: "links", target: "organization" });
  });
  it("says what is wrong with a line", () => {
    const r = parseClasses("age: text\n# item\nweight kg\nowner: link(character)\ncolor: choice()");
    expect(r.problems.map((p) => p.line)).toEqual([1, 3, 5]);
    expect(r.classes[0]!.attributes).toHaveLength(1);
  });
});

describe("a topic as a file", () => {
  it("writes the attributes of its class, the summary, and the facts, marking what is suggested", () => {
    expect(fileText("h", ctx)).toBe(`---
type: character
name: 花子
english: Hanako
aliases: 花ちゃん
status: suggested
gender: female ?
age:
role:
speech style:
first person:
family: [[佐藤家]]
member of: [[学園生徒会]]
lives in: [[学園]]
---
the narrator's classmate

## Notes
- Addresses [[太郎]] as Taro-kun. ?
- Is the class president.
`);
  });

  it("writes scenes, summaries, the notes and the classes", () => {
    expect(fileText("sc", ctx)).toBe("---\ntype: scene\ndocument: Chapter 1\nblocks: 1-2\npresent: [[花子]], [[太郎]]\nstatus: suggested\n---\nAt the gate.\n");
    expect(fileText("su", ctx)).toBe("---\ntype: summary\ndocument: Chapter 1\n---\nA short chapter.\n");
    expect(fileText(CLASSES_ID, ctx)).toBe(DEFAULT_CLASSES_TEXT);
    expect(fileText("nope", ctx)).toBeNull();
  });

  it("lists the files grouped by class, then scenes, summaries and the rest", () => {
    const list = listFiles(ctx);
    expect(list.map((f) => `${f.group}:${f.title}`)).toEqual(["character:花子", "character:太郎", "place:学園", "organization:学園生徒会", "family:佐藤家", "scene:Block 1-2", "summary:Chapter 1", "classes:Classes"]);
    expect(list[0]).toMatchObject({ kind: "topic", suggested: true, groupLabel: "Characters", subtitle: "Hanako" });
  });

  it("reads back what it wrote and changes nothing", () => {
    for (const f of listFiles(ctx)) {
      const r = applyFile(entries, f.id, fileText(f.id, ctx)!, ctx, deps);
      expect(r.problems, f.id).toEqual([]);
      const byId = (l: KnowledgeEntry[]) => [...l].sort((a, b) => a.id.localeCompare(b.id));
      expect(byId(r.entries), f.id).toEqual(byId(entries));
    }
  });
});

describe("links", () => {
  it("finds the topic a name refers to, by name, other spelling or English name", () => {
    expect(resolveName("花ちゃん", live)?.id).toBe("h");
    expect(resolveName("taro", live)?.id).toBe("t");
    expect(resolveName("誰か", live)).toBeUndefined();
  });

  it("lists what links to a topic: attributes, [[links]] in text, and scenes", () => {
    expect(backlinksOf("a", ctx).map((b) => b.id).sort()).toEqual(["h", "o"]); // she lives there; the student council is based there
    expect(backlinksOf("t", ctx).map((b) => b.id).sort()).toEqual(["h", "sc"]); // the fact about Hanako belongs to her file
    expect(backlinksOf("f", ctx).map((b) => b.id)).toEqual(["h"]);
    expect(backlinksOf("sc", ctx)).toEqual([]);
  });
});

describe("editing a topic file", () => {
  const edit = (id: string, change: (t: string) => string, from = entries) => applyFile(from, id, change(fileText(id, ctx)!), ctx, deps);
  const find = (r: { entries: KnowledgeEntry[] }, id: string) => r.entries.find((x) => x.id === id);

  it("accepts a suggestion and a suggested attribute when their marks are removed", () => {
    const r = edit("h", (t) => t.replace("status: suggested\n", "").replace("female ?", "female"));
    expect(find(r, "h")).toMatchObject({ status: "confirmed", attrFlags: [], origin: { by: "user", model: "qwen" } });
    expect(find(r, "f1")!.status).toBe("suggested");
  });

  it("changes attributes, the summary and the English name, and adds and removes facts", () => {
    const r = edit("t", (t) => t.replace("english: Taro", "english: Taro-kun").replace("age:", "age: 17").replace("male", "female").replace("the narrator", "the narrator, a first-year\n\n## Notes\n- Dislikes tea."));
    expect(r.problems).toEqual([]);
    expect(find(r, "t")).toMatchObject({ target: "Taro-kun", hint: "the narrator, a first-year", attrs: { gender: ["female"], age: ["17"] } });
    expect(r.entries.find((x) => x.kind === "note" && x.about === "t")).toMatchObject({ text: "Dislikes tea.", status: "confirmed", origin: { by: "user" } });
  });

  it("remembers a deleted suggested fact as rejected, and removes a deleted accepted one", () => {
    const r = edit("h", (t) => t.replace("- Addresses [[太郎]] as Taro-kun. ?\n", "").replace("- Is the class president.\n", ""));
    expect(find(r, "f1")).toMatchObject({ status: "rejected" });
    expect(find(r, "f2")).toBeUndefined();
  });

  it("checks values against the class and says what is wrong, without losing the entry", () => {
    const r = edit("h", (t) => t.replace("gender: female ?", "gender: purple").replace("family: [[佐藤家]]", "family: [[未知の家]]").replace("lives in: [[学園]]", "lives in: [[太郎]]").replace("age:", "colour: red"));
    expect(r.problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/"purple" is not one of: male, female, other, unknown/),
      expect.stringMatching(/"colour" is not an attribute of character/),
      expect.stringMatching(/No topic called "未知の家" yet/),
      expect.stringMatching(/"太郎" is a character, but lives in should point to a place/),
    ]);
    expect(find(r, "h")!.attrs).toMatchObject({ gender: ["purple"], colour: ["red"] });
  });

  it("renames a topic and updates the links to it", () => {
    const r = edit("t", (t) => t.replace("name: 太郎", "name: 太朗"));
    expect(find(r, "t")!.source).toBe("太朗");
    expect(find(r, "f1")!.text).toBe("Addresses [[太朗]] as Taro-kun.");
    expect(find(r, "sc")!.related).toEqual(["h", "t"]); // scenes point at the topic itself, so they follow
  });

  it("refuses an empty name or English name and a file without its header, and leaves the entry alone", () => {
    const r = edit("t", (t) => t.replace("name: 太郎", "name:").replace("english: Taro", "english:"));
    expect(find(r, "t")).toMatchObject({ source: "太郎", target: "Taro" });
    expect(r.problems).toHaveLength(2);
    const bare = applyFile(entries, "t", "just text", ctx, deps);
    expect(bare.entries).toEqual(entries);
    expect(bare.problems[0]!.message).toMatch(/Nothing was changed/);
  });

  it("can change a topic's class", () => {
    const r = edit("o", (t) => t.replace("type: organization", "type: place"));
    expect(find(r, "o")!.category).toBe("place");
  });
});

describe("editing the other files", () => {
  it("edits a scene's text and the people present, and a summary", () => {
    const sc = applyFile(entries, "sc", fileText("sc", ctx)!.replace("At the gate.", "At the school gate.").replace("present: [[花子]], [[太郎]]", "present: [[太郎]], [[誰か]]").replace("status: suggested\n", ""), ctx, deps);
    expect(sc.entries.find((x) => x.id === "sc")).toMatchObject({ text: "At the school gate.", related: ["t"], status: "confirmed", scope: { block: 1, blockEnd: 2 } });
    expect(sc.problems[0]!.message).toMatch(/No topic called "誰か"/);
    const su = applyFile(entries, "su", fileText("su", ctx)!.replace("short", "quiet"), ctx, deps);
    expect(su.entries.find((x) => x.id === "su")!.text).toBe("A quiet chapter.");
  });

  it("edits the classes", () => {
    const classes = applyFile(entries, CLASSES_ID, "# item\nowner: link(character)\n", ctx, deps);
    expect(classes.classesText).toBe("# item\nowner: link(character)\n");
    expect(classes.problems).toEqual([]);
  });

  it("makes a new topic of a class", () => {
    expect(newTopic("Place", " 学園 ", deps)).toMatchObject({ kind: "term", category: "place", source: "学園", target: "学園", status: "confirmed", origin: { by: "user" } });
  });
});
