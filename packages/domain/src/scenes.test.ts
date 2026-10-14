import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "./entries.js";
import type { Asker } from "./extract.js";
import { mergeScenes } from "./scenes.js";
import type { Question } from "./steps.js";

let n = 0;
const deps = { newId: () => `m${++n}`, now: () => "2026-02-01T00:00:00.000Z" };
const scene = (id: string, block: number, text: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  kind: "scene",
  source: "",
  target: "",
  hint: "",
  category: "term",
  aliases: [],
  attrs: {},
  attrFlags: [],
  text,
  about: null,
  related: [`p${block}`],
  scope: { documentId: "d1", blockHashes: [`h${block}`], block },
  origin: { by: "model" },
  status: "suggested",
  updatedAt: "x",
  ...over,
});
const letter = (q: Question, start: string) => String.fromCharCode(65 + q.options!.findIndex((o) => o.startsWith(start)));

/** Says whether two descriptions go together by whether they both mention the same place. */
function judge(together: (a: string, b: string) => boolean) {
  const asked: Question[] = [];
  const asker: Asker = {
    async ask(q) {
      asked.push(q);
      if (q.id !== "same-scene") return "Summary.";
      const [, a, b] = /FIRST: (.*)\nSECOND: (.*)/.exec(q.user)!;
      return letter(q, together(a!, b!) ? "Yes" : "No");
    },
  };
  return { asker, asked };
}
const run = (entries: KnowledgeEntry[], asker: Asker) => mergeScenes({ entries, documentId: "d1", title: "Chapter 1", targetLanguage: "English", asker, room: 4000, deps });

describe("joining neighbouring scenes", () => {
  const gate = (s: string) => s.includes("gate");
  const entries = [scene("a", 1, "Hanako greets Taro at the school gate."), scene("b", 2, "At the gate, Taro says he waited for her."), scene("c", 3, "In class, the teacher starts the lesson.")];

  it("joins neighbours the model says belong together, one question per pair, and keeps the descriptions as they were written", async () => {
    const { asker, asked } = judge((a, b) => gate(a) && gate(b));
    const r = await run(entries, asker);
    expect(r).toMatchObject({ joined: 1, canceled: false });
    expect(r.entries.map((e) => e.id)).toEqual(["a", "c"]);
    expect(r.entries[0]).toMatchObject({
      text: "Hanako greets Taro at the school gate. At the gate, Taro says he waited for her.",
      related: ["p1", "p2"],
      scope: { block: 1, blockEnd: 2, blockHashes: ["h1", "h2"] },
    });
    expect(r.entries[1]).toEqual(entries[2]); // untouched
    // Each pair is asked once in each order, and a pair is only joined when both orders say yes.
    expect(asked.filter((q) => q.id === "same-scene")).toHaveLength(2 + 2 - 1); // (a,b) twice; (b,c) once, since the first answer was no
  });

  it("does not join when the answers disagree, when a scene was accepted, or when a description is missing, and never joins blocks that are not neighbours", async () => {
    const flip = scripted();
    const r = await run(entries, flip.asker);
    expect(r.joined).toBe(0);
    const accepted = await run([entries[0]!, { ...entries[1]!, status: "confirmed" as const }, entries[2]!], judge(() => true).asker);
    expect(accepted.joined).toBe(0);
    const blank = await run([entries[0]!, scene("b", 2, ""), entries[2]!], judge(() => true).asker);
    expect(blank.joined).toBe(0);
    const gap = await run([entries[0]!, scene("c", 3, "At the gate again.")], judge(() => true).asker);
    expect(gap.joined).toBe(0);
  });

  it("joins a run of several, and stops when asked to", async () => {
    const many = [1, 2, 3, 4].map((b) => scene(`s${b}`, b, `At the gate, part ${b}.`));
    const r = await run(many, judge(() => true).asker);
    expect(r.joined).toBe(3);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.scope).toMatchObject({ block: 1, blockEnd: 4 });
    let calls = 0;
    const stopped = await mergeScenes({ entries: many, documentId: "d1", title: "x", targetLanguage: "English", asker: judge(() => true).asker, room: 4000, deps, shouldStop: () => ++calls > 1 });
    expect(stopped.canceled).toBe(true);
  });
});

/** An asker that answers the first option in either order, which is a model that is guessing. */
function scripted() {
  return { asker: { async ask() { return "A"; } } as Asker };
}
