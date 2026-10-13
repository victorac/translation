import { describe, expect, it } from "vitest";
import { KnowledgeStore } from "./knowledge-store.js";

let n = 0;
const make = () => new KnowledgeStore({ newId: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" });
const term = (source: string, target: string, hint = "") => ({ kind: "term" as const, source, target, hint, text: "", about: null });
const note = (text: string) => ({ kind: "note" as const, source: "", target: "", hint: "", text, about: null });

describe("KnowledgeStore", () => {
  it("adds, lists in the order added, and counts", () => {
    const s = make();
    s.save(term("魔王", "Demon King", "villain"));
    s.save(note("He speaks formally."));
    expect(s.list().entries.map((e) => e.kind)).toEqual(["term", "note"]);
    expect(s.counts()).toEqual({ terms: 1, notes: 1, scenes: 0, summaries: 0, suggested: 0 });
  });

  it("searches any field, in either language, and filters", () => {
    const s = make();
    s.save(term("魔王", "Demon King", "villain"));
    s.save(term("勇者", "Hero"));
    s.save(note("The hero is shy."));
    expect(s.list({ text: "魔王" }).entries).toHaveLength(1);
    expect(s.list({ text: "hero" }).entries).toHaveLength(2);
    expect(s.list({ text: "VILLAIN" }).total).toBe(1);
    expect(s.list({ kind: "note" }).entries).toHaveLength(1);
    expect(s.list({ text: "100%" }).total).toBe(0);
  });

  it("keeps an edited entry in place and counts the user's edit as confirming it", () => {
    const s = make();
    const a = s.save(term("魔王", "Demon King"));
    s.save(term("勇者", "Hero"));
    s.addMany([{ ...a, id: "m1", kind: "term", source: "姫", target: "Princess", origin: { by: "model", model: "x" }, status: "suggested" }]);
    expect(s.counts().suggested).toBe(1);
    const edited = s.save({ ...term("魔王", "Demon Lord"), id: a.id });
    expect(s.all().map((e) => e.source)).toEqual(["魔王", "勇者", "姫"]);
    expect(edited.target).toBe("Demon Lord");
    const fixed = s.save({ ...term("姫", "The Princess"), id: "m1" });
    expect(fixed).toMatchObject({ status: "confirmed", origin: { by: "user", model: "x" } });
    expect(s.counts().suggested).toBe(0);
  });

  it("refuses incomplete or repeated entries in plain words", () => {
    const s = make();
    s.save(term("魔王", "Demon King"));
    expect(() => s.save(term("", "x"))).toThrow(/as written/);
    expect(() => s.save(term("魔王", "Other"))).toThrow(/already listed/);
    expect(() => s.save({ ...note("x"), id: "nope" })).toThrow(/no longer exists/);
  });

  it("confirms suggestions, removes entries, and skips repeats when adding many", () => {
    const s = make();
    const base = { id: "", kind: "term" as const, source: "魔王", target: "Demon King", hint: "", text: "", about: null, related: [], scope: null, origin: { by: "model" as const }, status: "suggested" as const, updatedAt: "x" };
    expect(s.addMany([{ ...base, id: "a" }, { ...base, id: "b" }, { ...base, id: "c", source: "勇者" }])).toBe(2);
    expect(s.confirm(["a"])).toBe(1);
    expect(s.confirm()).toBe(1);
    expect(s.remove(["a", "zzz"])).toBe(1);
    expect(s.all().map((e) => e.id)).toEqual(["c"]);
  });

  it("changes its revision only when something changed", () => {
    const s = make();
    const r0 = s.rev;
    s.confirm();
    s.remove(["none"]);
    expect(s.rev).toBe(r0);
    s.save(term("a", "b"));
    expect(s.rev).toBeGreaterThan(r0);
  });
});
