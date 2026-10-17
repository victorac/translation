import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

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
  /** The source of the word: which entry it is. */
  source: string;
  kind: string;
  status: "fixed" | "suggested" | "ignored";
}

/**
 * A kind of topic as class names: its own (a kind the user made up may have any letters in it), and one of a few colours picked from its
 * name, for a kind that has no colour of its own.
 */
export const kindClass = (kind: string): string => {
  let hash = 0;
  for (const ch of kind) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return `cm-entry-k-${kind.toLocaleLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-")} cm-entry-h${hash % 6}`;
};

export const setUnderlines = StateEffect.define<readonly Underline[]>();
export const underlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setUnderlines)) continue;
      const length = tr.state.doc.length;
      const marks = e.value
        .filter((u) => u.from < u.to && u.to <= length)
        .map((u) => Decoration.mark({ class: `cm-entry ${kindClass(u.kind)} cm-entry-${u.status}`, attributes: { "data-source": u.source } }).range(u.from, u.to));
      return Decoration.set(marks, true);
    }
    // While the text is being typed the underlines move with it, until they are worked out again.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Where the pointer is, in window coordinates: what a card is put next to. */
export interface Place {
  left: number;
  top: number;
  bottom: number;
}
const placeOf = (el: Element): Place => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom };
};

/** What the pointer does on the words of the glossary in an editor: rests on one (or leaves it), or clicks one. */
export interface EntryEvents {
  onHover?: (hover: { source: string; place: Place } | null) => void;
  onPin?: (source: string, place: Place) => void;
}

export function entryEvents(events: { current: EntryEvents }) {
  return EditorView.domEventHandlers({
    mouseover: (event) => {
      const el = (event.target as HTMLElement).closest<HTMLElement>(".cm-entry");
      events.current.onHover?.(el?.dataset["source"] ? { source: el.dataset["source"], place: placeOf(el) } : null);
      return false;
    },
    mouseleave: () => {
      events.current.onHover?.(null);
      return false;
    },
    // A click on a word (not the end of a selection) pins its card; the cursor goes there as well.
    click: (event, view) => {
      const el = (event.target as HTMLElement).closest<HTMLElement>(".cm-entry");
      if (!el?.dataset["source"] || !view.state.selection.main.empty) return false;
      events.current.onPin?.(el.dataset["source"], placeOf(el));
      return false;
    },
  });
}

/** A line of speech in the source, and who says it: tinted in the colour of its speaker, with their name before it. */
export interface Speech {
  from: number;
  to: number;
  /** Which line of speech it is (index from 0). */
  line: number;
  /** Who says it, as shown; empty when not known. */
  speaker: string;
  status: "fixed" | "suggested" | "unknown";
  /** One of a few colours, the same for each line of one speaker. */
  color: number;
}

class SpeakerWidget extends WidgetType {
  constructor(readonly speech: Speech) {
    super();
  }
  eq(other: SpeakerWidget): boolean {
    const a = this.speech;
    const b = other.speech;
    return a.line === b.line && a.speaker === b.speaker && a.status === b.status && a.color === b.color;
  }
  toDOM(): HTMLElement {
    const s = this.speech;
    const el = document.createElement("span");
    el.className = `cm-speaker cm-speaker-${s.status} cm-speech-c${s.color}`;
    el.dataset["line"] = String(s.line);
    el.textContent = s.speaker === "" ? "who?" : s.speaker;
    el.title = s.status === "unknown" ? "Who says this line? Click to choose." : s.status === "suggested" ? `Said by ${s.speaker}, suggested. Click to change it or fix it.` : `Said by ${s.speaker}. Click to change it.`;
    return el;
  }
  ignoreEvent(): boolean {
    // The editor passes the click on, to open the choice of speaker.
    return false;
  }
}

export const setSpeech = StateEffect.define<readonly Speech[]>();
export const speechField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSpeech)) continue;
      const length = tr.state.doc.length;
      const marks = e.value
        .filter((s) => s.from < s.to && s.to <= length)
        .flatMap((s) => [
          Decoration.widget({ widget: new SpeakerWidget(s), side: -1 }).range(s.from),
          Decoration.mark({ class: `cm-speech cm-speech-${s.status} cm-speech-c${s.color}` }).range(s.from, s.to),
        ]);
      return Decoration.set(marks, true);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** A click on the name before a line of speech: the place to open the choice of who says it. */
export function speakerEvents(onLine: { current: ((line: number, place: Place) => void) | undefined }) {
  return EditorView.domEventHandlers({
    mousedown: (event) => {
      const el = (event.target as HTMLElement).closest<HTMLElement>(".cm-speaker");
      if (!el || !onLine.current) return false;
      onLine.current(Number(el.dataset["line"]), placeOf(el));
      event.preventDefault();
      return true;
    },
  });
}

/** The words of this text that stand for what is selected in the other one: highlighted, and brought into view. */
export interface Match {
  from: number;
  to: number;
}
export const setMatch = StateEffect.define<Match | null>();
export const matchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setMatch)) continue;
      const m = e.value;
      return m && m.from < m.to && m.to <= tr.state.doc.length ? Decoration.set([Decoration.mark({ class: "cm-match" }).range(m.from, m.to)]) : Decoration.none;
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** What is selected in an editor, and where it ends on the screen (window coordinates), for a button next to it. */
export interface Selection extends Match {
  left: number;
  bottom: number;
}

/** The selection of an editor as it is now, or null when nothing is selected or it is out of view. */
export function selectionOf(view: EditorView): Selection | null {
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const at = view.coordsAtPos(to);
  return at ? { from, to, left: at.left, bottom: at.bottom } : null;
}

/** Shows a match in an editor (or takes it away), bringing it into view without moving the selection. */
export function showMatch(view: EditorView | null, match: Match | null): void {
  if (!view) return;
  const ok = match && match.to <= view.state.doc.length;
  view.dispatch({ effects: ok ? [setMatch.of(match), EditorView.scrollIntoView(match.from, { y: "nearest", yMargin: 32 })] : [setMatch.of(null)] });
}
