import { describe, expect, it } from "vitest";
import { chosenOption, choiceQuestion, copiedWords, nameQuestion, pronounGender, speakerQuestion } from "./suggest.js";

describe("the name of a word in the translation", () => {
  const pairs = [{ source: "山田太郎は笑った。", translation: "Taro Yamada laughed." }];
  it("asks for words copied from the translation", () => {
    const q = nameQuestion("山田太郎", pairs, "Japanese", "English");
    expect(q.user).toContain("JAPANESE: 山田太郎は笑った。\nENGLISH: Taro Yamada laughed.");
    expect(q.user).toContain("Which words of the ENGLISH text stand for 「山田太郎」?");
  });
  it("accepts only what is written in the translation, as it is written there", () => {
    const texts = ["Taro Yamada laughed."];
    expect(copiedWords("Taro Yamada", texts)).toBe("Taro Yamada");
    expect(copiedWords('"taro yamada".', texts)).toBe("Taro Yamada"); // quotes and case are not part of it
    expect(copiedWords("Yamada Taro", texts)).toBeNull(); // not in the text
    expect(copiedWords("NONE", texts)).toBeNull();
    expect(copiedWords("", texts)).toBeNull();
    expect(copiedWords("Taro Yamada laughed and then went on to say something else", ["Taro Yamada laughed and then went on to say something else"])).toBeNull(); // a sentence, not a name
  });
});

describe("a choice from a list", () => {
  it("lists the options by letter, with not stated last", () => {
    const q = choiceQuestion("What is the gender of 「花子」?", ["male", "female"], [{ source: "花子。", translation: "Hanako." }], "Japanese", "English");
    expect(q.user).toContain("A) male\nB) female\nC) not stated\n\nReply with the letter only.");
  });
  it("takes the letter of an option, and nothing else", () => {
    const options = ["male", "female"];
    expect(chosenOption("B", options)).toBe(1);
    expect(chosenOption(" b) female", options)).toBe(1);
    expect(chosenOption("C", options)).toBeNull(); // not stated
    expect(chosenOption("Z", options)).toBeNull();
    expect(chosenOption("Female", options)).toBeNull(); // not a letter of the list
    expect(chosenOption("", options)).toBeNull();
  });
});

describe("pronouns", () => {
  it("say a gender only when they are all one way", () => {
    expect(pronounGender(["She laughed. Her friend came."])).toBe("female");
    expect(pronounGender(["He said so to him."])).toBe("male");
    expect(pronounGender(["She told him."])).toBeNull();
    expect(pronounGender(["Taro laughed."])).toBeNull();
  });
});

describe("who says a line", () => {
  it("shows the translation and the line, and lists the people", () => {
    const q = speakerQuestion("「おはよう」", ["Hanako", "Taro"], ["Hanako smiled.", '"Good morning."'], "Japanese", "English");
    expect(q.user).toContain('ENGLISH TEXT:\nHanako smiled.\n\n"Good morning."');
    expect(q.user).toContain("The Japanese line 「おはよう」 is in that text. Who says it?");
    expect(q.user).toContain("A) Hanako\nB) Taro\nC) not stated");
  });
});
