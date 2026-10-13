import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExt, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { parseKnowledge } from "@ltw/domain/pure";
import { useEffect, useMemo, useRef } from "react";

class Message extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  override eq(o: Message): boolean {
    return o.text === this.text;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-kb-msg";
    el.textContent = `  ⚠ ${this.text}`;
    el.setAttribute("contenteditable", "false");
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const TERM = /^(\s*)(.*?)(\s*(?:=>|->|→|=|\t)\s*)(.*?)(\s+#\s.*)?$/;

/** Colours each line by how it was read, as you type. Lines that were not understood say why. */
function decorate(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const ranges: Range<Decoration>[] = [];
  for (const l of parseKnowledge(text).lines) {
    if (l.kind === "blank") continue;
    ranges.push(Decoration.line({ class: `cm-kb-${l.kind}` }).range(l.from));
    if (l.kind === "problem") {
      ranges.push(Decoration.widget({ widget: new Message(l.message), side: 1 }).range(l.to));
    } else if (l.kind === "term") {
      const m = TERM.exec(text.slice(l.from, l.to));
      if (m) {
        const a = l.from + m[1]!.length;
        const b = a + m[2]!.length;
        const c = b + m[3]!.length;
        const d = c + m[4]!.length;
        if (b > a) ranges.push(Decoration.mark({ class: "cm-kb-source" }).range(a, b));
        if (c > b) ranges.push(Decoration.mark({ class: "cm-kb-sep" }).range(b, c));
        if (d > c) ranges.push(Decoration.mark({ class: "cm-kb-target" }).range(c, d));
        if (l.to > d) ranges.push(Decoration.mark({ class: "cm-kb-hint" }).range(d, l.to));
      }
    } else if (l.kind === "note") {
      const line = text.slice(l.from, l.to);
      const bar = line.indexOf("|");
      const start = l.from + line.indexOf(">");
      if (bar >= 0) {
        ranges.push(Decoration.mark({ class: "cm-kb-keys" }).range(start, l.from + bar + 1));
      } else ranges.push(Decoration.mark({ class: "cm-kb-sep" }).range(start, start + 1));
    }
  }
  return Decoration.set(ranges, true);
}

const highlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = decorate(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "0.95rem" },
  "&.cm-focused": { outline: "2px solid var(--focus)", outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "0.5rem 0.5rem 1rem", caretColor: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
  ".cm-placeholder": { color: "var(--muted)" },
});

/** Replaces only the part of the document that differs, so the cursor and undo history survive outside changes. */
function patch(view: EditorView, next: string): void {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--;
    endNext--;
  }
  view.dispatch({ changes: { from: start, to: endCur, insert: next.slice(start, endNext) } });
}

const PLACEHOLDER = "花子 = Hanako # girl, speaks politely\n> 花子, 太郎 | The second speaker is talking to Hanako.\n> A note for every block\n# A heading or comment";

/** The project's knowledge base: names, hints and notes as plain lines, checked as you type. */
export function KnowledgeEditor({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const first = useRef(value);

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      history(),
      search({ top: true }),
      keymap.of([{ key: "Mod-Enter", run: () => true }, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Names, hints and notes", spellcheck: "false" }),
      placeholderExt(PLACEHOLDER),
      highlight,
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: first.current, extensions }), parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    if (view.current) patch(view.current, value);
  }, [value]);

  return <div className="kb-editor" ref={host} />;
}

/** How many terms and notes were read, and how many lines need fixing. */
export function useKnowledgeSummary(text: string) {
  return useMemo(() => {
    const k = parseKnowledge(text);
    return { terms: k.glossary.length, notes: k.notes.length, problems: k.lines.filter((l) => l.kind === "problem").length };
  }, [text]);
}

export function KnowledgeSummary({ text }: { text: string }) {
  const s = useKnowledgeSummary(text);
  return (
    <span className="hint">
      {s.terms} {s.terms === 1 ? "term" : "terms"} · {s.notes} {s.notes === 1 ? "note" : "notes"}
      {s.problems > 0 && ` · ${s.problems} to fix`}
    </span>
  );
}

export const KNOWLEDGE_HELP = "name = translation # hint    ·    > names | note    ·    # comment";
