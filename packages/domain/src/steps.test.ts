import {
  describe,
  expect,
  it,
} from "vitest";
import {
  nameFromReadings,
  romanize,
  addressedIn,
  findQuotes,
  speakerByForm,
  takeTurns,
  mergeCandidates,
  patternCandidates,
  properNounRuns,
  related,
  splitSentences,
  standsAlone,
  type WordToken,
} from "./steps.js";

describe("sentences", () => {
  it("splits at the end of a sentence, keeping closing quotes, and at line breaks", () => {
    const s = splitSentences("彼は言った。「そうだね。」\n\n花子は笑った！ええ？");
    expect(s.map((x) => x.text)).toEqual(["彼は言った。", "「そうだね。」", "花子は笑った！", "ええ？"]);
    const text = "彼は言った。「そうだね。」";
    for (const x of splitSentences(text)) expect(text.slice(x.start, x.end)).toBe(x.text);
    expect(splitSentences("")).toEqual([]);
  });

  });

describe("candidate names", () => {
  const tok = (surface: string, d: string[], start: number): WordToken => ({ surface, details: d, byteStart: start, byteEnd: start + surface.length * 3 });

  it("joins neighbouring proper nouns and a following suffix, but not an honorific", () => {
    const tokens = [
      tok("山田", ["名詞", "固有名詞", "地域", "一般"], 0),
      tok("太郎", ["名詞", "固有名詞", "地域", "一般"], 6),
      tok("という", ["助詞", "格助詞"], 12),
      tok("山田", ["名詞", "固有名詞", "地域", "一般"], 18),
      tok("家", ["名詞", "接尾", "一般", "*"], 24),
      tok("の", ["助詞"], 27),
      tok("田中", ["名詞", "固有名詞", "人名", "姓"], 30),
      tok("くん", ["名詞", "接尾", "人名", "*"], 36),
    ];
    expect(properNounRuns(tokens)).toEqual(["山田太郎", "山田家", "田中"]);
  });

  it("finds names by how they are written: before an honorific, or ending like a school or family", () => {
    expect(patternCandidates("田中くんが来た。桜台学園に通う。佐藤家の人。")).toEqual(expect.arrayContaining(["田中", "桜台学園", "佐藤家"]));
  });

  it("keeps only what can be a name and is really in the text, in order of appearance", () => {
    const text = "花子は学園に行った。彼は笑った。";
    expect(mergeCandidates(text, ["学園", "彼", "花子", "ひらがな", "幽霊", "花子", "「花子」"], ["x"])).toEqual(["花子", "学園"]);
    // 桜台 only appears inside 桜台学園, so it is not a candidate of its own; 花子 also appears by itself, so it is.
    expect(mergeCandidates("桜台学園の花子。佐藤花子が来た。", ["桜台学園", "桜台", "佐藤花子", "花子"])).toEqual(["桜台学園", "花子", "佐藤花子"]);
  });

  it("does not take a piece of a longer word for a name (ボブ in ボブカット is a haircut)", () => {
    const text = "花子はボブカットで、花子様と山田家を訪ねた。ボブは来なかった。";
    expect(standsAlone(text, "ボブ")).toBe(true); // it also stands alone in the last sentence
    expect(standsAlone("彼女はボブカットだ。", "ボブ")).toBe(false);
    expect(mergeCandidates("彼女はボブカットだ。花子は笑った。", ["ボブ", "花子"])).toEqual(["花子"]);
    expect(mergeCandidates(text, ["花子", "山田"])).toEqual(["花子", "山田"]); // an honorific or 家 after a name is fine
    expect(standsAlone("佐藤花子が来た。", "花子")).toBe(false);
    expect(standsAlone("佐藤花子が来た。花子は笑った。", "花子")).toBe(true);
  });

  it("sees when two written forms may be the same thing", () => {
    expect(related("花子", "佐藤花子")).toBe(true);
    expect(related("花子", "花子")).toBe(true);
    expect(related("魔王", "勇者")).toBe(false);
    expect(related("山田太郎", "山田家")).toBe(true);
  });
});

describe("speakers of quotations", () => {
  const hanako = { id: "k", label: "Hanako", names: ["花子", "山田"] };
  const taro = { id: "w", label: "Taro", names: ["山田太郎", "ぼく"] };
  const people = [hanako, taro];
  const pick = (passage: string, n: number) => {
    const quotes = findQuotes(passage);
    return speakerByForm(passage, quotes[n]!, people, quotes);
  };

  it("does not count a word in quotation marks that is only being named or called", () => {
    expect(findQuotes("ぼくを「山田」と呼んで「おはよう」と言った。").map((q) => q.text)).toEqual(["「おはよう」"]);
  });

  it("finds the quotations in order", () => {
    expect(findQuotes("a「一」b「二」").map((q) => q.text)).toEqual(["「一」", "「二」"]);
  });

  it("reads the speaker off the narration beside a quotation, after it first and then before it", () => {
    expect(pick("「遅いですよ」と花子は言った。", 0)).toBe("k");
    expect(pick("ぼくは頭をかいて「ごめん」と言った。", 0)).toBe("w");
    expect(pick("花子は笑った。\n「そうですか」", 0)).toBe(null); // the sentence before it is another one
  });

  it("leaves it to the model when nobody or two people are named beside the line", () => {
    expect(pick("「遅いですよ」\n「ごめん」", 1)).toBe(null);
    expect(pick("「うん」花子は、ぼくは見た。", 0)).toBe(null);
  });

  it("knows who is spoken to inside a line, who then is not the speaker", () => {
    expect(addressedIn("「ああ、山田」", people)).toEqual(new Set(["k"]));
    expect(addressedIn("「花子は来たよ」", people)).toEqual(new Set());
  });

  });

