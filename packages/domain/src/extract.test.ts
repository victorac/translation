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

/** The letter of the option whose text matches. The answers below go by what an option says, not where it is. */
const letter = (q: Question, match: string | RegExp): string => {
  const i = q.options!.findIndex((o) => (typeof match === "string" ? o.startsWith(match) : match.test(o)));
  if (i < 0) throw new Error(`No option like ${match} in ${q.id}: ${q.options!.join(" / ")}`);
  return String.fromCharCode(65 + i);
};
const aboutName = (q: Question) => /「(.+?)」/.exec(q.user)?.[1] ?? "";

/** An asker that answers by question, and remembers what it was asked. */
function scripted(answers: (q: Question) => string | null) {
  const asked: Question[] = [];
  const asker: Asker = {
    async ask(q) {
      asked.push(q);
      return answers(q);
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

/** A model that answers everything sensibly about 花子 (a girl) and 学園 (an organization). */
const sensible = (over: Partial<Record<string, (q: Question) => string | null>> = {}) => (q: Question): string | null => {
  const custom = over[q.id];
  if (custom) return custom(q);
  switch (q.id) {
    case "list-names":
      return "花子\n学園";
    case "classify":
      return letter(q, aboutName(q) === "花子" ? "a person" : aboutName(q) === "学園" ? "an organization" : "not a name");
    case "same-as":
      return letter(q, "None");
    case "english-name":
      return aboutName(q) === "花子" ? "Hanako" : "the Academy";
    case "describe":
      return aboutName(q) === "花子" ? "a girl waiting at the gate" : "UNKNOWN";
    case "supported":
      return letter(q, "Yes");
    case "role":
      return letter(q, "speaks or acts");
    case "attribute":
      return `${letter(q, "female")} | 彼女は笑った`;
    case "relation":
      return letter(q, "No");
    case "same-scene":
      return letter(q, "No");
    case "scene-text":
      return "Hanako waits at the school gate.";
    default:
      return null;
  }
};

describe("reading a passage in layers", () => {
  it("makes new topics from candidate names, one narrow question at a time", async () => {
    const { asker, asked } = scripted(sensible());
    const r = await extractBlock(base(asker));
    const [hanako, academy, scene] = r.entries;
    expect(hanako).toMatchObject({ source: "花子", target: "Hanako", category: "character", hint: "a girl waiting at the gate", status: "suggested", origin });
    expect(academy).toMatchObject({ source: "学園", target: "the Academy", category: "organization", hint: "" });
    expect(hanako!.attrs).toEqual({ gender: ["female"] });
    expect(hanako!.attrFlags).toEqual(["gender"]);
    expect(scene).toMatchObject({ kind: "scene", text: "Hanako waits at the school gate.", related: [hanako!.id], scope: { documentId: "d1", blockHashes: ["h1"], block: 1 } });
    expect(r).toMatchObject({ added: 4, disputed: 0, unsupported: 0, stopped: false });
    expect(asked.every((q) => q.user.length < 700)).toBe(true);
    // The questions that matter most are asked twice, with the options the other way round.
    expect(asked.filter((q) => q.id === "classify")).toHaveLength(4);
    expect(asked.filter((q) => q.id === "attribute")).toHaveLength(2);
  });

  it("does not ask about names it already knows, and asks the link question only when the other end is in the passage", async () => {
    const known = [entry("h", { source: "花子", target: "Hanako" }), entry("a", { source: "学園", target: "the Academy", category: "organization" })];
    const { asker, asked } = scripted(sensible({ attribute: (q) => letter(q, "Not stated"), relation: (q) => `${letter(q, "Yes")} | 学園の門で待っていた` }));
    const r = await extractBlock(base(asker, { entries: known }));
    expect(asked.map((q) => q.id)).not.toContain("classify");
    const hanako = r.entries.find((e) => e.id === "h")!;
    expect(hanako.attrs).toEqual({ "member of": ["学園"] }); // only the link came with a real quote
    expect(hanako.attrFlags).toEqual(["member of"]);
    expect(hanako.status).toBe("confirmed"); // an accepted topic stays accepted; only the new attribute is a suggestion
  });

  it("treats a spelling of a known person as the same person, not as someone new", async () => {
    const known = [entry("k", { source: "佐藤花子", target: "Hanako Sato" })];
    const { asker, asked } = scripted(sensible({ classify: (q) => letter(q, "a person"), "same-as": (q) => letter(q, /^佐藤花子/), attribute: (q) => letter(q, "Not stated") }));
    const r = await extractBlock(base(asker, { entries: known, passage: "花子は笑った。佐藤花子は来た。", candidates: ["花子"], listNames: false }));
    expect(r.entries.filter((e) => e.kind === "term")).toHaveLength(1);
    expect(r.entries[0]!.aliases).toEqual(["花子"]);
    expect(asked.some((q) => q.id === "english-name")).toBe(false);
  });

  it("skips what the user rejected, names that are not names, and names the passage does not contain", async () => {
    const rejected = [entry("r", { source: "学園", target: "x", status: "rejected" })];
    const { asker, asked } = scripted((q) => (q.id === "list-names" ? "幽霊\n花子" : q.id === "classify" ? letter(q, "not a name") : null));
    const r = await extractBlock(base(asker, { rejected }));
    expect(r.entries).toEqual([]);
    const classified = new Set(asked.filter((q) => q.id === "classify").map((q) => aboutName(q)));
    expect([...classified]).toEqual(["花子"]); // 学園 was rejected, 幽霊 is not in the passage
  });
});

describe("checking what the model says", () => {
  it("drops an answer when the model changes its mind with the options in the other order", async () => {
    // This model always picks the first option, whatever it says.
    const lazy = scripted((q) => (q.id === "classify" ? "A" : null));
    const r = await extractBlock(base(lazy.asker, { candidates: ["花子"], listNames: false }));
    expect(r.entries).toEqual([]);
    expect(r.disputed).toBe(1);
  });

  it("keeps an attribute only when both answers agree and the quote is in the passage", async () => {
    const known = [entry("h", { source: "花子", target: "Hanako" })];
    const run = async (attribute: (q: Question) => string) => (await extractBlock(base(scripted(sensible({ attribute })).asker, { entries: known, listNames: false, candidates: [] }))).entries.find((e) => e.id === "h")!.attrs.gender;
    expect(await run((q) => `${letter(q, "female")} | 彼女は笑った`)).toEqual(["female"]);
    expect(await run((q) => `${letter(q, "female")} | 彼は怒った`)).toBeUndefined(); // a quote that is not there
    expect(await run((q) => `${letter(q, "female")}`)).toBeUndefined(); // no quote
    expect(await run((q) => letter(q, "Not stated"))).toBeUndefined();
    expect(await run(() => "A | 彼女は笑った")).toBeUndefined(); // favours a position: different answers in the two orders
  });

  it("throws away a description the passage does not support, and a scene it does not support", async () => {
    const unsupportedAll = scripted(sensible({ supported: (q) => letter(q, "No") }));
    const r = await extractBlock(base(unsupportedAll.asker));
    expect(r.entries.find((e) => e.source === "花子")!.hint).toBe("");
    expect(r.entries.some((e) => e.kind === "scene")).toBe(false);
    expect(r.unsupported).toBe(2); // the girl's description and the scene (the school had none)
  });

  it("asks for descriptions in the language of the translation, and throws away one that comes back in the language of the passage", async () => {
    const chinese = scripted(sensible({ describe: () => "山田太郎是該段文字的作者。" }));
    const r = await extractBlock(base(chinese.asker, { candidates: ["花子"], listNames: false }));
    expect(chinese.asked.find((q) => q.id === "describe")!.user).toContain("written in English");
    expect(r.entries.find((e) => e.source === "花子")).toMatchObject({ target: "Hanako", hint: "" });
    expect(r.unsupported).toBeGreaterThanOrEqual(1);
  });

  it("removes the full stop from an English name", async () => {
    const r = await extractBlock(base(scripted(sensible({ "english-name": () => "Taro Yamada." })).asker, { candidates: ["花子"], listNames: false }));
    expect(r.entries.find((e) => e.kind === "term")!.target).toBe("Taro Yamada");
  });

  it("does not make a topic whose English name still has Japanese characters in it", async () => {
    const r = await extractBlock(base(scripted(sensible({ "english-name": () => "花子さん" })).asker, { candidates: ["花子"], listNames: false }));
    expect(r.entries.filter((e) => e.kind === "term")).toEqual([]);
  });

  it("asks a choice again once when the reply is not one of the options", async () => {
    let first = true;
    const { asker, asked } = scripted(sensible({ classify: (q) => { if (first) { first = false; return "Probably a person"; } return letter(q, "a person"); } }));
    const r = await extractBlock(base(asker, { candidates: ["花子"], listNames: false }));
    expect(asked.filter((q) => q.id === "classify").length).toBeGreaterThan(2);
    expect(r.entries[0]).toMatchObject({ source: "花子", target: "Hanako" });
  });
});

describe("scenes and stopping", () => {
  const prev = entry("s", { kind: "scene", category: "term", text: "At the gate.", status: "suggested", scope: { documentId: "d1", blockHashes: ["h0"], block: 1 } });
  const run = (continues: boolean, entries: KnowledgeEntry[] = [prev]) =>
    extractBlock(base(scripted(sensible({ "same-scene": (q) => letter(q, continues ? "Yes" : "No"), "scene-text": () => "Later, in class." })).asker, { entries, scope: { documentId: "d1", blockHash: "h1", block: 2 }, candidates: [], listNames: false }));

  it("continues the scene before it when the model says so, and starts a new one otherwise", async () => {
    const cont = await run(true);
    expect(cont.entries).toHaveLength(1);
    expect(cont.entries[0]!.scope).toMatchObject({ blockHashes: ["h0", "h1"], block: 1, blockEnd: 2 });
    const fresh = await run(false);
    expect(fresh.entries).toHaveLength(2);
    expect(fresh.entries[1]).toMatchObject({ text: "Later, in class.", scope: { block: 2 } });
    const confirmed = await run(true, [{ ...prev, status: "confirmed" as const }]);
    expect(confirmed.entries).toHaveLength(2); // a scene the user accepted is never extended
  });

  it("stops as soon as asked to, and says so", async () => {
    let calls = 0;
    const { asker } = scripted(sensible());
    const r = await extractBlock(base(asker, { shouldStop: () => ++calls > 3 }));
    expect(r.stopped).toBe(true);
    expect(r.asked).toBeLessThanOrEqual(3);
  });
});
