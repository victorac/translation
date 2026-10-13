import { describe, expect, it } from "vitest";
import { DEFAULT_CLASSES_TEXT, parseClasses } from "./classes.js";
import type { KnowledgeEntry } from "./entries.js";
import { extractBlock, type Asker } from "./extract.js";
import type { Question } from "./steps.js";

let n = 0;
const deps = { newId: () => `n${++n}`, now: () => "2026-02-01T00:00:00.000Z" };
const classes = parseClasses(DEFAULT_CLASSES_TEXT).classes;
const origin = { by: "model" as const, model: "m", documentTitle: "Chapter 1", block: 1 };
const entry = (id: string, over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
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
  updatedAt: "x",
  ...over,
});

const PASSAGE = "花子は学園の門で待っていた。「おはよう」と彼女は笑った。";

/** An asker that answers by question, and remembers what it was asked. */
function scripted(answers: (q: Question, i: number) => string | null) {
  const asked: Question[] = [];
  const asker: Asker = {
    async ask(q) {
      asked.push(q);
      return answers(q, asked.length - 1);
    },
  };
  return { asker, asked };
}
const base = (asker: Asker, over: Record<string, unknown> = {}) => ({
  entries: [] as KnowledgeEntry[],
  rejected: [] as KnowledgeEntry[],
  classes,
  passage: PASSAGE,
  scope: { documentId: "d1", blockHash: "h1", block: 1 },
  origin,
  candidates: ["花子", "学園"],
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  asker,
  deps,
  ...over,
});
const text = (q: Question) => q.user;

