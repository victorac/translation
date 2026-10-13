import { describe, expect, it } from "vitest";
import { defaultTree, isValid, parseTree, placeView, reconcile, removeView, setRatio, viewsOf, type PaneNode } from "./paneTree";

const p = (view: string): PaneNode => ({ kind: "pane", view });

describe("pane tree", () => {
  it("starts with every view side by side", () => {
    const t = defaultTree(["s", "a", "b"]);
    expect(viewsOf(t)).toEqual(["s", "a", "b"]);
    expect(t.kind === "split" && t.axis).toBe("row");
    expect(() => defaultTree([])).toThrow(RangeError);
  });

  it("removing a view lets its sibling take the space", () => {
    expect(removeView(defaultTree(["s", "a"]), "a")).toEqual(p("s"));
    expect(viewsOf(removeView(defaultTree(["s", "a", "b"]), "a")!)).toEqual(["s", "b"]);
    expect(removeView(p("s"), "s")).toBeNull();
  });

  it("places a view beside or above another", () => {
    const below = placeView(defaultTree(["s", "a", "b"]), "b", "a", "bottom");
    expect(viewsOf(below).sort()).toEqual(["a", "b", "s"]);
    expect(isValid(below)).toBe(true);
    const found = JSON.stringify(below);
    expect(found).toContain('"axis":"column"');
    const left = placeView(defaultTree(["s", "a"]), "a", "s", "left");
    expect(viewsOf(left)).toEqual(["a", "s"]);
  });

  it("ignores placing a view on itself or on a missing target", () => {
    const t = defaultTree(["s", "a"]);
    expect(placeView(t, "a", "a", "left")).toBe(t);
    expect(placeView(t, "a", "zzz", "left")).toBe(t);
  });

  it("keeps up with the views that exist", () => {
    const t = defaultTree(["s", "a", "b"]);
    expect(viewsOf(reconcile(t, ["s", "b"]))).toEqual(["s", "b"]);
    expect(viewsOf(reconcile(t, ["s", "a", "b", "c"]))).toEqual(["s", "a", "b", "c"]);
    expect(viewsOf(reconcile(null, ["x", "y"]))).toEqual(["x", "y"]);
    expect(viewsOf(reconcile(p("gone"), ["x"]))).toEqual(["x"]);
  });

  it("changes a split's ratio within limits", () => {
    const t = defaultTree(["s", "a", "b"]);
    const r = setRatio(t, "b", 0.9) as Extract<PaneNode, { kind: "split" }>;
    expect((r.b as Extract<PaneNode, { kind: "split" }>).ratio).toBe(0.9);
    expect((setRatio(t, "", 5) as Extract<PaneNode, { kind: "split" }>).ratio).toBe(0.95);
  });

  it("only accepts well-formed trees from storage", () => {
    const t = defaultTree(["s", "a"]);
    expect(parseTree(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(parseTree({ kind: "split", axis: "diagonal", ratio: 0.5, a: p("s"), b: p("a") })).toBeNull();
    expect(parseTree("x")).toBeNull();
    expect(parseTree({ kind: "pane", view: "" })).toBeNull();
  });
});
