import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT, SOURCE_KEY, clampWidth, columnTemplate, moveBefore, nudge, orderBy, parseLayout } from "./layout";

const items = (...l: string[]) => l.map((label) => ({ label }));

describe("column layout", () => {
  it("orders by the saved order and keeps new items after", () => {
    expect(orderBy(items("a", "b", "c"), ["c", "a"]).map((x) => x.label)).toEqual(["c", "a", "b"]);
    expect(orderBy(items("a", "b"), []).map((x) => x.label)).toEqual(["a", "b"]);
  });
  it("moves before another or to the end", () => {
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(moveBefore(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });
  it("nudges one step and stops at the ends", () => {
    expect(nudge(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudge(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(nudge(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });
  it("keeps widths within limits", () => {
    expect(clampWidth(10)).toBe(240);
    expect(clampWidth(99999)).toBe(1400);
  });
  it("builds a template, fixed where a width was chosen", () => {
    const t = columnTemplate({ order: [], widths: { [SOURCE_KEY]: 300, m2: 500 } }, ["m1", "m2"]);
    expect(t).toBe("300px minmax(15rem, 1fr) 500px");
  });
  it("ignores junk from storage", () => {
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(parseLayout({ order: ["a", 3], widths: { a: 50, b: "x" } })).toEqual({ order: ["a"], widths: { a: 240 } });
  });
});
