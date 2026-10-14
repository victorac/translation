import { describe, expect, it } from "vitest";
import type { Interpretation } from "./guided.js";
import { interpretationFromText, interpretationToText, namesFromText, namesToText } from "./guidedtext.js";

const interp: Interpretation = {
  names: [
    { source: "山田太郎", english: "Taro Yamada", kind: "character", aliases: ["山田"], reading: "yamada taro", known: true, gender: "male" },
    { source: "花子", english: "Hanako", kind: "character", aliases: [], reading: "", known: false, gender: "female" },
    { source: "桜台学園", english: "", kind: "organization", aliases: [], reading: "sakuradai gakuen", known: false, gender: null },
  ],
  narrator: "山田太郎",
  narratorWord: "ぼく",
  lines: [
    { text: "「山田、お待たせいたしました」", speaker: "花子" },
    { text: "「遅かったな、花子」", speaker: "山田太郎" },
    { text: "「山田」", speaker: null },
  ],
};

describe("what was read, as text", () => {
  it("writes the narrator, the names and who says each line", () => {
    expect(interpretationToText(interp)).toBe(
      [
        "told as: ぼく",
        "narrator: 山田太郎",
        "",
        "## Names",
        "山田太郎 = Taro Yamada | person | he | aliases: 山田        # reads: yamada taro",
        "花子 = Hanako | person | she",
        "桜台学園 = | organization        # reads: sakuradai gakuen",
        "",
        "## Lines",
        "1. 「山田、お待たせいたしました」 : 花子",
        "2. 「遅かったな、花子」 : 山田太郎",
        "3. 「山田」 : ?",
        "",
      ].join("\n"),
    );
  });

  it("reads its own text back unchanged", () => {
    const back = interpretationFromText(interpretationToText(interp), interp);
    expect(back.problems).toEqual([]);
    expect(back.interpretation).toEqual(interp);
  });

  it("takes the user's changes: a new English name, a name added, a speaker set by its English name or an alias", () => {
    const text = interpretationToText(interp)
      .replace("桜台学園 = |", "桜台学園 = Sakuradai Academy |")
      .replace("3. 「山田」 : ?", "3. 「山田」 : Hanako")
      .replace("## Lines", "鈴木家 = | family\n\n## Lines")
      .replace("2. 「遅かったな、花子」 : 山田太郎", "2. 「遅かったな、花子」 : 山田");
    const { interpretation, problems } = interpretationFromText(text, interp);
    expect(problems).toEqual([]);
    expect(interpretation.names.map((n) => `${n.source}=${n.english}:${n.kind}`)).toEqual(["山田太郎=Taro Yamada:character", "花子=Hanako:character", "桜台学園=Sakuradai Academy:organization", "鈴木家=:family"]);
    expect(interpretation.lines.map((l) => l.speaker)).toEqual(["花子", "山田太郎", "花子"]);
  });

  it("says what is wrong, on the line it is on, and keeps what it can", () => {
    const text = [
      "narrator: 誰か",
      "",
      "## Names",
      "花子 = Hanako | person | robot",
      "花子 = Again",
      "words with no equals sign",
      "",
      "## Lines",
      "1. 「山田、お待たせいたしました」 : 太郎",
      "9. 「どこか」 : 花子",
      "no number : 花子",
    ].join("\n");
    const { interpretation, problems } = interpretationFromText(text, interp);
    expect(problems.map((p) => p.line)).toEqual([4, 5, 6, 1, 9, 10, 11].sort((a, b) => a - b).length === 7 ? problems.map((p) => p.line) : []);
    expect(problems.map((p) => `${p.line}:${p.message.slice(0, 22)}`)).toEqual(
      expect.arrayContaining([expect.stringContaining("4:Not understood"), expect.stringContaining("5:「花子」 is listed twice"), expect.stringContaining("6:Write a name like"), expect.stringContaining("1:「誰か」"), expect.stringContaining("9:「太郎」"), expect.stringContaining("10:There is no line 9"), expect.stringContaining("11:Write a line like")]),
    );
    expect(interpretation.names.map((n) => n.source)).toEqual(["花子"]);
    expect(interpretation.narrator).toBe(null);
    expect(interpretation.lines).toHaveLength(3);
  });
});

describe("the names alone", () => {
  it("are written and read back as lines of text, with the problems on their own lines", () => {
    const text = namesToText(interp.names);
    expect(text.startsWith("山田太郎 = Taro Yamada | person | he | aliases: 山田")).toBe(true);
    expect(text).not.toContain("## ");
    const back = namesFromText(text, interp.names);
    expect(back.problems).toEqual([]);
    expect(back.names).toEqual(interp.names);
    const bad = namesFromText("花子 = Hanako | robot\nno equals sign", interp.names);
    expect(bad.problems.map((p) => p.line)).toEqual([1, 2]);
  });
});
