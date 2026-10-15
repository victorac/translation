import {
  describe,
  expect,
  it,
} from "vitest";
import {
  entriesFromLegacy,
  entriesFromText,
  entryProblems,
} from "./entries.js";

let n = 0;
const deps = { newId: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };

describe("entries", () => {
  const { entries, unreadable } = entriesFromText("魔王 = Demon King # villain\n> He speaks formally.\n> Keep honorifics.\nnot a line", { by: "user" }, "confirmed", deps);

  it("reads pasted lines into topics, and counts what cannot be used: notes (they belong in a topic's file) and lines it cannot read", () => {
    expect(unreadable).toBe(3);
    expect(entries).toMatchObject([{ kind: "term", source: "魔王", target: "Demon King", hint: "villain", status: "confirmed", origin: { by: "user" } }]);
  });

    it("explains what is missing", () => {
    const base = { kind: "term" as const, source: "", target: "", hint: "", category: "term" as const, aliases: [], text: "", about: null };
    expect(entryProblems(base)).toHaveLength(2);
    expect(entryProblems({ ...base, source: "a", target: "b" })).toEqual([]);
    expect(entryProblems({ ...base, kind: "note" })).toEqual(["Enter the text."]);
  });

  it("brings an older project's glossary over, and leaves its loose notes behind", () => {
    const e = entriesFromLegacy([{ source: "魔王", target: "Demon King" }], "A fact.\n- Another.", undefined, deps);
    expect(e.map((x) => x.kind)).toEqual(["term"]);
    expect(entriesFromLegacy([], undefined, "勇者 = Hero", deps)).toHaveLength(1);
  });
});

