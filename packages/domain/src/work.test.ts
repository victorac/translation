import {
  describe,
  expect,
  it,
} from "vitest";
import {
  glossaryFor,
  glossaryHits,
  guessGender,
  guessKind,
  labelDocument,
  noteAt,
  notesFor,
  occurrencesOf,
  readWords,
  readingLetters,
  suggestionsFor,
  syncParagraphs,
  withoutLongerNames,
  type KnownWord,
  type Word,
} from "./work.js";

const readings = { 鈴木花子: ["スズキ", "ハナコ"], 山田太郎: ["ヤマダ", "タロウ"], 山田家: ["ヤマダ", "カ"], 桜台学園: ["サクラダイ", "ガクエン"] };
const read = (text: string, glossary: KnownWord[] = [], candidates: string[] = []) => readWords({ text, candidates, readings, glossary });
const word = (source: string, english: string, over: Partial<Word> = {}): Word => ({ source, english, kind: "character", aliases: [], reading: "", known: true, ...over });

describe("reading the text for words", () => {
  it("guesses what kind of name it is from how it ends", () => {
    expect(guessKind("山田家")).toBe("family");
    expect(guessKind("桜台学園")).toBe("organization");
    expect(guessKind("桜台駅")).toBe("place");
    expect(guessKind("鈴木花子")).toBe("character");
  });

  it("suggests English names of people and families from the readings, and leaves other kinds for the user with the reading as help", () => {
    const words = read("鈴木花子は山田家の桜台学園に通う。", [], ["鈴木花子", "山田家", "桜台学園"]);
    const by = (s: string) => words.find((n) => n.source === s)!;
    // What the dictionary reads is a suggestion, not the name.
    expect(by("鈴木花子")).toMatchObject({ english: "", suggestions: { english: ["Suzuki Hanako"] }, kind: "character", known: false });
    expect(by("山田家")).toMatchObject({ english: "", suggestions: { english: ["Yamada family"] }, kind: "family" });
    expect(by("桜台学園")).toMatchObject({ english: "", kind: "organization", reading: "sakuradai gakuen" });
    expect(by("桜台学園").suggestions).toBeUndefined();
  });

  it("uses what the glossary already says, and does not offer it as new", () => {
    const words = read("ぼくは山田太郎という。", [{ source: "山田太郎", english: "Yamada Taro", kind: "character", aliases: ["山田"] }], ["山田太郎"]);
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ english: "Yamada Taro", known: true });
  });

  it("keeps what the user set on a draft word when the text is read again", () => {
    const draft: KnownWord = { source: "桜台学園", english: "Sakuradai Academy", kind: "organization", aliases: [], draft: true, hint: "a school", use: false, suggestions: { gender: ["female"] } };
    expect(read("桜台学園に通う。", [draft])[0]).toMatchObject({ english: "Sakuradai Academy", draft: true, hint: "a school", use: false, suggestions: { gender: ["female"] } });
  });

  it("adds a given name written alone to the full name", () => {
    const words = read("ぼくは鈴木花子を見た。花子は笑った。", [], ["鈴木花子", "花子"]);
    expect(words.map((n) => n.source)).toEqual(["鈴木花子"]);
    expect(words[0]!.aliases).toEqual(["花子"]);
  });

  it("keeps the whole name of a name from another language, with its parts alone as other ways to write it", () => {
    const text = "その日、ジョン・スミスは旅団『銀の剣』に入った。ジョンは『魔力石』を拾った。ポーションを飲んだ。ポーションは苦い。";
    const words = read(text, [], ["ジョン", "ジョン・スミス", "銀の剣", "魔力石", "ポーション"]);
    const by = (s: string) => words.find((n) => n.source === s)!;
    expect(words.some((n) => n.source === "ジョン")).toBe(false);
    // No guess for a name in katakana: the dictionary would only spell out the sounds.
    expect(by("ジョン・スミス")).toMatchObject({ kind: "character", english: "", aliases: ["ジョン"] });
    expect(by("ジョン・スミス").suggestions).toBeUndefined();
    expect(by("銀の剣").kind).toBe("organization"); // 旅団『…』
    expect(by("魔力石").kind).toBe("term");
    expect(by("ポーション")).toMatchObject({ kind: "term", english: "" }); // not guessed for a term
  });
});

