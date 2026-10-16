import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers, placeholder as placeholderExt, type DecorationSet } from "@codemirror/view";
import { normalizeSource } from "@ltw/domain/pure";
import { useEffect, useRef } from "react";

/** Places in the text to point out (where a word or a line stands), the current one drawn stronger. */
export interface Hit {
  from: number;
  to: number;
  current: boolean;
}

const setHits = StateEffect.define<readonly Hit[]>();
const hitField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHits)) return Decoration.set(e.value.map((h) => Decoration.mark({ class: h.current ? "cm-hit cm-hit-current" : "cm-hit" }).range(h.from, h.to)), true);
    return tr.docChanged ? Decoration.none : value; // positions mean nothing once the text moves
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The paragraph being worked on: its lines get a bar at their left. */
const setCurrent = StateEffect.define<{ from: number; to: number } | null>();
const currentField = StateField.define<DecorationSet>({
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

/** A note the user wrote from a paragraph on: shown as a line of its own above the paragraph, not part of the text. */
export interface NoteMark {
  paragraph: number;
  /** Where the paragraph starts in the text. */
  at: number;
  text: string;
}

class NoteWidget extends WidgetType {
  constructor(
    readonly paragraph: number,
    readonly text: string,
  ) {
    super();
  }
  eq(other: NoteWidget): boolean {
    return other.paragraph === this.paragraph && other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-note";
    el.dataset["paragraph"] = String(this.paragraph);
    el.title = "The note from here on, sent to the model with this paragraph and the ones after it. Click to change it.";
    el.textContent = `From here: ${this.text}`;
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const setNotes = StateEffect.define<readonly NoteMark[]>();
const notesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setNotes)) continue;
      const doc = tr.state.doc;
      const marks = e.value.filter((n) => n.at <= doc.length).map((n) => Decoration.widget({ widget: new NoteWidget(n.paragraph, n.text), block: true, side: -1 }).range(doc.lineAt(n.at).from));
      return Decoration.set(marks, true);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
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

/** The number of the paragraph each line starts (a paragraph is a line with something on it), for the margin; empty lines have none. */
const paragraphNumbers = new WeakMap<Text, Int32Array>();
function paragraphNumber(line: number, doc: Text): string {
  let counts = paragraphNumbers.get(doc);
  if (!counts) {
    counts = new Int32Array(doc.lines + 1);
    for (let n = 1; n <= doc.lines; n++) counts[n] = counts[n - 1]! + (doc.line(n).text.trim() === "" ? 0 : 1);
    paragraphNumbers.set(doc, counts);
  }
  // The gutter also asks for a number beyond the text to work out how wide to be.
  if (line > doc.lines) return String(counts[doc.lines]);
  return doc.line(line).text.trim() === "" ? "" : String(counts[line]);
}

export interface SourceEditorProps {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  /** Places to point out in the text. */
  hits?: readonly Hit[];
  /** The paragraph being worked on: where it starts and ends in the text. */
  current?: { from: number; to: number } | null;
  /** The cursor was put somewhere in the text by the user (a click or the arrow keys). */
  onCursor?: (position: number) => void;
  /** Take the editor to this place (the start of a paragraph chosen elsewhere). `n` changes each time. */
  reveal?: { at: number; n: number } | null;
  /** Some words of one line were selected (where to put a button, in window coordinates), or the selection went away. */
  onSelect?: (selection: { text: string; left: number; bottom: number } | null) => void;
  /** The notes from a paragraph on, each shown above its paragraph. */
  notes?: readonly NoteMark[];
  /** A paragraph's number or its note was clicked (index from 0, and where to put a box, in window coordinates). */
  onNote?: (paragraph: number, place: { left: number; bottom: number }) => void;
}

/** The longest selection that can be a word of a glossary. */
const LONGEST_WORD = 40;

/** The source text as an editor, with the number of each paragraph in the margin. The numbers are not part of the text. */
export function SourceEditor({ value, onChange, placeholder, hits, current, onCursor, reveal, onSelect, notes, onNote }: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onNoteRef = useRef(onNote);
  onNoteRef.current = onNote;
  const latest = useRef({ value });
  latest.current = { value };

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      history(),
      search({ top: true }),
      // Ctrl/Cmd+Enter runs the translation (handled by the page); do not let the editor insert a blank line for it.
      keymap.of([{ key: "Mod-Enter", run: () => true }, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Source text", spellcheck: "false" }),
      placeholderExt(placeholder),
      lineNumbers({
        formatNumber: (n, state) => paragraphNumber(n, state.doc),
        // A paragraph's number opens its note.
        domEventHandlers: {
          mousedown: (v, block, event) => {
            const line = v.state.doc.lineAt(block.from);
            const n = paragraphNumber(line.number, v.state.doc);
            if (n === "" || !onNoteRef.current) return false;
            const box = (event.target as HTMLElement).getBoundingClientRect();
            onNoteRef.current(Number(n) - 1, { left: box.right + 4, bottom: box.bottom });
            event.preventDefault();
            return true;
          },
        },
      }),
      hitField,
      currentField,
      notesField,
      theme,
      EditorView.domEventHandlers({
        scroll: () => void onSelectRef.current?.(null),
        mousedown: (event) => {
          const note = (event.target as HTMLElement).closest<HTMLElement>(".cm-note");
          if (!note || !onNoteRef.current) return false;
          const box = note.getBoundingClientRect();
          onNoteRef.current(Number(note.dataset["paragraph"]), { left: box.left, bottom: box.bottom });
          event.preventDefault();
          return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        if (u.docChanged || u.selectionSet) {
          const { from, to } = u.state.selection.main;
          const text = from === to || to - from > LONGEST_WORD ? "" : u.state.sliceDoc(from, to);
          const at = text.trim() === "" || text.includes("\n") ? null : u.view.coordsAtPos(to);
          onSelectRef.current?.(at ? { text: text.trim(), left: at.left, bottom: at.bottom } : null);
        }
        // Where the user put the cursor (not where typing moved it).
        if (!u.docChanged && u.selectionSet && u.transactions.some((t) => t.isUserEvent("select"))) onCursorRef.current?.(u.state.selection.main.head);
      }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: normalizeSource(latest.current.value), extensions }), parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Text changed from outside (not by typing here): show it.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const next = normalizeSource(value);
    if (next !== v.state.doc.toString()) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
  }, [value]);

  // Points in the text to show, and the paragraph being worked on. The current place is brought into view once, when it is chosen: the
  // page draws again for other reasons (a selection being made), and scrolling back to the place each time would take the selection away.
  const hitsKey = JSON.stringify(hits ?? []);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const list = (hits ?? []).filter((h) => h.to <= v.state.doc.length);
    v.dispatch({ effects: setHits.of(list) });
    const here = list.find((h) => h.current);
    if (!here) scrolledTo.current = null;
    else if (scrolledTo.current !== `${here.from}-${here.to}`) {
      scrolledTo.current = `${here.from}-${here.to}`;
      v.dispatch({ effects: EditorView.scrollIntoView(here.from, { y: "center" }) });
    }
  }, [hitsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = view.current;
    if (v && reveal && reveal.at <= v.state.doc.length) v.dispatch({ effects: EditorView.scrollIntoView(reveal.at, { y: "start", yMargin: 8 }) });
  }, [reveal?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    view.current?.dispatch({ effects: setCurrent.of(current ?? null) });
  }, [current?.from, current?.to]);
  // Drawn again whenever the text changes too: an edit or an undo next to a note can take its line away, and the notes as they are
  // now say where each one belongs.
  const notesKey = JSON.stringify(notes ?? []);
  useEffect(() => {
    view.current?.dispatch({ effects: setNotes.of(notes ?? []) });
  }, [notesKey, value]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="source-editor" ref={host} />;
}
