import {
  describe,
  expect,
  it,
} from "vitest";
import {
  matchQuestion,
  matchedSpan,
} from "./match.js";

const source = "「ノア、お前は今日でクビだ」とセラは言った。";
const translation = "“Noah, you're fired as of today,” Sera said.";

describe("matching a selection to the other text", () => {
  it("asks for the words of the other text, both ways", () => {
    const fromSource = matchQuestion({ side: "source", selected: "クビだ", source, translation, from: "Japanese", to: "English" });
    expect(fromSource.user).toContain(`JAPANESE TEXT:\n${source}`);
    expect(fromSource.user).toContain("The JAPANESE words 「クビだ」 are translated by some words of the ENGLISH text. Which ENGLISH words?");
    const fromTranslation = matchQuestion({ side: "translation", selected: "fired", source, translation, from: "Japanese", to: "English" });
    expect(fromTranslation.user).toContain('The ENGLISH words "fired" translate some words of the JAPANESE text. Which JAPANESE words?');
  });

  it("finds the words where the other text writes them, in any case and without quotation marks", () => {
    expect(matchedSpan("you're fired", translation)).toEqual({ start: 7, end: 19 });
    expect(matchedSpan('"Fired."', translation)).toEqual({ start: 14, end: 19 });
    expect(matchedSpan("「クビだ」", source)).toEqual({ start: 10, end: 13 });
  });

  it("takes the place nearest to where the selection stands", () => {
    const text = "Noah ran. Then Noah fell.";
    expect(matchedSpan("Noah", text, 0)).toEqual({ start: 0, end: 4 });
    expect(matchedSpan("Noah", text, 0.9)).toEqual({ start: 15, end: 19 });
  });

  it("finds nothing for NONE, an empty reply, or words the text does not have", () => {
    expect(matchedSpan("NONE", translation)).toBeNull();
    expect(matchedSpan("  \n", translation)).toBeNull();
    expect(matchedSpan("dismissed", translation)).toBeNull();
  });
});