describe("taking turns", () => {
  const hanako = { id: "k", label: "Hanako", names: ["花子"] };
  const taro = { id: "w", label: "Taro", names: ["山田太郎", "山田"] };
  const run = (passage: string, who: (string | null)[]) => takeTurns(passage, findQuotes(passage), who, [hanako, taro]);

  it("fills in the lines between and around a known one, in turns, whatever narration lies between", () => {
    const p = "「一」\n\n「二」\n\n歩いた。\n\n「三」\n\n「四」";
    expect(run(p, [null, "w", null, null])).toEqual(["k", "w", "k", "w"]);
  });

  it("does not guess for lines inside a paragraph, for more than two people, or when it would name the one spoken to", () => {
    expect(run("彼は「一」と言い、「二」と続けた。", [null, "w"])).toEqual([null, "w"]);
    const p = "「一」\n「二」";
    expect(takeTurns(p, findQuotes(p), ["w", null], [hanako, taro, { id: "x", label: "X", names: [] }])).toEqual(["w", null]);
    expect(run("「一」\n「ああ、山田」", ["k", null])).toEqual(["k", null]); // the line speaks to 山田, so it is not given to Taro
  });
});

describe("names from readings", () => {
  it("turns katakana into plain romaji, long vowels and small kana included", () => {
    expect(romanize("ハナコ")).toBe("hanako");
    expect(romanize("ハナコ")).toBe("hanako");
    expect(romanize("ミヅキ")).toBe("mizuki");
    expect(romanize("ヤマダ")).toBe("yamada");
    expect(romanize("ショウタ")).toBe("shota");
    expect(romanize("ニッポン")).toBe("nippon");
    expect(romanize("チャ")).toBe("cha");
    expect(romanize("abc")).toBe(null);
  });

  it("makes a person's name from the readings of its words, and a family's with the 家 left off", () => {
    expect(nameFromReadings(["ヤマダ", "タロウ"], false)).toBe("Yamada Taro");
    expect(nameFromReadings(["ヤマダ", "カ"], true)).toBe("Yamada family");
    expect(nameFromReadings(["ヤマダ", "x"], false)).toBe(null);
  });

  });

describe("surname and given name", () => {
  const tok = (surface: string, d: string[], start: number) => ({ surface, details: d, byteStart: start, byteEnd: start + surface.length * 3 });
  it("joins a surname and a plain word of one or two kanji that closes the phrase into a full name", () => {
    const tokens = [tok("鈴木", ["名詞", "固有名詞", "地域"], 0), tok("花子", ["名詞", "一般"], 6), tok("。", ["記号", "句点"], 12)];
    expect(properNounRuns(tokens)).toEqual(["鈴木花子"]);
  });

  it("does not join when another noun follows, or when the word is not next to the surname", () => {
    expect(properNounRuns([tok("鈴木", ["名詞", "固有名詞", "地域"], 0), tok("花子", ["名詞", "一般"], 6), tok("先生", ["名詞", "一般"], 12)])).toEqual(["鈴木"]);
    expect(properNounRuns([tok("鈴木", ["名詞", "固有名詞", "地域"], 0), tok("花子", ["名詞", "一般"], 9), tok("は", ["助詞"], 15)])).toEqual(["鈴木"]);
  });
});

describe("turns carried from the block before", () => {
  const hanako = { id: "k", label: "Hanako", names: ["花子"] };
  const taro = { id: "w", label: "Taro", names: ["山田太郎"] };
  const run = (passage: string, who: (string | null)[], carry: { before: string; pair: readonly [string, string] } | null) => takeTurns(passage, findQuotes(passage), who, [hanako, taro], carry);

  it("gives the first line to the other one, and goes on in turns from there", () => {
    const p = "「一」\n\n「二」\n\n「三」";
    expect(run(p, [null, null, null], { before: "k", pair: ["k", "w"] })).toEqual(["w", "k", "w"]);
  });

  it("works when the block names only one of the two, or neither", () => {
    const p = "「一」\n「二」";
    expect(takeTurns(p, findQuotes(p), [null, null], [hanako], { before: "k", pair: ["k", "w"] })).toEqual(["w", "k"]);
    expect(takeTurns(p, findQuotes(p), [null, null], [], { before: "k", pair: ["k", "w"] })).toEqual(["w", "k"]);
  });

  it("does not take the first line when it is not a paragraph of its own, or when it speaks to the one who would say it", () => {
    expect(run("彼は「一」と言い、「二」と続けた。", [null, null], { before: "k", pair: ["k", "w"] })).toEqual([null, null]);
    expect(run("「ああ、山田太郎」", [null], { before: "k", pair: ["k", "w"] })).toEqual([null]);
  });

  it("is not used when nothing is carried and there are not exactly two people", () => {
    expect(takeTurns("「一」\n「二」", findQuotes("「一」\n「二」"), [null, null], [hanako], null)).toEqual([null, null]);
  });
});

describe("names that write themselves in other ways", () => {
  const text = "その日、ジョン・スミスは旅団『銀の剣』に入った。『魔力石』を拾った。ポーションを飲んだ。ポーションは苦い。ジョンは笑った。";

  it("finds a katakana name with a middle dot, a word set in 『…』, and a katakana word that comes back", () => {
    const found = mergeCandidates(text, patternCandidates(text));
    expect(found).toEqual(expect.arrayContaining(["ジョン・スミス", "銀の剣", "魔力石", "ポーション"]));
  });

  it("does not take a katakana word that is said only once", () => {
    expect(patternCandidates("ポーションを飲んだ。")).toEqual([]);
  });
});