describe("reading a passage in layers", () => {
  it("makes new topics from candidate names, one narrow question at a time", async () => {
    const { asker, asked } = scripted((q) => {
      if (q.id === "list-names") return "花子\n学園";
      if (q.id === "classify") return text(q).includes("「花子」") ? "A" : "C"; // a person, then an organization
      if (q.id === "english-name") return text(q).includes("「花子」") ? "Hanako" : "the Academy";
      if (q.id === "describe") return text(q).includes("「花子」") ? "a girl waiting at the gate" : "UNKNOWN";
      if (q.id === "role") return "A";
      if (q.id === "attribute") return "B | 彼女は笑った"; // the gender is stated by a real quote
      if (q.id === "scene-text") return "Hanako waits at the school gate.";
      return null;
    });
    const r = await extractBlock(base(asker));
    const [hanako, academy, scene] = r.entries;
    expect(hanako).toMatchObject({ source: "花子", target: "Hanako", category: "character", hint: "a girl waiting at the gate", status: "suggested", origin });
    expect(academy).toMatchObject({ source: "学園", target: "the Academy", category: "organization", hint: "" });
    expect(hanako!.attrs).toEqual({ gender: ["female"] });
    expect(hanako!.attrFlags).toEqual(["gender"]);
    expect(scene).toMatchObject({ kind: "scene", text: "Hanako waits at the school gate.", related: [hanako!.id], scope: { documentId: "d1", blockHashes: ["h1"], block: 1 } });
    expect(r.added).toBe(4);
    // Every question is small, has options or a single task, and names what it is about.
    expect(asked.every((q) => q.user.length < 700)).toBe(true);
    expect(asked.filter((q) => q.id === "classify")).toHaveLength(2);
  });

  it("does not ask about names it already knows, and asks the link question only when the other end is in the passage", async () => {
    const known = [entry("h", { source: "花子", target: "Hanako" }), entry("a", { source: "学園", target: "the Academy", category: "organization" })];
    const { asker, asked } = scripted((q) => {
      if (q.id === "list-names") return "花子\n学園";
      if (q.id === "role") return "A";
      if (q.id === "attribute") return "C"; // not stated
      if (q.id === "relation") return "A | 学園の門で待っていた";
      if (q.id === "scene-text") return "At the gate.";
      return null;
    });
    const r = await extractBlock(base(asker, { entries: known }));
    expect(asked.map((q) => q.id)).not.toContain("classify");
    const hanako = r.entries.find((e) => e.id === "h")!;
    expect(hanako.attrs).toEqual({ "member of": ["学園"] }); // only the link came with a real quote
    expect(hanako.attrFlags).toEqual(["member of"]);
    expect(hanako.status).toBe("confirmed"); // an accepted topic stays accepted; only the new attribute is a suggestion
  });

  it("treats a spelling of a known person as the same person, not as someone new", async () => {
    const known = [entry("k", { source: "佐藤花子", target: "Hanako Sato" })];
    const { asker, asked } = scripted((q) => {
      if (q.id === "classify") return "A";
      if (q.id === "same-as") return "A"; // the first option: the known entry
      if (q.id === "role") return "A";
      if (q.id === "attribute") return "C";
      if (q.id === "scene-text") return "x";
      return null;
    });
    const r = await extractBlock(base(asker, { entries: known, passage: "花子は笑った。佐藤花子は来た。", candidates: ["花子"], listNames: false }));
    expect(r.entries.filter((e) => e.kind === "term")).toHaveLength(1);
    expect(r.entries[0]!.aliases).toEqual(["花子"]);
    expect(asked.some((q) => q.id === "english-name")).toBe(false);
  });

  it("skips what the user rejected, names that are not names, and names the passage does not contain", async () => {
    const rejected = [entry("r", { source: "学園", target: "x", status: "rejected" })];
    const { asker, asked } = scripted((q) => {
      if (q.id === "list-names") return "幽霊\n花子";
      if (q.id === "classify") return "F"; // not a name
      return null;
    });
    const r = await extractBlock(base(asker, { rejected }));
    expect(r.entries).toEqual([]);
    const classified = asked.filter((q) => q.id === "classify").map((q) => q.user.match(/「(.+?)」/)![1]);
    expect(classified).toEqual(["花子"]); // 学園 was rejected, 幽霊 is not in the passage
  });

  it("refuses an attribute whose quote is not in the passage, and one that is not stated", async () => {
    const known = [entry("h", { source: "花子", target: "Hanako" })];
    const make = (reply: string) =>
      scripted((q) => (q.id === "role" ? "A" : q.id === "attribute" ? reply : q.id === "scene-text" ? "x" : null));
    for (const reply of ["B | 彼は怒った", "B", "C"]) {
      const r = await extractBlock(base(make(reply).asker, { entries: known, listNames: false, candidates: [] }));
      expect(r.entries.find((e) => e.id === "h")!.attrs.gender, reply).toBeUndefined();
    }
  });

  it("asks a choice again once when the reply is not one of the options", async () => {
    const { asker, asked } = scripted((q, i) => (q.id === "classify" ? (i === 0 ? "Probably a person" : "A") : q.id === "english-name" ? "Hanako" : null));
    const r = await extractBlock(base(asker, { candidates: ["花子"], listNames: false }));
    expect(asked.filter((q) => q.id === "classify")).toHaveLength(2);
    expect(r.entries[0]).toMatchObject({ source: "花子", target: "Hanako" });
  });

  it("continues the scene before it when the model says so, and starts a new one otherwise", async () => {
    const prev = entry("s", { kind: "scene", category: "term", text: "At the gate.", status: "suggested", scope: { documentId: "d1", blockHashes: ["h0"], block: 1 } });
    const run = (answer: string) => {
      const { asker } = scripted((q) => (q.id === "same-scene" ? answer : q.id === "scene-text" ? "Later, in class." : null));
      return extractBlock(base(asker, { entries: [prev], scope: { documentId: "d1", blockHash: "h1", block: 2 }, candidates: [], listNames: false }));
    };
    const cont = await run("A");
    expect(cont.entries).toHaveLength(1);
    expect(cont.entries[0]!.scope).toMatchObject({ blockHashes: ["h0", "h1"], block: 1, blockEnd: 2 });
    const fresh = await run("B");
    expect(fresh.entries).toHaveLength(2);
    expect(fresh.entries[1]).toMatchObject({ text: "Later, in class.", scope: { block: 2 } });
    // A scene the user accepted is never extended.
    const confirmed = await extractBlock(base(scripted((q) => (q.id === "scene-text" ? "New." : "A")).asker, { entries: [{ ...prev, status: "confirmed" as const }], scope: { documentId: "d1", blockHash: "h1", block: 2 }, candidates: [], listNames: false }));
    expect(confirmed.entries).toHaveLength(2);
  });

  it("stops as soon as asked to, and says so", async () => {
    let calls = 0;
    const { asker } = scripted(() => "A");
    const r = await extractBlock(base(asker, { shouldStop: () => ++calls > 3 }));
    expect(r.stopped).toBe(true);
    expect(r.asked).toBeLessThanOrEqual(3);
  });
});
