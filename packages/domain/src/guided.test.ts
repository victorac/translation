import { describe, expect, it } from "vitest";
import { glossaryHits, occurrencesOf, guessGender, glossaryFor, withoutLongerNames, guessKind, interpretPassage, lastLines, notesFor, readingLetters, type KnownName } from "./guided.js";

const readings = { 鈴木花子: ["スズキ", "ハナコ"], 山田太郎: ["ヤマダ", "タロウ"], 山田家: ["ヤマダ", "カ"], 桜台学園: ["サクラダイ", "ガクエン"] };

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
    expect(by("鈴木花子")).toMatchObject({ english: "Suzuki Hanako", kind: "character", known: false });
    expect(by("山田家")).toMatchObject({ english: "Yamada family", kind: "family" });
    expect(by("桜台学園")).toMatchObject({ english: "", kind: "organization", reading: "sakuradai gakuen" });
  });

  it("uses what the glossary already says, and does not offer it as new", () => {
    const glossary: KnownName[] = [{ source: "山田太郎", english: "Yamada Taro", kind: "character", aliases: ["山田"] }];
    const r = interpretPassage({ passage: "ぼくは山田太郎という。", candidates: ["山田太郎"], readings, glossary, narrator: "山田太郎" });
    expect(r.names).toHaveLength(1);
    expect(r.names[0]).toMatchObject({ english: "Yamada Taro", known: true });
    expect(r.narrator).toBe("山田太郎");
    expect(r.narratorWord).toBe("ぼく");
  });

  it("has no narrator unless one carries on from the block before, and adds a given name written alone to the full name", () => {
    const r = interpretPassage({ passage: "ぼくは鈴木花子を見た。花子は笑った。", candidates: ["鈴木花子", "花子"], readings, glossary: [] });
    expect(r.narrator).toBe(null);
    expect(r.narratorWord).toBe("ぼく");
    expect(r.names.map((n) => n.source)).toEqual(["鈴木花子"]);
    expect(r.names[0]!.aliases).toEqual(["花子"]);
  });

  it("says who speaks each line, from the narration and from taking turns, with the narrator among the speakers", () => {
    const glossary: KnownName[] = [
      { source: "山田太郎", english: "Taro", kind: "character", aliases: ["山田"] },
      { source: "花子", english: "Hanako", kind: "character", aliases: [] },
    ];
    const passage = "「遅いですよ」と花子は言った。\n\n「ごめん」\n\n「いいえ」";
    const r = interpretPassage({ passage: `ぼくは待っていた。\n${passage}`, candidates: [], readings: {}, glossary, narrator: "山田太郎" });
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
      { source: "山田太郎", english: "Taro", kind: "character", aliases: [] },
      { source: "花子", english: "Hanako", kind: "character", aliases: [] },
    ],
    narrator: "山田太郎",
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
    expect(notesFor(r)).toContain("Suzuki Hanako is a woman or girl (she/her).");
    const known = interpretPassage({ passage: "花子は笑った。", candidates: [], readings: {}, glossary: [{ source: "花子", english: "Hanako", kind: "character", aliases: [], gender: "female" }] });
    expect(known.names[0]!.gender).toBe("female");
  });
});

describe("the narrator carries on, and can change", () => {
  const glossary: KnownName[] = [
    { source: "山田太郎", english: "Taro", kind: "character", aliases: [] },
    { source: "花子", english: "Hanako", kind: "character", aliases: [] },
  ];
  const text = "ぼくは花子を待った。\n「遅いですよ」と花子は言った。\n「ごめん」";

  it("is whoever told the block before, and is among the people of a block that does not write their name", () => {
    const r = interpretPassage({ passage: text, candidates: [], readings: {}, glossary, narrator: "山田太郎" });
    expect(r.narrator).toBe("山田太郎");
    expect(r.names.map((n) => n.source)).toContain("山田太郎");
  });

  it("is another person when the block before was told by someone else", () => {
    const r = interpretPassage({ passage: text, candidates: [], readings: {}, glossary, narrator: "花子" });
    expect(r.narrator).toBe("花子");
    expect(notesFor(r)[0]).toBe("The narrator, who says ぼく about himself or herself, is Hanako.");
  });
});

describe("a conversation that carries on into the next block", () => {
  const glossary: KnownName[] = [
    { source: "山田太郎", english: "Taro", kind: "character", aliases: [] },
    { source: "花子", english: "Hanako", kind: "character", aliases: [] },
  ];

  it("labels the first line of a block with the other speaker, and the rest in turns, though neither is named in the block", () => {
    const r = interpretPassage({ passage: "「そうですか」\n\n「うん」\n\n「では」", candidates: [], readings: {}, glossary, carry: { before: "山田太郎", other: "花子" } });
    expect(r.lines.map((l) => l.speaker)).toEqual(["花子", "山田太郎", "花子"]);
    expect(r.names.map((n) => n.source).sort()).toEqual(["花子", "山田太郎"].sort());
  });

  it("leaves the lines alone when the other one of the conversation is not known", () => {
    const r = interpretPassage({ passage: "「そうですか」\n\n「うん」", candidates: [], readings: {}, glossary, carry: { before: "山田太郎", other: null } });
    expect(r.lines.map((l) => l.speaker)).toEqual([null, null]);
  });
});

