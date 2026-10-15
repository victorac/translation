import {
  describe,
  expect,
  it,
} from "vitest";
import {
  parseKnowledge,
} from "./knowledge.js";

const KB = ["# People", "花子 = Hanako # girl, speaks politely", "太郎 -> Taro", "", "> The second speaker is talking to Hanako.", "> names | an older note that named words", "this line is wrong", "> "].join("\n");

describe("parseKnowledge", () => {
  const k = parseKnowledge(KB);
  it("reads terms with hints and notes, dropping words older notes were tied to", () => {
    expect(k.glossary).toEqual([
      { source: "花子", target: "Hanako", note: "girl, speaks politely" },
      { source: "太郎", target: "Taro" },
    ]);
    expect(k.notes).toEqual([{ text: "The second speaker is talking to Hanako." }, { text: "an older note that named words" }]);
  });
  it("says how each line was read, with positions", () => {
    expect(k.lines.map((l) => l.kind)).toEqual(["comment", "term", "term", "blank", "note", "note", "problem", "problem"]);
    const bad = k.lines[6]!;
    expect(KB.slice(bad.from, bad.to)).toBe("this line is wrong");
  });
});

