import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExt, WidgetType, type DecorationSet } from "@codemirror/view";
import { normalizeSource } from "@ltw/domain/pure";
import { useEffect, useRef } from "react";
import { blockMarkers, type BlockMarker, type PreviewBlock } from "./blockMarkers";

/** The label drawn above a block (or inline, when a block starts in the middle of a line). */
class BlockLabel extends WidgetType {
  constructor(
    private readonly marker: BlockMarker,
    private readonly inline: boolean,
  ) {
    super();
  }
  override eq(other: BlockLabel): boolean {
    const a = this.marker;
    const b = other.marker;
    return this.inline === other.inline && a.index === b.index && a.tokens === b.tokens && a.warning === b.warning && a.cutBefore === b.cutBefore;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement(this.inline ? "span" : "div");
    // An inline label only looks like a warning when the text really was cut roughly just before it.
    el.className = `cm-block-label${this.inline ? " inline" : ""}${this.inline ? (this.marker.cutBefore ? " warn" : "") : this.marker.warning ? " warn" : ""}`;
    el.setAttribute("contenteditable", "false");
    const n = document.createElement("span");
    n.className = "cm-block-n";
    n.textContent = `Block ${this.marker.index + 1}`;
    el.append(n, ` · ~${this.marker.tokens} tokens`);
    if (this.marker.warning) {
      const w = document.createElement("span");
      w.className = "cm-block-warn";
      w.textContent = ` · ⚠ ends: ${this.marker.warning}`;
      el.append(w);
    }
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const setMarkers = StateEffect.define<BlockMarker[]>();

function build(markers: readonly BlockMarker[], doc: Text): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // A label sits at the start of its block; the lines of alternate blocks are tinted.
  for (const m of markers) {
    ranges.push(Decoration.widget({ widget: new BlockLabel(m, !m.atLineStart), block: m.atLineStart, side: -1 }).range(m.start));
    if (m.end > m.start) {
      const first = doc.lineAt(m.start).number;
      const last = doc.lineAt(Math.max(m.start, m.end - 1)).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        // A line that begins before this block (a cut in the middle of it) keeps the tint of the block it started in.
        if (line.from >= m.start) ranges.push(Decoration.line({ class: m.index % 2 === 0 ? "cm-blk-a" : "cm-blk-b" }).range(line.from));
      }
    }
  }
  return Decoration.set(ranges, true);
}

/** Block labels, kept in a state field because block widgets are not allowed from plugins. */
const blockField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return build(e.value, tr.state.doc);
    // While typing, the labels follow the text until a fresh split arrives.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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

/** The block being worked on: its lines get a bar at their left. */
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
});

export interface SourceEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** The split of the current text. Drawn only if it is exactly this text. */
  blocks: readonly PreviewBlock[] | null;
  placeholder: string;
  /** Places to point out in the text. */
  hits?: readonly Hit[];
  /** The block being worked on: where it starts and ends in the text. */
  current?: { from: number; to: number } | null;
  /** The cursor was put somewhere in the text by the user (a click or the arrow keys). */
  onCursor?: (position: number) => void;
  /** Take the editor to this place (the start of a block chosen elsewhere). `n` changes each time. */
  reveal?: { at: number; n: number } | null;
}

/**
 * The source text as an editor that shows where it will be split into blocks, live as you type.
 * The labels are decorations only: they are never part of the text, so copying and saving ignore them.
 */
export function SourceEditor({ value, onChange, blocks, placeholder, hits, current, onCursor, reveal }: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const latest = useRef({ value, blocks });
  latest.current = { value, blocks };

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
      blockField,
      hitField,
      currentField,
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        // Where the user put the cursor (not where typing moved it).
        else if (u.selectionSet && u.transactions.some((t) => t.isUserEvent("select"))) onCursorRef.current?.(u.state.selection.main.head);
      }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: normalizeSource(latest.current.value), extensions }), parent: host.current });
    view.current = v;
    const initial = latest.current.blocks && blockMarkers(v.state.doc.toString(), latest.current.blocks);
    if (initial) v.dispatch({ effects: setMarkers.of(initial) });
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

  // A fresh split arrived: draw it if it matches the text.
  useEffect(() => {
    const v = view.current;
    if (!v || !blocks) return;
    const markers = blockMarkers(v.state.doc.toString(), blocks);
    if (markers) v.dispatch({ effects: setMarkers.of(markers) });
  }, [blocks]);

  // Points in the text to show, and the block being worked on. The current place is brought into view.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const list = (hits ?? []).filter((h) => h.to <= v.state.doc.length);
    v.dispatch({ effects: setHits.of(list) });
    const here = list.find((h) => h.current);
    if (here) v.dispatch({ effects: EditorView.scrollIntoView(here.from, { y: "center" }) });
  }, [hits]);
  useEffect(() => {
    const v = view.current;
    if (v && reveal && reveal.at <= v.state.doc.length) v.dispatch({ effects: EditorView.scrollIntoView(reveal.at, { y: "start", yMargin: 8 }) });
  }, [reveal?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    view.current?.dispatch({ effects: setCurrent.of(current ?? null) });
  }, [current?.from, current?.to, blocks]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="source-editor" ref={host} />;
}
