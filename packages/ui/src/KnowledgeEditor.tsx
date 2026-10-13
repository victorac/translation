import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExt, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

interface Problem {
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
    el.className = "cm-kbd-msg";
    el.textContent = `  ⚠ ${this.text}`;
    el.setAttribute("contenteditable", "false");
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Colours the document as you type: sections, entries, facts, the "?" that marks a suggestion, and lines that were not understood. */
function decorate(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const problems = new Map(view.state.field(problemsField).map((p) => [p.line, p.message]));
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    const text = line.text;
    const flag = (from: number, body: string) => {
      const cut = body.search(/\s\?\s*$/);
      if (cut >= 0) out.push(Decoration.mark({ class: "cm-kbd-flag" }).range(from + body.indexOf("?", cut), from + body.indexOf("?", cut) + 1));
    };
    if (/^#\s/.test(text) && !text.startsWith("##")) out.push(Decoration.line({ class: "cm-kbd-h1" }).range(line.from));
    else if (/^##\s/.test(text)) {
      out.push(Decoration.line({ class: "cm-kbd-h2" }).range(line.from));
      const bare = text.replace(/<!--.*?-->/g, (m) => " ".repeat(m.length));
      flag(line.from, bare);
    } else if (/^\s*[-*]\s/.test(text)) {
      out.push(Decoration.line({ class: "cm-kbd-fact" }).range(line.from));
      flag(line.from, text);
    }
    for (const m of text.matchAll(/<!--.*?-->/g)) out.push(Decoration.mark({ class: "cm-kbd-comment" }).range(line.from + m.index!, line.from + m.index! + m[0].length));
    const message = problems.get(n);
    if (message) {
      out.push(Decoration.line({ class: "cm-kbd-problem" }).range(line.from));
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

const PLACEHOLDER = "# Characters\n\n## 花子 = Hanako\ngirl, the narrator's classmate, speaks politely\n- Addresses Taro as Taro-kun.\n\n# Places\n# Terms\n# Notes\n- A note about the story";

/**
 * The knowledge base as a text document. Characters, places and terms are `##` entries with their summary under them
 * and their facts as bullets. A "?" marks what a model suggested: remove it to accept, delete the entry to reject.
 */
export function KnowledgeEditor({ rev, counts }: { rev: number; counts: { terms: number; notes: number; suggested: number } }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applying = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [problems, setProblemsState] = useState<Problem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const show = useCallback((text: string) => {
    const v = view.current;
    if (!v) return;
    applying.current = true;
    try {
      patch(v, text);
    } finally {
      applying.current = false;
    }
  }, []);

  /** Sends the text to the background process, which applies it and answers with the text in its tidy form. */
  const send = useCallback(async () => {
    const v = view.current;
    if (!v) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const sent = v.state.doc.toString();
    const r = await api.invoke("knowledge.setText", { text: sent });
    if (!r.ok || !view.current) return;
    setProblemsState(r.value.problems);
    // Do not tidy the text while the user is typing in it; it is tidied when they leave.
    if (v.state.doc.toString() === sent) {
      v.dispatch({ effects: setProblems.of(r.value.problems) });
      if (!v.hasFocus) show(r.value.text);
    }
  }, [show]);

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      history(),
      search({ top: true }),
      keymap.of([{ key: "Mod-Enter", run: () => true }, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Knowledge base", spellcheck: "false" }),
      placeholderExt(PLACEHOLDER),
      problemsField,
      highlight,
      theme,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || applying.current) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void send(), 600);
      }),
      EditorView.domEventHandlers({ blur: () => void send().then(() => void api.invoke("knowledge.text").then((r) => r.ok && !view.current?.hasFocus && show(r.value.text))) }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: "", extensions }), parent: host.current });
    view.current = v;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      v.destroy();
      view.current = null;
    };
  }, [send, show]);

  // The knowledge changed somewhere else (an extraction finished, another project opened): show it, unless it is being typed in.
  useEffect(() => {
    void api.invoke("knowledge.text").then((r) => {
      const v = view.current;
      if (!r.ok || !v) return;
      if (!v.hasFocus || v.state.doc.length === 0) show(r.value.text);
    });
  }, [rev, show]);

  const saveFile = () => {
    const text = view.current?.state.doc.toString() ?? "";
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "knowledge-base.md";
    a.click();
    URL.revokeObjectURL(url);
    setMessage("Saved as knowledge-base.md.");
  };
  const openFile = async (file: File) => {
    const text = (await file.text()).replace(/\r\n?/g, "\n");
    if ((counts.terms + counts.notes > 0) && !window.confirm("Replace the knowledge base with this file? What is in it now will be lost.")) return;
    const r = await api.invoke("knowledge.setText", { text });
    if (!r.ok) return setMessage(r.error.message);
    setProblemsState(r.value.problems);
    show(r.value.text);
    view.current?.dispatch({ effects: setProblems.of([]) });
    setMessage(r.value.problems.length > 0 ? `Opened ${file.name}, but some lines were not understood.` : `Opened ${file.name}.`);
  };

  return (
    <div className="kbd">
      <div className="kbd-bar">
        <span className="hint">
          {counts.terms} {counts.terms === 1 ? "entry" : "entries"} · {counts.notes} {counts.notes === 1 ? "fact" : "facts"}
          {counts.suggested > 0 && ` · ${counts.suggested} to check`}
          {problems.length > 0 && ` · ${problems.length} to fix`}
        </span>
        <span className="kb-actions">
          {counts.suggested > 0 && (
            <button className="small" onClick={() => void api.invoke("knowledge.confirm", {})} title="Take the ? away from everything a model suggested">
              Accept all
            </button>
          )}
          <button className="small" onClick={saveFile} title="Save the knowledge base as a text file">
            Save as file
          </button>
          <button className="small" onClick={() => fileInput.current?.click()} title="Replace the knowledge base with a text file">
            Open file
          </button>
          <input ref={fileInput} type="file" accept=".md,.txt,text/*" hidden onChange={(e) => e.target.files?.[0] && void openFile(e.target.files[0]).then(() => (e.target.value = ""))} />
        </span>
      </div>
      <p className="hint kbd-help">A “?” marks what a model suggested. Remove it to accept the entry, or delete the entry to reject it.</p>
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}
      <div className="kbd-editor" ref={host} />
    </div>
  );
}
