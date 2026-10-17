import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** The look of the source and the translation editors, which read alike: the same type, line height and margin. */
export const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "1.03rem" },
  "&.cm-focused": { outline: "2px solid var(--focus)", outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.7", overflow: "auto" },
  ".cm-content": { padding: "0.5rem 1rem 1rem", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 0.25rem" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-hit": { backgroundColor: "color-mix(in srgb, var(--warn) 14%, transparent)" },
  ".cm-hit-current": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)", boxShadow: "inset 0 -2px 0 var(--accent)" },
  ".cm-blk-current": { boxShadow: "inset 3px 0 0 var(--accent)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted)", fontSize: "0.75rem" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.4rem 0 0.6rem", minWidth: "2.4rem", textAlign: "right", cursor: "pointer" },
  ".cm-lineNumbers .cm-gutterElement:hover": { color: "var(--accent)" },
  ".cm-note": { fontSize: "0.8rem", color: "var(--accent)", padding: "0.15rem 0.25rem", margin: "0.35rem 0 0.1rem", borderTop: "1px dashed color-mix(in srgb, var(--accent) 45%, transparent)", cursor: "pointer", fontStyle: "italic" },
});

/** The paragraph being worked on: its lines get a bar at their left. */
export const setCurrent = StateEffect.define<{ from: number; to: number } | null>();
export const currentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setCurrent)) continue;
      if (!e.value) return Decoration.none;
      const doc = tr.state.doc;
      const first = doc.lineAt(Math.min(e.value.from, doc.length)).number;
      const last = doc.lineAt(Math.min(Math.max(e.value.from, e.value.to - 1), doc.length)).number;
      const lines: Range<Decoration>[] = [];
      for (let n = first; n <= last; n++) lines.push(Decoration.line({ class: "cm-blk-current" }).range(doc.line(n).from));
      return Decoration.set(lines, true);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** A word of the glossary where it stands in the text: underlined in the colour of its kind, solid when fixed, dotted when suggested. */
export interface Underline {
  from: number;
  to: number;
  kind: string;
  status: "fixed" | "suggested";
  /** What shows when the pointer rests on it. */
  title: string;
}

/** A kind of topic as part of a class name: a kind the user made up may have any letters in it. */
const kindClass = (kind: string): string => `cm-entry-k-${kind.toLocaleLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-")}`;

export const setUnderlines = StateEffect.define<readonly Underline[]>();
export const underlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setUnderlines)) continue;
      const length = tr.state.doc.length;
      const marks = e.value
        .filter((u) => u.from < u.to && u.to <= length)
        .map((u) => Decoration.mark({ class: `cm-entry ${kindClass(u.kind)} cm-entry-${u.status}`, attributes: { title: u.title } }).range(u.from, u.to));
      return Decoration.set(marks, true);
    }
    // While the text is being typed the underlines move with it, until they are worked out again.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
