/**
 * Free-form panes: the screen is cut in two, and each half may be cut again. A leaf shows one view
 * (the source text, or one model's translation). All functions here return new trees and never change their input.
 */
export type PaneNode = { kind: "pane"; view: string } | { kind: "split"; axis: "row" | "column"; ratio: number; a: PaneNode; b: PaneNode };

/** Where to put a dragged pane next to another one. */
export type Edge = "left" | "right" | "top" | "bottom";

/** A split's position in the tree: "" is the root, then "a" or "b" for each step down. */
export type Path = string;

export const MIN_RATIO = 0.05;
const clampRatio = (r: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));
const pane = (view: string): PaneNode => ({ kind: "pane", view });

export function viewsOf(t: PaneNode): string[] {
  return t.kind === "pane" ? [t.view] : [...viewsOf(t.a), ...viewsOf(t.b)];
}

/** Every view side by side with equal width. */
export function defaultTree(views: readonly string[]): PaneNode {
  const [first, ...rest] = views;
  if (first === undefined) throw new RangeError("A layout needs at least one view.");
  if (rest.length === 0) return pane(first);
  return { kind: "split", axis: "row", ratio: 1 / views.length, a: pane(first), b: defaultTree(rest) };
}

/** Takes a view out. The split it was in disappears and its sibling takes the space. Null when nothing is left. */
export function removeView(t: PaneNode, view: string): PaneNode | null {
  if (t.kind === "pane") return t.view === view ? null : t;
  const a = removeView(t.a, view);
  const b = removeView(t.b, view);
  if (a === null) return b;
  if (b === null) return a;
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/** Moves `view` so it sits at one edge of `target`. */
export function placeView(t: PaneNode, view: string, target: string, edge: Edge): PaneNode {
  if (view === target) return t;
  const rest = removeView(t, view);
  if (rest === null || !viewsOf(rest).includes(target)) return t;
  const axis = edge === "left" || edge === "right" ? "row" : "column";
  const first = edge === "left" || edge === "top";
  const insert = (n: PaneNode): PaneNode => {
    if (n.kind === "pane") {
      if (n.view !== target) return n;
      return { kind: "split", axis, ratio: 0.5, a: first ? pane(view) : n, b: first ? n : pane(view) };
    }
    return { ...n, a: insert(n.a), b: insert(n.b) };
  };
  return insert(rest);
}

/** Keeps the layout in step with the views that exist now: drops the ones that are gone, adds new ones on the right. */
export function reconcile(t: PaneNode | null, views: readonly string[]): PaneNode {
  if (views.length === 0) throw new RangeError("A layout needs at least one view.");
  if (t === null) return defaultTree(views);
  const want = new Set(views);
  let next: PaneNode | null = t;
  for (const v of viewsOf(t)) if (!want.has(v) && next) next = removeView(next, v);
  if (next === null) return defaultTree(views);
  const have = new Set(viewsOf(next));
  for (const v of views) {
    if (have.has(v)) continue;
    const count = have.size;
    next = { kind: "split", axis: "row", ratio: count / (count + 1), a: next, b: pane(v) };
    have.add(v);
  }
  return next;
}

export function setRatio(t: PaneNode, path: Path, ratio: number): PaneNode {
  if (t.kind === "pane") return t;
  if (path === "") return { ...t, ratio: clampRatio(ratio) };
  const step = path[0];
  const rest = path.slice(1);
  return step === "a" ? { ...t, a: setRatio(t.a, rest, ratio) } : { ...t, b: setRatio(t.b, rest, ratio) };
}

/** Reads a layout from storage, returning null for anything that is not a valid tree. */
export function parseTree(raw: unknown, depth = 0): PaneNode | null {
  if (typeof raw !== "object" || raw === null || depth > 24) return null;
  const r = raw as Record<string, unknown>;
  if (r["kind"] === "pane") return typeof r["view"] === "string" && r["view"] !== "" ? pane(r["view"]) : null;
  if (r["kind"] !== "split") return null;
  const a = parseTree(r["a"], depth + 1);
  const b = parseTree(r["b"], depth + 1);
  const axis = r["axis"];
  if (!a || !b || (axis !== "row" && axis !== "column") || typeof r["ratio"] !== "number" || !Number.isFinite(r["ratio"])) return null;
  return { kind: "split", axis, ratio: clampRatio(r["ratio"]), a, b };
}

/** False when the same view appears twice, which would show it in two places. */
export const isValid = (t: PaneNode): boolean => new Set(viewsOf(t)).size === viewsOf(t).length;
