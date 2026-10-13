/** How the columns are arranged: which order the models come in and how wide each column is. */
export interface ColumnLayout {
  /** Model labels in the order they are shown. Labels not listed come after, in their usual order. */
  order: string[];
  /** Chosen widths in pixels, by column key. A column without an entry shares the free space. */
  widths: Record<string, number>;
}

export const SOURCE_KEY = "~source";
export const KNOWLEDGE_KEY = "~knowledge";
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 1400;
export const EMPTY_LAYOUT: ColumnLayout = { order: [], widths: {} };

export function clampWidth(w: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
}

/** Put items in the saved order; anything new keeps its place after the ones that were arranged. */
export function orderBy<T extends { label: string }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = (l: string) => {
    const i = order.indexOf(l);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.label) - rank(b.item.label) || a.i - b.i)
    .map((x) => x.item);
}

/** Move `from` so it sits just before `to` (or at the end when `to` is null). `current` is the order on screen now. */
export function moveBefore(current: readonly string[], from: string, to: string | null): string[] {
  if (from === to || !current.includes(from)) return [...current];
  const rest = current.filter((l) => l !== from);
  const at = to === null ? rest.length : rest.indexOf(to);
  if (at < 0) return [...current];
  rest.splice(at, 0, from);
  return rest;
}

/** Move one step left (-1) or right (+1). */
export function nudge(current: readonly string[], label: string, step: -1 | 1): string[] {
  const i = current.indexOf(label);
  const j = i + step;
  if (i < 0 || j < 0 || j >= current.length) return [...current];
  const next = [...current];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function columnTemplate(layout: ColumnLayout, labels: readonly string[]): string {
  const col = (key: string, free: string) => {
    const w = layout.widths[key];
    return w ? `${clampWidth(w)}px` : free;
  };
  return [col(SOURCE_KEY, "minmax(16rem, 1.1fr)"), ...labels.map((l) => col(l, "minmax(15rem, 1fr)"))].join(" ");
}

export function isCustom(layout: ColumnLayout): boolean {
  return layout.order.length > 0 || Object.keys(layout.widths).length > 0;
}

/** Read a layout that came from storage, ignoring anything that is not the expected shape. */
export function parseLayout(raw: unknown): ColumnLayout {
  if (typeof raw !== "object" || raw === null) return EMPTY_LAYOUT;
  const r = raw as { order?: unknown; widths?: unknown };
  const order = Array.isArray(r.order) ? r.order.filter((x): x is string => typeof x === "string") : [];
  const widths: Record<string, number> = {};
  if (typeof r.widths === "object" && r.widths !== null) {
    for (const [k, v] of Object.entries(r.widths)) if (typeof v === "number" && Number.isFinite(v)) widths[k] = clampWidth(v);
  }
  return { order, widths };
}
