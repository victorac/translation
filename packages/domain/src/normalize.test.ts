import {
  describe,
  expect,
  it,
} from "vitest";
import fc from "fast-check";
import {
  normalizeSource,
} from "./normalize.js";

describe("normalizeSource", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeSource("A\r\nB\rC\nD")).toBe("A\nB\nC\nD");
  });
  it("leaves Unicode (emoji, kana) untouched", () => {
    const s = "やっぱり、そうなんだね 👍🏽 Alice";
    expect(normalizeSource(s)).toBe(s);
  });
  it("is idempotent and leaves no CR", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const n = normalizeSource(s);
        return normalizeSource(n) === n && !n.includes("\r");
      }),
    );
  });
});
