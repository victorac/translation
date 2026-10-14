import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExt, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { api } from "./api";

export interface Problem {
  line: number;
  message: string;
}

const setProblems = StateEffect.define<Problem[]>();
const problemsField = StateField.define<Problem[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setProblems)) return e.value;
    return tr.docChanged ? [] : value; // line numbers no longer mean anything once the text moves
  },
});

class Message extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  override eq(o: Message): boolean {
    return o.text === this.text;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-kbf-msg";
    el.textContent = `  ⚠ ${this.text}`;
    el.setAttribute("contenteditable", "false");
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Colours the file as you type: the header block, attribute names, `[[links]]`, the "?" that marks a suggestion,
 * the notes, and lines that were not understood. (Lines get no margins or size changes: they confuse the editor's
 * measuring, which breaks the cursor, the arrow keys and selecting with the mouse.)
 */
function decorate(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const problems = new Map(view.state.field(problemsField).map((p) => [p.line, p.message]));
  let front: "before" | "in" | "after" = "before";
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    const text = line.text;
    const mark = (cls: string, from: number, to: number) => out.push(Decoration.mark({ class: cls }).range(line.from + from, line.from + to));
    if (text.trim() === "---" && front !== "after") {
      front = front === "before" ? "in" : "after";
      out.push(Decoration.line({ class: "cm-kbf-rule" }).range(line.from));
    } else if (front === "in") {
      const colon = text.indexOf(":");
      if (colon > 0) mark("cm-kbf-key", 0, colon);
      if (/^status\s*:\s*suggested/i.test(text)) mark("cm-kbf-flag", text.indexOf("suggested"), text.length);
    } else if (/^##\s/.test(text)) {
      out.push(Decoration.line({ class: "cm-kbf-h2" }).range(line.from));
    } else if (/^#\s/.test(text)) {
      out.push(Decoration.line({ class: "cm-kbf-h1" }).range(line.from));
    }
    const flag = /\s\?\s*$/.exec(text);
    if (flag && !/^status/i.test(text)) mark("cm-kbf-flag", flag.index + 1, flag.index + 2);
    for (const m of text.matchAll(/\[\[(.*?)\]\]/g)) mark("cm-kbf-link", m.index!, m.index! + m[0].length);
    for (const m of text.matchAll(/<!--.*?-->/g)) mark("cm-kbf-comment", m.index!, m.index! + m[0].length);
    const message = problems.get(n);
    if (message) {
      out.push(Decoration.line({ class: "cm-kbf-problem" }).range(line.from));
      out.push(Decoration.widget({ widget: new Message(message), side: 1 }).range(line.to));
    }
  }
  return Decoration.set(out, true);
}

const highlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setProblems)))) this.decorations = decorate(u.view);
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

/** The `[[link]]` at a position in the text, if any. */
function linkAt(view: EditorView, pos: number): { name: string; key: string } | null {
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(/\[\[(.*?)\]\]/g)) {
    const from = line.from + m.index!;
    if (pos >= from && pos <= from + m[0].length) return { name: m[1]!, key: line.text.slice(0, m.index).split(":")[0]!.trim().toLocaleLowerCase() };
  }
  return null;
}

export interface TopicEditorProps {
  id: string;
  /** Changes when the knowledge base changes somewhere else. */
  rev: number;
  /** A click on a link. */
  onLink: (name: string, key: string) => void;
  /** The text, the problems and what links here, whenever the file is read or applied. */
  onLoaded: (file: { text: string; problems: Problem[]; backlinks: { id: string; title: string }[]; title: string }) => void;
  /** The text as it is being typed, for showing the links in it. */
  onText: (text: string) => void;
}

/**
 * One file of the knowledge base as an editable text. What you type is applied after a short pause, and the file is
 * tidied when you click away.
 */
export function TopicEditor({ id, rev, onLink, onLoaded, onText }: TopicEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applying = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlers = useRef({ onLink, onLoaded, onText });
  handlers.current = { onLink, onLoaded, onText };

  /** The tidy text last applied, with the problems placed on its lines. */
  const tidy = useRef<{ text: string; problems: Problem[] } | null>(null);

  const show = (text: string) => {
    const v = view.current;
    if (!v) return;
    applying.current = true;
    try {
      patch(v, text);
    } finally {
      applying.current = false;
    }
    if (tidy.current?.text === text) v.dispatch({ effects: setProblems.of(tidy.current.problems) });
  };

  /** Sends what was typed; the answer is the file in its tidy form, which replaces the text unless the user is typing. */
  const send = async () => {
    const v = view.current;
    if (!v) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const sent = v.state.doc.toString();
    const r = await api.invoke("knowledge.setFile", { id, text: sent });
    if (!r.ok || !view.current) return;
    handlers.current.onLoaded(r.value);
    tidy.current = { text: r.value.text, problems: r.value.tidyProblems ?? r.value.problems };
    if (v.state.doc.toString() === sent) {
      if (!v.hasFocus) show(r.value.text);
      else v.dispatch({ effects: setProblems.of(r.value.problems) });
    }
  };

  const load = async () => {
    const r = await api.invoke("knowledge.file", { id });
    const v = view.current;
    if (!r.ok || !v) return;
    handlers.current.onLoaded(r.value);
    if (!v.hasFocus || v.state.doc.length === 0) show(r.value.text);
    handlers.current.onText(v.state.doc.toString());
  };

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      history(),
      search({ top: true }),
      keymap.of([{ key: "Mod-Enter", run: () => true }, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Knowledge base file", spellcheck: "false" }),
      placeholderExt("(empty)"),
      problemsField,
      highlight,
      theme,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || applying.current) return;
        handlers.current.onText(u.state.doc.toString());
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void send(), 600);
      }),
      EditorView.domEventHandlers({
        blur: () => {
          void send().then(() => void load());
        },
        mousedown: (e, v) => {
          if (e.button !== 0 || e.shiftKey || e.detail > 1) return false;
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          const l = pos === null ? null : linkAt(v, pos);
          if (!l) return false;
          e.preventDefault();
          handlers.current.onLink(l.name, l.key);
          return true;
        },
      }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: "", extensions }), parent: host.current });
    view.current = v;
    void load();
    return () => {
      // Whatever was typed last is applied before the file is closed.
      if (timer.current) {
        clearTimeout(timer.current);
        void api.invoke("knowledge.setFile", { id, text: v.state.doc.toString() });
      }
      v.destroy();
      view.current = null;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="kbf-editor" ref={host} />;
}