describe("a short name that is part of a longer one", () => {
  const taro = { source: "山田太郎", english: "Yamada Taro", kind: "character" as const, aliases: ["山田"], reading: "", known: true };
  const tono = { source: "山田", english: "Yamada", kind: "term" as const, aliases: [], reading: "", known: true, hint: "Hanako's name for Taro" };
  const interp = (names: typeof taro[]) => ({ names, narrator: null, narratorWord: null, lines: [] }) as never;

  it("is found only where it stands on its own", () => {
    expect(withoutLongerNames("山田太郎という。", "山田", ["山田太郎", "山田"])).not.toContain("山田");
    expect(withoutLongerNames("「山田、おはよう」山田太郎", "山田", ["山田太郎", "山田"])).toContain("山田");
  });

  it("is not listed for a block where it is only part of the full name, and is listed with a note when it stands alone", () => {
    const only = (text: string) => interpretPassage({ passage: text, candidates: [], readings: {}, glossary: [taro, tono] }).names.map((n) => n.source);
    expect(only("山田太郎という。")).toEqual(["山田太郎"]);
    expect(only("「山田、お待たせ」山田太郎は笑った。").sort()).toEqual(["山田", "山田太郎"].sort());
  });

  it("is sent as its own entry, with a note about when it applies, and the full name no longer lists it as another way to write it", () => {
    const names = [taro, tono] as never;
    const both = glossaryFor(interp(names), "「山田、お待たせ」山田太郎は笑った。");
    expect(both).toEqual([
      { source: "山田太郎", target: "Yamada Taro" },
      { source: "山田", target: "Yamada", note: "Hanako's name for Taro; when it stands on its own, not as part of 山田太郎" },
    ]);
    // In a piece where it is only part of the full name, it is not sent at all, and the full name keeps it as an alias.
    expect(glossaryFor(interp(names), "山田太郎という。")).toEqual([{ source: "山田太郎", target: "Yamada Taro" }]);
    expect(glossaryFor(interp([taro] as never), "山田太郎という。")).toEqual([{ source: "山田太郎", target: "Yamada Taro", aliases: ["山田"] }]);
  });
});

describe("a name that stands for a person", () => {
  const names = [
    { source: "山田太郎", english: "Yamada Taro", kind: "character" as const, aliases: ["山田"], reading: "", known: true },
    { source: "山田", english: "Yamada", kind: "term" as const, aliases: [], reading: "", known: true, refersTo: "山田太郎" },
  ];

  it("tells the model whom it stands for", () => {
    const sent = glossaryFor({ names, narrator: null, narratorWord: null, lines: [] } as never, "「山田、お待たせ」山田太郎");
    expect(sent.find((g) => g.source === "山田")).toEqual({ source: "山田", target: "Yamada", note: "a name for Yamada Taro; when it stands on its own, not as part of 山田太郎" });
  });

  it("is seen as the person for who speaks and who is spoken to", () => {
    const glossary: KnownName[] = [
      { source: "山田太郎", english: "Taro", kind: "character", aliases: ["山田"] },
      { source: "花子", english: "Hanako", kind: "character", aliases: [] },
      { source: "山田", english: "Yamada", kind: "term", aliases: [] },
    ];
    const r = interpretPassage({ passage: "花子は笑った。\n「山田、お待たせ」\n「遅いぞ」", candidates: [], readings: {}, glossary });
    // 山田 is spoken to, so the line is not his: it is Hanako's, and the reply is his.
    expect(r.lines.map((l) => l.speaker)).toEqual(["花子", "山田太郎"]);
  });
});

describe("where a glossary word stands in a text", () => {
  const sources = ["山田太郎", "山", "鈴木花子"];

  it("finds each place, in order, with the positions of the text itself", () => {
    const text = "山田太郎は山を見た。山は高い。";
    expect(occurrencesOf(text, ["山"], sources)).toEqual([{ start: 5, end: 6 }, { start: 10, end: 11 }]); // not the 山 inside 山田太郎
    expect(occurrencesOf(text, ["山田太郎"], sources)).toEqual([{ start: 0, end: 4 }]);
  });

  it("takes several ways of writing a name together, without overlaps", () => {
    const text = "太郎は鈴木花子。花子は笑った。";
    expect(occurrencesOf(text, ["鈴木花子", "花子"], ["鈴木花子", "花子"]).map((r) => text.slice(r.start, r.end))).toEqual(["鈴木花子", "花子"]);
    expect(occurrencesOf(text, ["鈴木花子", "花子"], sources).map((r) => r.start)).toEqual([3, 8]);
  });

  it("lists the glossary words that stand in the block", () => {
    const glossary = [{ source: "山田太郎", aliases: [] as string[] }, { source: "山", aliases: [] as string[] }, { source: "川", aliases: ["河"] }, { source: "鈴木花子", aliases: [] as string[] }];
    expect(glossaryHits("山田太郎が来た。", glossary).map((e) => e.source)).toEqual(["山田太郎"]);
    expect(glossaryHits("山田太郎は山を見た。河が流れる。", glossary).map((e) => e.source)).toEqual(["山田太郎", "山", "川"]);
    expect(glossaryHits("何もない。", glossary)).toEqual([]);
  });
});
