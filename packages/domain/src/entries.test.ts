import { describe, expect, it } from "vitest";
import { entriesFromLegacy, entriesFromText, entriesToText, entryProblems, splitEntries } from "./entries.js";

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
    const base = { kind: "term" as const, source: "", target: "", hint: "", text: "", pinned: false };
    expect(entryProblems(base)).toHaveLength(2);
    expect(entryProblems({ ...base, source: "a", target: "b" })).toEqual([]);
    expect(entryProblems({ ...base, kind: "note" })).toEqual(["Enter the note."]);
  });

  it("brings an older project's glossary and notes over", () => {
    const e = entriesFromLegacy([{ source: "魔王", target: "Demon King" }], "A fact.\n- Another.", undefined, deps);
    expect(e.map((x) => x.kind)).toEqual(["term", "note", "note"]);
    expect(entriesFromLegacy([], undefined, "勇者 = Hero", deps)).toHaveLength(1);
  });
});