describe("who says each line", () => {
  const people: Word[] = [word("山田太郎", "Taro", { aliases: ["山田"] }), word("花子", "Hanako")];

  it("is worked out from the narration and from taking turns", () => {
    const text = "「遅いですよ」と花子は言った。\n\n「ごめん」と山田太郎は言った。\n\n「いいえ」";
    const lines = labelDocument(text, people);
    // What the rules work out is only suggested.
    expect(lines.map((l) => l.speaker)).toEqual([null, null, null]);
    expect(lines.map((l) => l.suggested)).toEqual(["花子", "山田太郎", "花子"]);
    expect(lines.map((l) => l.paragraph)).toEqual([0, 1, 2]);
    expect(lines.map((l) => l.text)).toEqual(["「遅いですよ」", "「ごめん」", "「いいえ」"]);
  });

  it("leaves the lines unlabeled when fewer than two people are known", () => {
    expect(labelDocument("「やあ」\n「うん」", []).map((l) => l.suggested)).toEqual([null, null]);
  });

  it("keeps what the user set", () => {
    const lines = labelDocument("「遅いですよ」と花子は言った。\n\n「ごめん」と山田太郎は言った。", people, [null, "花子"]);
    expect(lines.map((l) => [l.speaker, l.suggested])).toEqual([[null, "花子"], ["花子", null]]);
  });

  it("carries a conversation on across a long text, so lines far from where the people are named are still labeled in turns", () => {
    const talk = Array.from({ length: 150 }, (_, i) => `「はい${i}」`).join("\n");
    const lines = labelDocument(`「遅いですよ」と花子は言った。\n「ごめん」と山田太郎は言った。\n${talk}`, people);
    expect(lines).toHaveLength(152);
    expect(lines.map((l) => l.suggested)).toEqual(lines.map((_, i) => (i % 2 === 0 ? "花子" : "山田太郎")));
  });

  it("sees a name that stands for a person as that person, for who speaks and who is spoken to", () => {
    const words: Word[] = [word("山田太郎", "Taro", { aliases: ["山田"] }), word("花子", "Hanako"), word("山田", "Yamada", { kind: "term" })];
    // 山田 is spoken to, so the line is not his: it is Hanako's, and the reply is his.
    expect(labelDocument("花子は笑った。\n「山田、お待たせ」\n「遅いぞ」", words).map((l) => l.suggested)).toEqual(["花子", "山田太郎"]);
  });
});

