import { describe, expect, it } from "vitest";
import {
  addressedIn,
  findQuotes,
  speakerByForm,
  takeTurns,
  speakerQuestion,
  attribute,
  plausibleName,
  roleByForm,
  classify,
  mergeCandidates,
  parseChoice,
  parseChoiceWithQuote,
  parseNameList,
  parseShortText,
  patternCandidates,
  properNounRuns,
  quoteInPassage,
  related,
  sameAs,
  splitSentences,
  standsAlone,
  windowAround,
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

  it("takes the sentences around a name, with the one before", () => {
    const s = splitSentences("朝だった。花子が来た。彼は笑った。夜になった。");
    expect(windowAround(s, ["花子"])).toBe("朝だった。\n花子が来た。");
    expect(windowAround(s, ["誰か"])).toBe("朝だった。\n花子が来た。\n彼は笑った。\n夜になった。");
  });
});

describe("candidate names", () => {
  const tok = (surface: string, d: string[], start: number): WordToken => ({ surface, details: d, byteStart: start, byteEnd: start + surface.length * 3 });

  it("joins neighbouring proper nouns and a following suffix, but not an honorific", () => {
    const tokens = [
      tok("山田", ["名詞", "固有名詞", "地域", "一般"], 0),
      tok("亘", ["名詞", "固有名詞", "地域", "一般"], 6),
      tok("という", ["助詞", "格助詞"], 9),
      tok("山田", ["名詞", "固有名詞", "地域", "一般"], 15),
      tok("家", ["名詞", "接尾", "一般", "*"], 21),
      tok("の", ["助詞"], 24),
      tok("田中", ["名詞", "固有名詞", "人名", "姓"], 27),
      tok("くん", ["名詞", "接尾", "人名", "*"], 33),
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

describe("questions and answers", () => {
  it("lists the options with letters and asks for one letter", () => {
    const q = classify("花子", "花子は笑った。", ["a person", "a place", "not a name"]);
    expect(q.user).toContain("A) a person\nB) a place\nC) not a name");
    expect(q.user).toContain("Reply with the letter only");
    expect(q.options).toHaveLength(3);
    expect(sameAs("花子", "ctx", [{ label: "佐藤花子" }]).options).toEqual(["佐藤花子", "None of them: it is a new one"]);
  });

  it("asks for a quote when the answer is a fact, and a way out when it is not stated", () => {
    const q = attribute("花子", "gender", ["male", "female"], "ctx");
    expect(q.options).toEqual(["male", "female", "Not stated in the passage"]);
    expect(q.user).toContain("a short quote");
  });

  it("reads which option was chosen from whatever the model wrote", () => {
    for (const reply of ["B", "b", "B)", " (B) ", "B.", "2", "B | the quote", "B, because"]) expect(parseChoice(reply, 3), reply).toBe(1);
    for (const reply of ["", "Maybe", "Z", "9", "The answer is B"]) expect(parseChoice(reply, 3), reply).toBeNull();
    expect(parseChoice("D", 3)).toBeNull();
  });

  it("reads a choice with its quote, and checks the quote against the passage", () => {
    expect(parseChoiceWithQuote("B | 彼女は笑った", 3)).toEqual({ index: 1, quote: "彼女は笑った" });
    expect(parseChoiceWithQuote("A", 3)).toEqual({ index: 0, quote: "" });
    expect(quoteInPassage("彼女は\n笑った。", "「彼女は笑った」")).toBe(true);
    expect(quoteInPassage("彼女は笑った。", "彼は怒った")).toBe(false);
    expect(quoteInPassage("彼女は笑った。", "")).toBe(false);
  });

  it("reads lists and short answers", () => {
    expect(parseNameList("- 花子\n2. 太郎\nNONE\n\n学園")).toEqual(["花子", "太郎", "学園"]);
    expect(parseNameList("NONE")).toEqual([]);
    expect(parseShortText('  "Hanako"\nextra', 60)).toBe("Hanako");
    expect(parseShortText("Name: Taro", 60)).toBe("Taro");
    expect(parseShortText("Taro Yamada.", 60, true)).toBe("Taro Yamada");
    expect(parseShortText("She waits at the gate.", 60)).toBe("She waits at the gate.");
    expect(parseShortText("UNKNOWN", 60)).toBeNull();
    expect(parseShortText("x".repeat(80), 60)).toBeNull();
    expect(parseShortText("", 60)).toBeNull();
  });
});

describe("names and roles that can be judged without a model", () => {
  it("accepts a short plain name and refuses an explanation, a list or a sentence", () => {
    expect(plausibleName("Hanako", "Hanako")).toBe(true);
    expect(plausibleName("the Sato family", "the Sato family")).toBe(true);
    expect(plausibleName("Sakurata Academy students, same class.\nHana's family runs a shop", "Sakurata Academy students, same class")).toBe(false);
    expect(plausibleName("Hanako is a girl who waits", "Hanako is a girl who waits")).toBe(false);
    expect(plausibleName("A, B", "A, B")).toBe(false);
  });

  it("settles what a person does from how the name is written", () => {
    const s = splitSentences("学園の門の前で、花子は腕を組んで待っていた。「遅かったね、太郎」と彼女は言った。花子の家は古い。佐藤花子がいた。");
    expect(roleByForm(s, ["花子"])).toBe(0); // 花子は: the subject
    expect(roleByForm(s, ["太郎"])).toBe(1); // inside a quotation, just before 」: spoken to
    expect(roleByForm(splitSentences("花子の家は古い。"), ["花子"])).toBeNull(); // only a possessive: leave it to the model
    expect(roleByForm(splitSentences("「花子様、お待たせしました」"), ["花子"])).toBe(1);
    expect(roleByForm(s, ["花子"])).toBeNull(); // 花子 is only part of 佐藤花子
    expect(roleByForm(s, ["誰か"])).toBeNull();
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

  it("asks who says a marked line, with the people and a way out", () => {
    const q = speakerQuestion("「ああ」", ["Hanako", "Taro"], "text");
    expect(q.options).toEqual(["Hanako", "Taro", "It cannot be told"]);
    expect(q.user).toContain("「ああ」");
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
