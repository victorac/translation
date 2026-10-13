import { describe, expect, it } from "vitest";
import {
  attribute,
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
