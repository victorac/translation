import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { currentField, editorTheme, entryEvents, setCurrent, setUnderlines, underlineField, type EntryEvents, type Underline } from "./editorShared";

/** A translation is one line of the editor: a line break the model left in it shows as a space. */
export const asLine = (translation: string): string => translation.replace(/\s*\n\s*/g, " ");

class IssueWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: IssueWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-issue";
    el.setAttribute("role", "status");
    el.textContent = this.text;
    return el;
  }
}

/** What the translation says is wrong with a paragraph, shown under it. */
const setIssues = StateEffect.define<readonly (string | null | undefined)[]>();
const issuesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setIssues)) continue;
      const doc = tr.state.doc;
      const marks = e.value.flatMap((issue, k) => (issue && k < doc.lines ? [Decoration.widget({ widget: new IssueWidget(issue), block: true, side: 1 }).range(doc.line(k + 1).to)] : []));
      return Decoration.set(marks, true);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Each paragraph stays one line: a line break typed or pasted becomes a space, and an edit that would join two paragraphs (a
 * deletion across the end of a line) does nothing.
 */
const oneLineEach = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let breaks = false;
  let joins = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (tr.startState.doc.sliceString(fromA, toA).includes("\n")) joins = true;
    if (inserted.lines > 1) breaks = true;
  });
  if (joins) return [];
  if (!breaks) return tr;
  const specs: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => specs.push({ from: fromA, to: toA, insert: asLine(inserted.toString()) }));
  const changes = tr.startState.changes(specs);
  return { changes, selection: EditorSelection.cursor(changes.mapPos(tr.startState.selection.main.head, 1)), userEvent: tr.annotation(Transaction.userEvent) ?? "input", scrollIntoView: true };
});

export interface TranslationEditorProps {
  /** The translation of each paragraph, in order; empty for one not translated yet. */
  lines: readonly string[];
  /** The user changed the translation of a paragraph (index from 0). */
  onEdit: (paragraph: number, text: string) => void;
  /** The cursor left a paragraph, or the editor: the time to keep what was written there. */
  onLeave: (paragraph: number) => void;
  /** The user put the cursor in a paragraph. */
  onCursor: (paragraph: number) => void;
  /** The paragraph being worked on. */
  current: number | null;
  /** Take the editor to this paragraph. `n` changes each time. */
  reveal?: { paragraph: number; n: number } | null;
  /** What is wrong with each paragraph's translation, if anything. */
  issues: readonly (string | null | undefined)[];
  underlines: readonly Underline[];
  /** The pointer on the words of the glossary. */
  entries?: EntryEvents;
}

/** The translation as one editor, one line for each paragraph of the source, numbered like it. */
export function TranslationEditor({ lines, onEdit, onLeave, onCursor, current, reveal, issues, underlines, entries }: TranslationEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onEdit, onLeave, onCursor });
  handlers.current = { onEdit, onLeave, onCursor };
  const entriesRef = useRef<EntryEvents>(entries ?? {});
  entriesRef.current = entries ?? {};
  const shown = lines.map(asLine);
  const latest = useRef(shown);
  latest.current = shown;

  useEffect(() => {
    if (!host.current) return;
    let at: number | null = null;
    const extensions: Extension[] = [
      history(),
      search({ top: true }),
      keymap.of([
        { key: "Mod-Enter", run: () => true },
        // Enter goes on to the end of the next paragraph instead of breaking this one.
        {
          key: "Enter",
          run: (v) => {
            const line = v.state.doc.lineAt(v.state.selection.main.head);
            if (line.number < v.state.doc.lines) v.dispatch({ selection: { anchor: v.state.doc.line(line.number + 1).to }, scrollIntoView: true, userEvent: "select" });
            return true;
          },
        },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      oneLineEach,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Translation", spellcheck: "false" }),
      lineNumbers(),
      currentField,
      issuesField,
      underlineField,
      entryEvents(entriesRef),
      editorTheme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete") || t.isUserEvent("undo") || t.isUserEvent("redo") || t.isUserEvent("move"))) {
          const touched = new Set<number>();
          u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
            for (let n = u.state.doc.lineAt(fromB).number; n <= u.state.doc.lineAt(toB).number; n++) touched.add(n);
          });
          for (const n of touched) handlers.current.onEdit(n - 1, u.state.doc.line(n).text);
        }
        const here = u.view.hasFocus ? u.state.doc.lineAt(u.state.selection.main.head).number - 1 : null;
        if (here !== at) {
          if (at !== null) handlers.current.onLeave(at);
          if (here !== null) handlers.current.onCursor(here);
          at = here;
        }
      }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: latest.current.join("\n"), extensions }), parent: host.current });
    view.current = v;
    return () => {
      if (at !== null) handlers.current.onLeave(at);
      v.destroy();
      view.current = null;
    };
  }, []);

  // A translation written by the model (or another paragraph count): shown, paragraph by paragraph, without touching the others.
  const key = shown.join("\n");
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const changes =
      doc.lines !== shown.length
        ? [{ from: 0, to: doc.length, insert: key }]
        : shown.flatMap((text, k) => {
            const line = doc.line(k + 1);
            return line.text === text ? [] : [{ from: line.from, to: line.to, insert: text }];
          });
    if (changes.length > 0) v.dispatch({ changes, filter: false, annotations: Transaction.addToHistory.of(false) });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const line = current !== null && current < v.state.doc.lines ? v.state.doc.line(current + 1) : null;
    v.dispatch({ effects: setCurrent.of(line ? { from: line.from, to: line.to } : null) });
  }, [current, key]);
  useEffect(() => {
    const v = view.current;
    if (v && reveal && reveal.paragraph < v.state.doc.lines) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(reveal.paragraph + 1).from, { y: "nearest", yMargin: 24 }) });
  }, [reveal?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const issuesKey = JSON.stringify(issues);
  useEffect(() => {
    view.current?.dispatch({ effects: setIssues.of(issues) });
  }, [issuesKey, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const underlinesKey = JSON.stringify(underlines);
  useEffect(() => {
    view.current?.dispatch({ effects: setUnderlines.of(underlines) });
  }, [underlinesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="source-editor" ref={host} />;
}
