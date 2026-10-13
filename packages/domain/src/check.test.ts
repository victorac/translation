import { describe, expect, it } from "vitest";
import { DEFAULT_CLASSES_TEXT, parseClasses } from "./classes.js";
import { applyChecks, checkKnowledge } from "./check.js";
import type { KnowledgeEntry } from "./entries.js";

let n = 0;
const deps = { newId: () => `c${++n}`, now: () => "2026-02-01T00:00:00.000Z" };
const classes = parseClasses(DEFAULT_CLASSES_TEXT).classes;
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
  updatedAt: "x",
  ...over,
});

describe("checking the knowledge base", () => {
  it("finds topics that share a name, topics with the same English name, and nothing in a clean base", () => {
    const clean = [e("a", { source: "花子", target: "Hanako" }), e("b", { source: "太郎", target: "Taro" })];
    expect(checkKnowledge(clean, classes)).toEqual([]);
    const shared = checkKnowledge([e("a", { source: "花子", target: "Hanako" }), e("b", { source: "佐藤花子", aliases: ["花子"], target: "Hanako N." })], classes);
    expect(shared).toEqual([{ about: "b", text: 'Check: "花子" is a name of both 花子 and 佐藤花子. Are they the same?' }]);
    const sameEnglish = checkKnowledge([e("a", { source: "花子", target: "Hanako" }), e("b", { source: "佐藤花子", target: "hanako" })], classes);
    expect(sameEnglish[0]!.text).toMatch(/both translated as "Hanako"/);
    // The same English name for a person and a place is no problem.
    expect(checkKnowledge([e("a", { source: "花子", target: "Hanako" }), e("b", { source: "花子町", target: "Hanako", category: "place" })], classes)).toEqual([]);
  });

  it("finds links that lead nowhere or to the wrong kind of topic, bad choices, and a missing English name", () => {
    const entries = [
      e("a", { source: "花子", target: "Hanako", attrs: { gender: ["purple"], family: ["未知の家"], "lives in": ["太郎"] } }),
      e("b", { source: "太郎", target: "" }),
    ];
    expect(checkKnowledge(entries, classes).map((i) => i.text)).toEqual([
      'Check: "purple" is not a choice for gender (male, female, other, unknown).',
      'Check: family points to "未知の家", but there is no such topic.',
      'Check: lives in points to "太郎", which is a character, not a place.',
      "Check: this topic has no English name.",
    ]);
  });

  it("adds each issue once as a suggested note, never again after the user deleted it, and removes it when it is fixed", () => {
    const topics = [e("a", { source: "花子", target: "Hanako" }), e("b", { source: "佐藤花子", target: "Hanako" })];
    const issues = checkKnowledge(topics, classes);
    const first = applyChecks(topics, [], issues, deps);
    expect(first).toMatchObject({ added: 1, removed: 0 });
    expect(first.entries.at(-1)).toMatchObject({ kind: "note", about: "b", status: "suggested", text: issues[0]!.text });
    const again = applyChecks(first.entries, [], issues, deps);
    expect(again).toMatchObject({ added: 0, removed: 0 });
    // Deleted by the user (so it is a rejected note): not added again.
    const rejected = [{ ...first.entries.at(-1)!, status: "rejected" as const }];
    expect(applyChecks(topics, rejected, issues, deps).added).toBe(0);
    // Fixed: the note goes away.
    const fixed = applyChecks(first.entries, [], [], deps);
    expect(fixed).toMatchObject({ added: 0, removed: 1 });
    expect(fixed.entries.some((x) => x.kind === "note")).toBe(false);
  });
});