describe("what is sent with a paragraph", () => {
  const words: Word[] = [word("山田太郎", "Taro"), word("花子", "Hanako", { gender: "female" })];
  const text = "ぼくは待った。\n「遅いですよ」と花子は言った。\n「ごめん」と山田太郎は言った。";
  const lines = labelDocument(text, words, ["花子", null]);

  it("states who says the lines of the paragraph and the gender of the people it names, in the translation's names; what is only suggested as likely", () => {
    expect(notesFor(words, lines, { index: 1, text: "「遅いですよ」と花子は言った。" })).toEqual(["Hanako is a woman or girl (she/her).", "The line 「遅いですよ」 is said by Hanako."]);
    expect(notesFor(words, lines, { index: 0, text: "ぼくは待った。" })).toEqual([]);
    // A speaker that is only suggested is told as likely.
    expect(notesFor(words, lines, { index: 2, text: "「ごめん」と山田太郎は言った。" })).toEqual(["The line 「ごめん」 is probably said by Taro."]);
    // So is a gender only suggested; and a name only suggested is used, else the name as the text writes it.
    const suggested: Word[] = [word("山田太郎", "", { suggestions: { english: ["Taro Yamada"], gender: ["male"] } }), word("花子", "", { gender: "female" })];
    expect(notesFor(suggested, lines, { index: 2, text: "「ごめん」と山田太郎は言った。" })).toEqual(["Taro Yamada is probably a man or boy (he/him).", "The line 「ごめん」 is probably said by Taro Yamada."]);
    expect(notesFor(suggested, lines, { index: 1, text: "「遅いですよ」と花子は言った。" })).toEqual(["花子 is a woman or girl (she/her).", "The line 「遅いですよ」 is said by 花子."]);
  });

  it("sends only words that have an English form, or a note", () => {
    const withBlank = [...words, word("学園", " ", { kind: "organization" }), word("食べる", "", { kind: "term", hint: "use the past tense" })];
    expect(glossaryFor(withBlank).map((g) => g.source).sort()).toEqual(["山田太郎", "花子", "食べる"].sort());
  });

  it("does not send a word the user ignores", () => {
    expect(glossaryFor([word("花子", "Hanako", { use: false })])).toEqual([]);
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

  it("is suggested from the text, and kept for known people", () => {
    const words = read("鈴木花子。彼女は笑った。", [], ["鈴木花子"]);
    expect(words[0]!.gender).toBeNull();
    expect(words[0]!.suggestions?.["gender"]).toEqual(["female"]); // the text says so, but it is only a suggestion until it is confirmed
    expect(read("花子は笑った。", [{ source: "花子", english: "Hanako", kind: "character", aliases: [], gender: "female" }])[0]!.gender).toBe("female");
  });
});

describe("a short name that is part of a longer one", () => {
  const taro = word("山田太郎", "Yamada Taro", { aliases: ["山田"] });
  const tono = word("山田", "Yamada", { kind: "term", hint: "Hanako's name for Taro" });

  it("is found only where it stands on its own", () => {
    expect(withoutLongerNames("山田太郎という。", "山田", ["山田太郎", "山田"])).not.toContain("山田");
    expect(withoutLongerNames("「山田、おはよう」山田太郎", "山田", ["山田太郎", "山田"])).toContain("山田");
  });

  it("is listed only where it stands alone", () => {
    const only = (text: string) => read(text, [taro, tono]).map((n) => n.source);
    expect(only("山田太郎という。")).toEqual(["山田太郎"]);
    expect(only("「山田、お待たせ」山田太郎は笑った。").sort()).toEqual(["山田", "山田太郎"].sort());
  });

  it("is sent as its own entry where it stands on its own, and the full name no longer lists it as another way to write it", () => {
    const both = glossaryFor([taro, tono], "「山田、お待たせ」山田太郎は笑った。");
    expect(both).toEqual([
      { source: "山田太郎", target: "Yamada Taro" },
      { source: "山田", target: "Yamada", note: "Hanako's name for Taro", term: true },
    ]);
    // Where it is only part of the full name, it is not sent at all, and the full name keeps it as an alias.
    expect(glossaryFor([taro, tono], "山田太郎という。")).toEqual([{ source: "山田太郎", target: "Yamada Taro" }]);
    expect(glossaryFor([taro], "山田太郎という。")).toEqual([{ source: "山田太郎", target: "Yamada Taro", aliases: ["山田"] }]);
  });

  it("does not send a name whose short form is only part of another glossary word", () => {
    const akari = word("水瀬灯", "Akari Minase", { aliases: ["灯"] });
    const festival = word("灯籠祭", "Lantern Festival", { kind: "term" });
    expect(glossaryFor([akari, festival], "灯籠祭の夜だった。").map((g) => g.source)).toEqual(["灯籠祭"]);
    expect(glossaryFor([akari, festival], "灯籠祭の夜、灯は笑った。").map((g) => g.source).sort()).toEqual(["水瀬灯", "灯籠祭"].sort());
  });

  it("tells the model whom a name stands for", () => {
    const stands = word("山田", "Yamada", { kind: "term", refersTo: "山田太郎" });
    const sent = glossaryFor([taro, stands], "「山田、お待たせ」山田太郎");
    expect(sent.find((g) => g.source === "山田")).toEqual({ source: "山田", target: "Yamada", note: "a name for Yamada Taro" });
  });
});

describe("where a word stands in a text", () => {
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

  it("lists the glossary words that stand in a text", () => {
    const glossary = [{ source: "山田太郎", aliases: [] as string[] }, { source: "山", aliases: [] as string[] }, { source: "川", aliases: ["河"] }, { source: "鈴木花子", aliases: [] as string[] }];
    expect(glossaryHits("山田太郎が来た。", glossary).map((e) => e.source)).toEqual(["山田太郎"]);
    expect(glossaryHits("山田太郎は山を見た。河が流れる。", glossary).map((e) => e.source)).toEqual(["山田太郎", "山", "川"]);
    expect(glossaryHits("何もない。", glossary)).toEqual([]);
  });
});

describe("a note from a paragraph on", () => {
  const paragraphs = [{ text: "一。", translation: "", note: "Told by Noah, in the first person." }, { text: "二。", translation: "" }, { text: "三。", translation: "", note: "Third person, following Sera." }, { text: "四。", translation: "" }];

  it("is in effect until the next note", () => {
    expect([0, 1, 2, 3].map((k) => noteAt(paragraphs, k))).toEqual(["Told by Noah, in the first person.", "Told by Noah, in the first person.", "Third person, following Sera.", "Third person, following Sera."]);
    expect(noteAt([{ text: "一。", translation: "" }], 0)).toBeNull();
  });

  it("is sent first among the notes of a paragraph", () => {
    expect(notesFor([], [], { index: 3, text: "四。" }, paragraphs)).toEqual(["Third person, following Sera."]);
  });
});

describe("when the text changes", () => {
  it("keeps the translation of a paragraph whose text is the same, and starts the others again", () => {
    const old = [{ text: "一。", translation: "One." }, { text: "二。", translation: "Two." }, { text: "三。", translation: "Three." }];
    const next = syncParagraphs(old, "一。\n\n新しい。\n\n二。\n\n三。");
    expect(next.map((p) => p.translation)).toEqual(["One.", "", "Two.", "Three."]);
    expect(syncParagraphs(old, "三。\n二。").map((p) => p.translation)).toEqual(["Three.", ""]); // order is kept: Two. cannot come back after Three.
  });

  it("keeps a note with its paragraph, and where the paragraph's text changed, at the place it stands now", () => {
    const old = [{ text: "一。", translation: "One.", note: "Told by Noah." }, { text: "二。", translation: "Two." }, { text: "三。", translation: "Three.", note: "Sera's point of view." }];
    expect(syncParagraphs(old, "新しい。\n一。\n二。\n三。").map((p) => p.note)).toEqual([undefined, "Told by Noah.", undefined, "Sera's point of view."]);
    // 三 was edited: its note stays on the paragraph after 二.
    expect(syncParagraphs(old, "一。\n二。\n三が変わった。").map((p) => p.note)).toEqual(["Told by Noah.", undefined, "Sera's point of view."]);
  });

  it("matches repeated paragraphs in order", () => {
    const old = [{ text: "はい。", translation: "Yes (1)." }, { text: "はい。", translation: "Yes (2)." }];
    expect(syncParagraphs(old, "はい。\nはい。\nはい。").map((p) => p.translation)).toEqual(["Yes (1).", "Yes (2).", ""]);
  });

  it("reads the letters of a reading", () => {
    expect(readingLetters(["ヤマダ", "タロウ"])).toBe("yamada taro");
  });
});

describe("suggested names", () => {
  it("are listed for the words of a paragraph that have no name yet, and not for the ones that have one or are ignored", () => {
    const words: Word[] = [
      word("鈴木花子", "", { suggestions: { english: ["Suzuki Hanako"] }, aliases: ["花子"] }),
      word("魔王", "", { suggestions: { english: ["Maou"] }, fromReading: true }),
      word("山田太郎", "Taro", { suggestions: { english: ["Yamada Taro"] } }),
      word("桜台学園", "", { kind: "organization", suggestions: { english: ["Sakuradai"] }, use: false }),
    ];
    expect(suggestionsFor(words, "花子は桜台学園で山田太郎に会った。魔王が来た。")).toEqual([{ source: "魔王", suggestion: "Maou" }]); // only a dictionary reading is sent: what the model wrote before is not
    expect(suggestionsFor(words, "何もない。")).toEqual([]);
  });

  it("send a dictionary reading only for a name with kanji, since for katakana it only spells out sounds; a suggestion the user wrote is always sent", () => {
    const words: Word[] = [
      word("山田太郎", "", { suggestions: { english: ["Yamada Taro"] }, fromReading: true }),
      word("ジョン・スミス", "", { suggestions: { english: ["Jon Sumisu"] }, fromReading: true }),
      word("ジェーン・ドウ", "", { suggestions: { english: ["Jane Doe"] }, fromReading: true, written: true }),
    ];
    expect(suggestionsFor(words, "山田太郎とジョン・スミスとジェーン・ドウ。").map((s) => s.source)).toEqual(["山田太郎", "ジェーン・ドウ"]);
  });
});
