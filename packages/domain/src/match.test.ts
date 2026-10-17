import {
  describe,
  expect,
  it,
} from "vitest";
import {
  marked,
  nearestWords,
  readAnswer,
  matchQuestion,
  matchedSpan,
  tooMuch,
} from "./match.js";

const source = "「ノア、お前は今日でクビだ」とセラは言った。";
const translation = "\u201cNoah, you're fired as of today,\u201d Sera said.";

describe("matching a selection to the other text", () => {
  it("marks the selection where it stands, not where the same words are first written", () => {
    expect(marked("灯は灯を見た", "灯", 2)).toBe("灯は⟦灯⟧を見た");
    expect(marked("灯は灯を見た", "灯", 5)).toBe("⟦灯⟧は灯を見た");
    expect(marked("灯は灯を見た", "月", 0)).toBe("灯は灯を見た");
  });

  it("asks for the marked part alone in the other language, then the words of the other text that say it, both ways", () => {
    const fromSource = matchQuestion({ side: "source", selected: "クビだ", at: 10, source, translation, from: "Japanese", to: "English" });
    expect(fromSource.user).toContain("JAPANESE TEXT (the part to match is marked ⟦ ⟧):\n「ノア、お前は今日で⟦クビだ⟧」とセラは言った。");
    expect(fromSource.user).toContain(`ENGLISH TEXT:\n${translation}`);
    expect(fromSource.user).toContain("Reply in two lines:\nMEANING: only the marked part ⟦クビだ⟧, said in English, in as few words as it has\nPART: the words of the ENGLISH text that say the same as MEANING, copied exactly (or NONE)");
    const fromTranslation = matchQuestion({ side: "translation", selected: "fired", at: 14, source, translation, from: "Japanese", to: "English" });
    expect(fromTranslation.user).toContain("ENGLISH TEXT (the part to match is marked ⟦ ⟧):\n\u201cNoah, you're ⟦fired⟧ as of today");
    expect(fromTranslation.user).toContain("MEANING: only the marked part ⟦fired⟧, said in Japanese");
    expect(fromTranslation.user).toContain("PART: the words of the JAPANESE text");
  });

  it("reads the two lines of a reply leniently", () => {
    expect(readAnswer("MEANING: need\nPART: need such an old map?")).toEqual({ meaning: "need", part: "need such an old map?" });
    expect(readAnswer("意味: 一つ\nパート: 一つ聞きたい")).toEqual({ meaning: "一つ", part: "一つ聞きたい" });
    expect(readAnswer("NEED\n\nWhy do you suddenly need such an old map?")).toEqual({ meaning: "NEED", part: "" });
    // The instruction given back is no meaning.
    expect(readAnswer("MEANING: only the marked part ⟦Casting⟧, said in Japanese\nPART: 唱えながら")).toEqual({ meaning: "", part: "唱えながら" });
  });

  it("takes the meaning where the text writes it, a short part, or else the words nearest the meaning", () => {
    const ren = "\"Why do you suddenly need such an old map?\"";
    // The part copied is a whole clause; the meaning is the word.
    expect(matchedSpan("MEANING: need\nPART: Why do you suddenly need such an old map?", ren)).toEqual({ start: 21, end: 25 });
    // "needed" is not written, but "need" is.
    expect(matchedSpan("MEANING: needed\nPART: NONE", ren)).toEqual({ start: 21, end: 25 });
    expect(matchedSpan("MEANING: an old map\nPART: such an old map", ren)).toEqual({ start: 31, end: 41 });
    expect(nearestWords("took his glasses off", "Ren took off his glasses.")).toEqual({ start: 4, end: 24 });
    expect(nearestWords("眼鏡", "蓮は眼鏡を外した。")).toEqual({ start: 2, end: 4 });
    expect(nearestWords("眼鏡をかけた", "蓮は眼鏡を外した。")).toEqual({ start: 2, end: 5 });
  });

  it("finds the part where the other text writes it, in any case and without quotation marks or marks", () => {
    expect(matchedSpan("MEANING: dismissed\nPART: you're fired", translation)).toEqual({ start: 7, end: 19 });
    expect(matchedSpan('"Fired."', translation)).toEqual({ start: 14, end: 19 });
    expect(matchedSpan("「クビだ」", source)).toEqual({ start: 10, end: 13 });
    expect(matchedSpan("⟦クビだ⟧", source)).toEqual({ start: 10, end: 13 });
    expect(matchedSpan("クビ (kubi)", source)).toEqual({ start: 10, end: 12 });
  });

  it("takes the place nearest to where the selection stands", () => {
    const text = "Noah ran. Then Noah fell.";
    expect(matchedSpan("Noah", text, 0)).toEqual({ start: 0, end: 4 });
    expect(matchedSpan("Noah", text, 0.9)).toEqual({ start: 15, end: 19 });
  });

  it("takes nearly the whole other paragraph for a few words as no answer", () => {
    expect(tooMuch({ start: 0, end: 38 }, 40, 3, 20)).toBe(true);
    expect(tooMuch({ start: 0, end: 38 }, 40, 15, 20)).toBe(false);
    expect(tooMuch({ start: 0, end: 10 }, 40, 3, 20)).toBe(false);
  });

  it("finds nothing for NONE, an empty reply, or words the text does not have", () => {
    expect(matchedSpan("MEANING: dismissed\nPART: NONE", translation)).toBeNull();
    expect(matchedSpan("NONE", translation)).toBeNull();
    expect(matchedSpan("  \n", translation)).toBeNull();
    expect(matchedSpan("dismissed", translation)).toBeNull();
  });
});
