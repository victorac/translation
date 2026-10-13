import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "./entries.js";
import { entriesToConsider, entryLine, parseResearchReply, researchBatches, researchUserMessage, updateRecord } from "./research.js";

const e = (id: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  kind: "term",
  source: id,
  target: id.toUpperCase(),
  hint: "",
  category: "term",
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
const note = (id: string, text: string, over: Partial<KnowledgeEntry> = {}) => e(id, { kind: "note", source: "", target: "", text, ...over });
describe("research prompt and reply", () => {
  it("shows entries as a numbered list before the passage", () => {
    const m = researchUserMessage("本文", [e("a", { hint: "girl" }), note("n", "She speaks politely.")]);
    expect(m).toBe("KNOWN SO FAR:\n1. a = A (girl)\n2. note: She speaks politely.\n\nPASSAGE:\n本文");
    expect(entryLine(e("b"))).toBe("b = B");
  });

  it("reads the numbers chosen, ignoring anything outside the list", () => {
    expect(parseResearchReply("1, 3 and 3, 9, 0", 3)).toEqual([0, 2]);
    expect(parseResearchReply("NONE", 3)).toEqual([]);
    expect(parseResearchReply("none of these", 3)).toEqual([]);
    expect(parseResearchReply("", 3)).toEqual([]);
  });

  it("splits a long list so each part fits", () => {
    const list = Array.from({ length: 10 }, (_, i) => e(`w${i}`));
    const parts = researchBatches(list, 20);
    expect(parts.flat()).toHaveLength(10);
    expect(parts.length).toBeGreaterThan(1);
    expect(researchBatches(list, 100000)).toHaveLength(1);
    expect(researchBatches([], 10)).toEqual([]);
  });
});

describe("what is remembered about a passage", () => {
  const fact = note("f", "A fact about a.", { about: "a" });
  const scene = e("sc", { kind: "scene", text: "A scene.", scope: { documentId: "d", blockHash: "h" } });
  const all = [e("a"), e("b"), note("n", "x"), fact, scene];

  it("considers terms and loose notes, not facts attached to a term, scenes or summaries", () => {
    expect(entriesToConsider(all, undefined).map((x) => x.id)).toEqual(["a", "b", "n"]);
  });

  it("later considers only entries that are new or changed", () => {
    const rec = updateRecord(undefined, all, all.filter((x) => ["a", "b", "n"].includes(x.id)), ["a"], "2026-02-01T00:00:00.000Z");
    expect(rec).toEqual({ ids: ["a"], seen: ["a", "b", "n"], at: "2026-02-01T00:00:00.000Z" });
    expect(entriesToConsider(all, rec)).toEqual([]);
    const later = [...all, e("c"), { ...e("b"), updatedAt: "2026-03-01T00:00:00.000Z" }].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);
    later[1] = { ...e("b"), updatedAt: "2026-03-01T00:00:00.000Z" };
    expect(entriesToConsider(later, rec).map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("re-deciding a changed entry replaces its earlier answer, and deleted entries drop out", () => {
    const rec = { ids: ["a", "b"], seen: ["a", "b"], at: "t0" };
    const changed = [e("a", { updatedAt: "t1" })];
    const next = updateRecord(rec, changed, changed, [], "t2");
    expect(next.ids).toEqual([]); // "a" was reconsidered and not chosen; "b" no longer exists
  });
});
