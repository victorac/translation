import {
  describe,
  expect,
  it,
} from "vitest";
import {
  findQuestion,
  foundWords,
  kindWord,
  passagesOf,
} from "./find.js";

const kinds = ["character", "family", "place", "organization", "term", "skill", "slang"].map((name) => ({ name, word: kindWord(name) }));
const passage = "水瀬灯は灯籠祭の夜、ギルド『白銀の翼』を訪ねた。「灯ちゃん、《星詠み》を使って」とノアが言った。";

describe("finding names and terms in the source with a model", () => {
  it("asks for one word a line with the kinds to choose from", () => {
    const q = findQuestion(passage, kinds, "Japanese");
    expect(q.user).toContain(passage);
    expect(q.user).toContain("word | kind");
    expect(q.user).toContain("person, family, place, organization, term, skill, slang");
  });

  it("keeps the words written in the passage, with their kind", () => {
    const reply = "水瀬灯 | person\n- 灯籠祭 | term\n2. 『白銀の翼』 | organizations\n星詠み | skill\nノア | Person";
    expect(foundWords(reply, passage, kinds)).toEqual([
      { source: "水瀬灯", kind: "character" },
      { source: "灯籠祭", kind: "term" },
      { source: "白銀の翼", kind: "organization" },
      { source: "星詠み", kind: "skill" },
      { source: "ノア", kind: "character" },
    ]);
  });

  it("drops what is not in the passage, not a word, said twice or not a line of the list, and reads an unknown kind as a term", () => {
    const reply = "NONE\n山田太郎 | person\nは | term\n夜 | weather\n水瀬灯 | person\n水瀬灯 | place\nThe passage has names.";
    expect(foundWords(reply, passage, kinds)).toEqual([
      { source: "夜", kind: "term" },
      { source: "水瀬灯", kind: "character" },
    ]);
  });

  it("takes a name without its honorific", () => {
    expect(foundWords("灯ちゃん | person", passage, kinds)).toEqual([{ source: "灯", kind: "character" }]);
  });

  it("reads consecutive paragraphs together, up to a size", () => {
    const p = (at: number, n: number) => ({ at, text: "あ".repeat(n) });
    expect(passagesOf([p(0, 300), p(1, 200), p(2, 200), p(5, 10), p(6, 10)], 600)).toEqual([[0, 1], [2], [5, 6]]);
  });
});
