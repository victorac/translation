import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useEffect, useRef } from "react";

export interface Problem {
  line: number;
  message: string;
}

const setProblems = StateEffect.define<Problem[]>();
const problemsField = StateField.define<Problem[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setProblems)) return e.value;
    return value;
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

/** Colours the headings, the comments and the lines that were not understood. Lines get no margins or size changes, which would break the cursor. */
function decorate(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const problems = new Map(view.state.field(problemsField).map((p) => [p.line, p.message]));
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    const text = line.text;
    const hash = text.search(/\s#/);
    if (text.startsWith("##")) out.push(Decoration.mark({ class: "cm-kbf-key" }).range(line.from, line.to));
    else if (/^(told as|narrator)\s*:/i.test(text)) out.push(Decoration.mark({ class: "cm-kbf-key" }).range(line.from, line.from + text.indexOf(":") + 1));
    if (hash > 0) out.push(Decoration.mark({ class: "cm-kbf-comment" }).range(line.from + hash, line.to));
    const problem = problems.get(n);
    if (problem) {
      out.push(Decoration.mark({ class: "cm-kbf-problem" }).range(line.from, Math.max(line.to, line.from + 1)));
      out.push(Decoration.widget({ widget: new Message(problem), side: 1 }).range(line.to));
    }
  }
  return Decoration.set(out, true);
}

const decorations = ViewPlugin.fromClass(
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

/** A small text editor for what was read from a block, with what is wrong shown on the lines it is on. */
export function ReadingEditor({ docKey, text, problems, onText }: { docKey: string; text: string; problems: Problem[]; onText: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  // A new document is made when another block is shown; edits made by typing do not remake it.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.theme({ "&": { backgroundColor: "transparent", color: "var(--text)" }, ".cm-content": { caretColor: "var(--text)" }, ".cm-cursor": { borderLeftColor: "var(--text)" } }),
          problemsField,
          decorations,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onTextRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [docKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A change made from outside (for example "Guess the speakers") replaces the text.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);

  useEffect(() => {
    view.current?.dispatch({ effects: setProblems.of(problems) });
  }, [problems]);

  return <div className="reading-editor" ref={host} />;
}
