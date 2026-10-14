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
    expect(r.entries.filter((e) => e.kind === "term")).toEqual([]);
    const classified = new Set(asked.filter((q) => q.id === "classify").map((q) => aboutName(q)));
    expect([...classified]).toEqual(["花子"]); // 学園 was rejected, 幽霊 is not in the passage
  });
});

describe("checking what the model says", () => {
  it("drops an answer when the model changes its mind with the options in the other order", async () => {
    // This model always picks the first option, whatever it says.
    const lazy = scripted((q) => (q.id === "classify" ? "A" : null));
    const r = await extractBlock(base(lazy.asker, { candidates: ["花子"], listNames: false }));
    expect(r.entries.filter((e) => e.kind === "term")).toEqual([]);
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

  it("throws away a topic description the passage does not support, but keeps a scene description the model wrote from the passage", async () => {
    const unsupportedAll = scripted(sensible({ supported: (q) => letter(q, "No") }));
    const r = await extractBlock(base(unsupportedAll.asker));
    expect(r.entries.find((e) => e.source === "花子")!.hint).toBe("");
    expect(r.entries.find((e) => e.kind === "scene")!.text).toBe("Hanako waits at the school gate."); // a small model's yes or no is too unsteady to judge a scene by
    expect(r.unsupported).toBe(1);
    expect(r.problems).toEqual([]);
  });

  it("tries a name and a description once more, with a stricter instruction, when the first answer cannot be used", async () => {
    let names = 0;
    let descriptions = 0;
    const { asker, asked } = scripted(
      sensible({
        "english-name": (q) => (++names === 1 ? "Hanako is the girl who waits, a student, in the class" : "Hanako"),
        describe: (q) => (++descriptions === 1 ? "花子は少女" : "a girl waiting at the gate"),
      }),
    );
    const r = await extractBlock(base(asker, { candidates: ["花子"], listNames: false }));
    expect(r.entries[0]).toMatchObject({ target: "Hanako", hint: "a girl waiting at the gate" });
    expect(asked.filter((q) => q.id === "english-name")[1]!.user).toContain("not a plain name");
    expect(asked.filter((q) => q.id === "describe")[1]!.user).toContain("could not be used");
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
  const first = (word = "ぼく") => `${word}は太郎という。花子は笑った。`;
  const people = { 太郎: { english: "Taro" }, 花子: { english: "Hanako" } } as const;
  const answers = (extra: Partial<Record<string, (q: Question) => string | null>> = {}) =>
    sensible({
      classify: (q) => letter(q, people[aboutName(q) as keyof typeof people] ? "a person" : "not a name"),
      "english-name": (q) => people[aboutName(q) as keyof typeof people]?.english ?? "",
      describe: () => "UNKNOWN",
      attribute: (q) => letter(q, "Not stated"),
      ...extra,
    });

  it("makes a scene for the passage, and says who the narrator is when it is told as \"I\"", async () => {
    const { asker, asked } = scripted(answers({ narrator: (q) => letter(q, /^太郎/), "scene-text": () => "Taro introduces himself, and Hanako laughs." }));
    const r = await extractBlock(base(asker, { passage: first(), candidates: ["太郎", "花子"], listNames: false }));
    const taro = r.entries.find((e) => e.source === "太郎")!;
    const scene = r.entries.find((e) => e.kind === "scene")!;
    expect(taro.attrs).toEqual({ role: ["narrator"] });
    expect(taro.attrFlags).toEqual(["role"]);
    expect(scene).toMatchObject({ text: "Taro introduces himself, and Hanako laughs.", scope: { block: 1, blockHashes: ["h1"] } });
    expect(scene.related).toEqual(expect.arrayContaining([taro.id]));
    const sceneQuestion = asked.find((q) => q.id === "scene-text")!;
    expect(sceneQuestion.user).toContain("The narrator, the one who says ぼく about himself or herself, is Taro.");
    expect(sceneQuestion.user).toContain("太郎 = Taro; 花子 = Hanako");
    expect(asked.filter((q) => q.id === "narrator")).toHaveLength(2); // asked in both orders
  });

  it("uses a narrator it already knows, even when the narrator is not named in this passage, and does not ask again", async () => {
    const narrator = entry("t", { source: "太郎", target: "Taro", attrs: { role: ["narrator"] } });
    const { asker, asked } = scripted(answers({ "scene-text": () => "Hanako waits at the gate for Taro." }));
    const r = await extractBlock(base(asker, { entries: [narrator, entry("h", { source: "花子", target: "Hanako" })], passage: "ぼくは校門で待っていた。花子が来た。", scope: { documentId: "d1", blockHash: "h2", block: 2 }, candidates: [], listNames: false }));
    expect(asked.some((q) => q.id === "narrator")).toBe(false);
    expect(asked.find((q) => q.id === "scene-text")!.user).toContain("is Taro.");
    expect(r.entries.find((e) => e.kind === "scene")!.related).toEqual(expect.arrayContaining(["t", "h"]));
  });

  it("does not ask who the narrator is for a passage that is not told as \"I\", and leaves it unsaid when the model cannot tell", async () => {
    const third = scripted(answers());
    await extractBlock(base(third.asker, { passage: "花子は笑った。太郎は黙った。", candidates: ["太郎", "花子"], listNames: false }));
    expect(third.asked.some((q) => q.id === "narrator")).toBe(false);
    const unclear = scripted(answers({ narrator: (q) => letter(q, "None") }));
    const r = await extractBlock(base(unclear.asker, { passage: first(), candidates: ["太郎", "花子"], listNames: false }));
    expect(r.entries.find((e) => e.source === "太郎")!.attrs).toEqual({});
    expect(unclear.asked.find((q) => q.id === "scene-text")!.user).not.toContain("The narrator");
  });

  it("writes who says each line before describing the scene, from the narration, from who is spoken to, and from taking turns", async () => {
    const passage = "ぼくは花子を待っていた。\n\n「遅いな、花子」\n\n「すみません、山田」\n\n「いいよ」";
    const narrator = entry("t", { source: "山田太郎", target: "Taro", aliases: ["山田"], attrs: { role: ["narrator"] } });
    const k = entry("k", { source: "花子", target: "Hanako" });
    const { asker, asked } = scripted(answers({ "scene-text": () => "Taro and Hanako talk." }));
    await extractBlock(base(asker, { entries: [narrator, k], passage, candidates: [], listNames: false }));
    const user = asked.find((q) => q.id === "scene-text")!.user;
    expect(user).toContain("[Taro] 「遅いな、花子」");
    expect(user).toContain("[Hanako] 「すみません、山田」");
    expect(user).toContain("[Taro] 「いいよ」");
    expect(user).toContain("said by that person");
    expect(asked.some((q) => q.id === "speaker")).toBe(false); // all settled by code
  });

  it("names a person or family from the readings, a short form of a known name is that person, and a place is not described as a person", async () => {
    const taro = entry("w", { source: "鈴木花子", target: "Hanako Suzuki" });
    const { asker, asked } = scripted(
      answers({
        classify: (q) => letter(q, /^(山田家|花子)$/.test(aboutName(q)) ? (aboutName(q) === "花子" ? "a person" : "a family") : /学園/.test(aboutName(q)) ? "an organization" : "not a name"),
        "english-name": () => "Sakuradai Academy",
        describe: (q) => (aboutName(q) === "桜台学園" ? "A male student and heir" : "UNKNOWN"),
      }),
    );
    const r = await extractBlock(base(asker, { entries: [taro], passage: "花子は山田家の桜台学園に通う。", candidates: ["花子", "山田家", "桜台学園"], listNames: false, readings: async () => ({ 山田家: ["ヤマダ", "カ"] }) }));
    expect(r.entries.find((e) => e.id === "w")!.aliases).toEqual(["花子"]);
    expect(r.entries.find((e) => e.source === "山田家")).toMatchObject({ target: "Yamada family", category: "family" });
    expect(asked.some((q) => q.id === "english-name" && aboutName(q) === "山田家")).toBe(false); // not asked of a model
    expect(r.entries.find((e) => e.source === "桜台学園")!.hint).toBe("");
  });

  it("tries once more with the English names when the first scene description is in the wrong language", async () => {
    let scenes = 0;
    const { asker, asked } = scripted(sensible({ "scene-text": () => (++scenes === 1 ? "花子が学園の門で待っている。" : "Hanako waits at the school gate.") }));
    const r = await extractBlock(base(asker));
    const scene = r.entries.find((e) => e.kind === "scene")!;
    expect(scene.text).toBe("Hanako waits at the school gate.");
    const [one, two] = asked.filter((q) => q.id === "scene-text");
    expect(one!.user).toContain("花子 = Hanako"); // the names of the people in the passage are given up front
    expect(two!.user).toContain("could not be used");
    expect(r.problems).toEqual([]);
  });

  it("still makes the scene, without a description, when it cannot be written, and says so", async () => {
    const { asker } = scripted(sensible({ "scene-text": () => "花子が待っている" }));
    const r = await extractBlock(base(asker));
    expect(r.entries.find((e) => e.kind === "scene")).toMatchObject({ text: "", status: "suggested", scope: { block: 1, blockHashes: ["h1"] } });
    expect(r.problems).toEqual(["Block 1: a description of what happens could not be written, so the scene has no description yet. You can write it yourself."]);
  });

  it("says when a name was left out because the model gave no usable English name, and when answers contradicted themselves", async () => {
    const lazy = scripted((q) => (q.id === "classify" ? "A" : null));
    const a = await extractBlock(base(lazy.asker, { candidates: ["花子"], listNames: false }));
    expect(a.problems).toEqual(expect.arrayContaining([expect.stringMatching(/answer was not used in block 1/)]));
    const noName = await extractBlock(base(scripted(sensible({ "english-name": () => "" })).asker, { candidates: ["花子"], listNames: false }));
    expect(noName.problems).toEqual(expect.arrayContaining(["「花子」 was left out: the model did not give a usable English name for it."]));
  });

  it("stops as soon as asked to, and says so", async () => {
    let calls = 0;
    const { asker } = scripted(sensible());
    const r = await extractBlock(base(asker, { shouldStop: () => ++calls > 3 }));
    expect(r.stopped).toBe(true);
    expect(r.asked).toBeLessThanOrEqual(3);
  });
});
