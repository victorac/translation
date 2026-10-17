import {
  describe,
  expect,
  it,
} from "vitest";
import {
  matchQuestion,
  matchedSpan,
  tooMuch,
} from "./match.js";

const source = "「ノア、お前は今日でクビだ」とセラは言った。";
const translation = "“Noah, you're fired as of today,” Sera said.";

describe("matching a selection to the other text", () => {
  it("asks for the words of the other text, both ways", () => {
    const fromSource = matchQuestion({ side: "source", selected: "クビだ", source, translation, from: "Japanese", to: "English" });
    expect(fromSource.user).toContain(`JAPANESE TEXT:\n${source}`);
    expect(fromSource.user).toContain("Which part of the ENGLISH text translates the JAPANESE 「クビだ」? Copy that part exactly from the ENGLISH text, no more of it than it takes, and reply with it only.");
    const fromTranslation = matchQuestion({ side: "translation", selected: "fired", source, translation, from: "Japanese", to: "English" });
    expect(fromTranslation.user).toContain('Which part of the JAPANESE text does the ENGLISH word "fired" translate?');
    expect(matchQuestion({ side: "translation", selected: "as of today", source, translation, from: "Japanese", to: "English" }).user).toContain('the ENGLISH phrase "as of today"');
  });

  it("finds the words where the other text writes them, in any case and without quotation marks", () => {
    expect(matchedSpan("you're fired", translation)).toEqual({ start: 7, end: 19 });
    expect(matchedSpan('"Fired."', translation)).toEqual({ start: 14, end: 19 });
    expect(matchedSpan("「クビだ」", source)).toEqual({ start: 10, end: 13 });
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
    expect(matchedSpan("NONE", translation)).toBeNull();
    expect(matchedSpan("  \n", translation)).toBeNull();
    expect(matchedSpan("dismissed", translation)).toBeNull();
  });
});
