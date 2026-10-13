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

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "1.03rem" },
  "&.cm-focused": { outline: "2px solid var(--focus)", outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.7", overflow: "auto" },
  ".cm-content": { padding: "0.5rem 1rem 1rem", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 0.25rem" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
  ".cm-placeholder": { color: "var(--muted)" },
});

export interface SourceEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** The split of the current text. Drawn only if it is exactly this text. */
  blocks: readonly PreviewBlock[] | null;
  placeholder: string;
}

/**
 * The source text as an editor that shows where it will be split into blocks, live as you type.
 * The labels are decorations only: they are never part of the text, so copying and saving ignore them.
 */
export function SourceEditor({ value, onChange, blocks, placeholder }: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
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
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
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

  return <div className="source-editor" ref={host} />;
}
