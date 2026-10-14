import { describe, expect, it } from "vitest";
import { guessGender, glossaryFor, guessKind, interpretPassage, lastLines, notesFor, readingLetters, type KnownName } from "./guided.js";

const readings = { 鈴木花子: ["スズキ", "ハナコ"], 山田太郎: ["ヤマダ", "タロウ"], 山田家: ["ヤマダ", "カ"], 桜台学園: ["ニ", "サクラダイ", "ガクエン"] };

describe("reading a block for the user to check", () => {
  it("guesses what kind of name it is from how it ends", () => {
    expect(guessKind("山田家")).toBe("family");
    expect(guessKind("桜台学園")).toBe("organization");
    expect(guessKind("桜台駅")).toBe("place");
    expect(guessKind("鈴木花子")).toBe("character");
  });

  it("makes English names of people and families from the readings, and leaves other kinds for the user with the reading as help", () => {
    const r = interpretPassage({ passage: "鈴木花子は山田家の桜台学園に通う。", candidates: ["鈴木花子", "山田家", "桜台学園"], readings, glossary: [] });
    const by = (s: string) => r.names.find((n) => n.source === s)!;
    expect(by("鈴木花子")).toMatchObject({ english: "Hanako Suzuki", kind: "character", known: false });
    expect(by("山田家")).toMatchObject({ english: "Yamada family", kind: "family" });
    expect(by("桜台学園")).toMatchObject({ english: "", kind: "organization", reading: "sakuradai gakuen" });
  });

  it("uses what the glossary already says, and does not offer it as new", () => {
    const glossary: KnownName[] = [{ source: "山田太郎", english: "Taro Yamada", kind: "character", aliases: ["山田"], narrator: true }];
    const r = interpretPassage({ passage: "ぼくは山田太郎という。", candidates: ["山田太郎"], readings, glossary });
    expect(r.names).toHaveLength(1);
    expect(r.names[0]).toMatchObject({ english: "Taro Yamada", known: true });
    expect(r.narrator).toBe("山田太郎");
    expect(r.narratorWord).toBe("ぼく");
  });

  it("does not guess the narrator when the glossary has none, and adds a given name written alone to the full name", () => {
    const r = interpretPassage({ passage: "ぼくは鈴木花子を見た。花子は笑った。", candidates: ["鈴木花子", "花子"], readings, glossary: [] });
    expect(r.narrator).toBe(null);
    expect(r.narratorWord).toBe("ぼく");
    expect(r.names.map((n) => n.source)).toEqual(["鈴木花子"]);
    expect(r.names[0]!.aliases).toEqual(["花子"]);
  });

  it("says who speaks each line, from the narration and from taking turns, with the narrator among the speakers", () => {
    const glossary: KnownName[] = [
      { source: "山田太郎", english: "Taro", kind: "character", aliases: ["山田"], narrator: true },
      { source: "花子", english: "Hanako", kind: "character", aliases: [], narrator: false },
    ];
    const passage = "「遅いですよ」と花子は言った。\n\n「ごめん」\n\n「いいえ」";
    const r = interpretPassage({ passage: `ぼくは待っていた。\n${passage}`, candidates: [], readings: {}, glossary });
    expect(r.lines.map((l) => l.speaker)).toEqual(["花子", "山田太郎", "花子"]);
  });

  it("leaves lines unlabeled when fewer than two people are known", () => {
    const r = interpretPassage({ passage: "「やあ」\n「うん」", candidates: [], readings: {}, glossary: [] });
    expect(r.lines).toEqual([{ text: "「やあ」", speaker: null }, { text: "「うん」", speaker: null }]);
  });
});

describe("what is sent with a block", () => {
  const interp = interpretPassage({
    passage: "ぼくは待った。\n「遅いですよ」と花子は言った。\n「ごめん」",
    candidates: [],
    readings: {},
    glossary: [
      { source: "山田太郎", english: "Taro", kind: "character", aliases: [], narrator: true },
      { source: "花子", english: "Hanako", kind: "character", aliases: [], narrator: false },
    ],
  });

  it("states the narrator and each known speaker, in the translation's names", () => {
    expect(notesFor(interp)).toEqual([
      "The narrator, who says ぼく about himself or herself, is Taro.",
      "The line 「遅いですよ」 is said by Hanako.",
      "The line 「ごめん」 is said by Taro.",
    ]);
  });

  it("sends only names that have an English form", () => {
    const withBlank = { ...interp, names: [...interp.names, { source: "学園", english: " ", kind: "organization" as const, aliases: [], reading: "", known: false }] };
    expect(glossaryFor(withBlank).map((g) => g.source).sort()).toEqual(["花子", "山田太郎"].sort());
  });

  it("takes the last lines of a text for overlap", () => {
    expect(lastLines("一\n二\n\n三\n四", 3, 100)).toBe("二\n三\n四");
    expect(lastLines("あいうえお", 3, 3)).toBe("うえお");
    expect(readingLetters(["ヤマダ", "タロウ"])).toBe("yamada taro");
  });
});

describe("gender", () => {
  it("is taken from a following sentence that starts with 彼女 or 彼 and names nobody else", () => {
    expect(guessGender("鈴木花子。彼女は笑った。", ["鈴木花子"], [])).toBe("female");
    expect(guessGender("太郎が来た。彼は座った。", ["太郎"], [])).toBe("male");
  });

  it("is left open when the text does not say, says both, or the sentence names someone else too", () => {
    expect(guessGender("花子は笑った。", ["花子"], [])).toBe(null);
    expect(guessGender("花子が来た。彼女は笑った。花子が去った。彼は黙った。", ["花子"], [])).toBe(null);
    expect(guessGender("花子と太郎が来た。彼女は笑った。", ["花子"], ["太郎"])).toBe(null);
  });

  it("is sent to the model as a note, and kept for known people", () => {
    const r = interpretPassage({ passage: "鈴木花子。彼女は笑った。", candidates: ["鈴木花子"], readings: { 鈴木花子: ["スズキ", "ハナコ"] }, glossary: [] });
    expect(r.names[0]!.gender).toBe("female");
    expect(notesFor(r)).toContain("Hanako Suzuki is a woman or girl (she/her).");
    const known = interpretPassage({ passage: "花子は笑った。", candidates: [], readings: {}, glossary: [{ source: "花子", english: "Hanako", kind: "character", aliases: [], narrator: false, gender: "female" }] });
    expect(known.names[0]!.gender).toBe("female");
  });
});
