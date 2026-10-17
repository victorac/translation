import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDownIcon, ArrowUpIcon, ShuffleIcon, Cross2Icon, MagnifyingGlassIcon, PlusIcon, ReloadIcon } from "@radix-ui/react-icons";
import { Button, Callout, Flex, IconButton, Text, TextArea } from "@radix-ui/themes";
import { englishOf, normalizeSource, occurrencesOf, paragraphsOf, sourceMarks, translationMarks } from "@ltw/domain/pure";
import type { Word, Work } from "@ltw/domain";
import { api } from "./api";
import type { Activity } from "./Toolbar";
import { SourceEditor, type Hit, type NoteMark } from "./SourceEditor";
import { TranslationEditor, asLine } from "./TranslationEditor";
import type { EntryEvents, Match, Place, Selection, Speech, Underline } from "./editorShared";
import type { ClassInfo, TopicRef, WordActions } from "./NameRow";
import { Floating, LineEdit, WordEdit, WordPeek } from "./Cards";
import { KnowledgeDrawer } from "./KnowledgeDrawer";
import { TextGlossary } from "./TextGlossary";
import { Pick } from "./Pick";
import { useLog } from "./Log";
import { useToast } from "./Toast";
import type { SetupState } from "./setup";

const WIDTHS_KEY = "ltw.workspace.widths.v4";
const MIN = 0.15;
const DEFAULT_WIDTHS = [0.5, 0.5];
/** How long the pointer rests on a word before its card shows, and how long the card stays once the pointer has left. */
const PEEK_DELAY = 250;
const PEEK_LINGER = 200;

const loadWidths = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "null") as unknown;
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && x >= MIN)) return v as number[];
  } catch {
    /* storage may be unavailable */
  }
  return DEFAULT_WIDTHS;
};

/**
 * The workspace: the source text, which is edited here and numbered by paragraph, and its translation, a line for each paragraph. The
 * words of the glossary are underlined in both, with a card to read and change each; who says each line of speech is written before it
 * in the source. The knowledge base, with the glossary of the text, opens as a drawer over it.
 */
export function Workspace({
  setup,
  documentId,
  text,
  onText,
  editorKey,
  knowledgeRev,
  knowledgeCounts,
  kb,
  onKb,
  onActivity,
}: {
  setup: SetupState;
  documentId: string;
  text: string;
  onText: (text: string) => void;
  /** Changes when another document or project is opened, so the editor starts over. */
  editorKey: string;
  knowledgeRev: number;
  knowledgeCounts: { terms: number; notes: number; suggested: number };
  /** Whether the knowledge base is open, and on which topic. */
  kb: { open: boolean; request: { id: string; n: number } | null };
  /** Asks for the knowledge base to open (on a topic) or close. */
  onKb: (kb: { open: boolean; request: { id: string; n: number } | null }) => void;
  /** What the model is doing for the user right now, in words; null when it is idle. */
  onActivity: (what: Activity | null) => void;
}) {
  const [work, setWork] = useState<Work | null>(null);
  const [working, setWorking] = useState<"read" | "find" | "translate" | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  useEffect(() => onActivity(activity), [activity]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null);
  const [modelName, setModelName] = useState(setup.models[0]?.name ?? "");
  // What is in the box of each paragraph of the translation while it is being edited.
  const [drafts, setDrafts] = useState<string[]>([]);
  // The same, for saving a paragraph the moment the cursor leaves it, before the page has drawn the last keystroke.
  const draftsRef = useRef<string[]>([]);
  draftsRef.current = drafts;
  // The paragraph being worked on: the one the cursor is in, in the source or in the translation.
  const [cur, setCur] = useState<number | null>(null);
  const [widths, setWidths] = useState<number[]>(loadWidths);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [hit, setHit] = useState(0);
  /** The word whose card shows while the pointer rests on it, the word whose card is pinned to change it, and the line of speech whose speaker is being chosen. */
  const [peek, setPeek] = useState<{ source: string; place: Place } | null>(null);
  const [pinned, setPinned] = useState<{ source: string; place: Place } | null>(null);
  const [linePop, setLinePop] = useState<{ line: number; place: Place } | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Words selected in the source: the button to add them to the glossary shows beside them. */
  const [selected, setSelected] = useState<{ text: string; left: number; bottom: number } | null>(null);
  /** The note being written for a paragraph, in a box next to its number. */
  const [noteEdit, setNoteEdit] = useState<{ paragraph: number; left: number; bottom: number; draft: string } | null>(null);
  const toast = useToast();
  const { log } = useLog();
  const [topics, setTopics] = useState<TopicRef[]>([]);

  const model = setup.models.find((m) => m.name === modelName) ?? setup.models[0] ?? null;

  const call = async <T,>(run: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T | null> => {
    setError(null);
    const r = await run();
    if (!r.ok) {
      setError(r.error.message);
      log("error", r.error.message);
      return null;
    }
    return r.value;
  };

  /** Brings the work up to date with the text in the editor: its paragraphs, the words found in it and who says each line. */
  const sync = async () => {
    if (text.trim() === "") return;
    setWorking("read");
    setActivity({ what: "Reading the text", stop: false });
    const w = await call(() => api.invoke("work.sync", { documentId, text }));
    setActivity(null);
    setWorking(null);
    if (w) setWork(w);
  };

  // Another document or project: nothing of the one before is kept on screen.
  useEffect(() => {
    setWork(null);
    setDrafts([]);
    setCur(null);
    setFocus(null);
    setPeek(null);
    setPinned(null);
    setLinePop(null);
    setError(null);
  }, [editorKey]);
  // No text, no work to show.
  useEffect(() => {
    if (text.trim() === "") setWork(null);
  }, [text]);

  // The work always follows the text: made when it first appears, and brought up to date a moment after typing stops. A paragraph whose
  // text is unchanged keeps its translation.
  useEffect(() => {
    const timer = setTimeout(() => void sync(), work === null ? 0 : 600);
    return () => clearTimeout(timer);
  }, [text, documentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the glossary changes (a topic edited in the pane on the right), the words listed here follow it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void api.invoke("work.get").then((r) => r.ok && r.value && setWork(r.value));
  }, [knowledgeRev]);

  // What the choices on a word are made from: the kinds of topic and their attributes, and the topics a link can point to.
  useEffect(() => {
    void api.invoke("knowledge.files").then((r) => r.ok && setClasses(r.value.classes));
    void api.invoke("knowledge.list", { kind: "term" }).then((r) => r.ok && setTopics(r.value.entries.map((e) => ({ source: e.source, english: e.target, category: e.category }))));
  }, [knowledgeRev]);

  const paragraphs = work?.paragraphs ?? [];
  // What the translation says is wrong with a paragraph, and an error of the work itself, go to the log once each.
  const logged = useRef(new Set<string>());
  useEffect(() => {
    const found = [...(work?.paragraphs ?? []).flatMap((p, k) => (p.issue ? [`${k}:${p.issue}`] : [])), ...(work?.error ? [`error:${work.error}`] : [])];
    for (const key of found) {
      if (logged.current.has(key)) continue;
      logged.current.add(key);
      log(key.startsWith("error:") ? "error" : "warning", key.replace(/^(error|\d+):/, ""));
    }
  }, [work?.paragraphs, work?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const translations = paragraphs.map((p) => p.translation).join("\u0000");
  useEffect(() => {
    setDrafts(paragraphs.map((p) => p.translation));
  }, [translations]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- where things stand in the source ----
  const inSync = work !== null && normalizeSource(text) === work.source;
  const places = useMemo(() => paragraphsOf(work?.source ?? ""), [work?.source]);
  /** Where each line of speech stands in the text, in order. */
  const lineRanges = useMemo(() => {
    const at = new Map<number, number>();
    return (work?.lines ?? []).map((l) => {
      const p = places[l.paragraph];
      if (!p) return null;
      const from = at.get(l.paragraph) ?? 0;
      const i = p.text.indexOf(l.text, from);
      if (i < 0) return null;
      at.set(l.paragraph, i + l.text.length);
      return { start: p.start + i, end: p.start + i + l.text.length };
    });
  }, [work?.lines, places]);

  const words = work?.words ?? [];
  const sources = topics.map((t) => t.source);
  // Everyone who can speak: the people of the text, and every person of the knowledge base, even when the text never says their name.
  const people: { source: string; english: string }[] = [
    ...words.filter((n) => n.kind === "character" && n.use !== false),
    ...topics.filter((t) => t.category === "character" && !words.some((n) => n.source === t.source)),
  ];

  // The word being looked at: where it stands in the text, for the source pane.
  const focused = words.find((n) => n.source === focus) ?? null;
  const hits = focused && work ? occurrencesOf(work.source, [focused.source, ...focused.aliases], sources) : [];
  const current = hits.length > 0 ? ((hit % hits.length) + hits.length) % hits.length : 0;
  const looking = focused?.source ?? null;
  const look = (source: string) => {
    setFocus(source);
    setHit(0);
  };
  const stopLooking = () => setFocus(null);

  const kindLabel = (kind: string): string => classes.find((c) => c.name === kind)?.label ?? kind;
  // What a link can point to: the topics of the knowledge base, and the words of the text that are not in it yet.
  const linkTargets: TopicRef[] = [...topics, ...words.filter((n) => n.draft && !topics.some((t) => t.source === n.source)).map((n) => ({ source: n.source, english: n.english, category: n.kind }))];
  const placesOf = (n: Word) => occurrencesOf(work?.source ?? "", [n.source, ...n.aliases], sources);
  const firstAt = (n: Word): number => placesOf(n)[0]?.start ?? Number.MAX_SAFE_INTEGER;
  const label = (p: { source: string; english: string }): string => (p.english.trim() !== "" ? `${p.english.trim()} (${p.source})` : p.source);

  const update = (run: () => Promise<{ ok: true; value: Work } | { ok: false; error: { message: string } }>) => void call(run).then((w) => w && setWork(w));

  /**
   * Changes what kind of word it is. Made a person or a family with no name or suggestion yet, the dictionary is asked how it is read, as for
   * a name found in the text (a word that was not taken for a name has no such reading until it is one). No reading is not an error here.
   */
  const changeKind = async (source: string, kind: string) => {
    const set = await api.invoke("work.setKind", { source, kind });
    if (!set.ok || (kind !== "character" && kind !== "family")) return set;
    const word = set.value.words.find((x) => x.source === source);
    if (!word || word.english.trim() !== "" || (word.suggestions?.["english"] ?? []).length > 0) return set;
    const looked = await api.invoke("work.lookup", { source });
    return looked.ok ? looked : set;
  };

  /** A fixed English name becomes a suggestion again: it stays as text in the field, no longer forced on the model. */
  const loosen = async (word: Word) => {
    const first = await call(() => api.invoke("work.setEnglish", { source: word.source, english: "" }));
    if (!first) return;
    update(() => api.invoke("work.setSuggestion", { source: word.source, key: "english", value: word.english }));
  };

  /** A fixed speaker becomes a suggestion again: still chosen in the list, no longer told to the model. */
  const loosenSpeaker = async (line: number, speaker: string) => {
    const first = await api.invoke("work.setSpeaker", { line, speaker: null });
    if (!first.ok) return first;
    return api.invoke("work.setSpeakerSuggestion", { line, speaker });
  };

  /** Takes a word out of the glossary (and says so, with a way back): it is not found again in this text. */
  const removeWord = async (word: Word) => {
    const w = await call(() => api.invoke("work.removeWord", { source: word.source }));
    if (!w) return;
    setWork(w);
    if (pinned?.source === word.source) setPinned(null);
    if (focus === word.source) stopLooking();
    toast({
      text: `Removed ${word.source} from the glossary.`,
      action: {
        label: "Undo",
        run: () => void call(() => api.invoke("work.undoRemove")).then((back) => back && setWork(back)),
      },
    });
  };

  /** Adds the selected words to the glossary and pins the card of the new word next to them, ready to write its English name. */
  const addSelected = async () => {
    if (!selected) return;
    const { text: word, left, bottom } = selected;
    setSelected(null);
    const w = await call(() => api.invoke("work.addWord", { source: word }));
    if (!w) return;
    setWork(w);
    const found = w.words.find((n) => n.source === word || n.aliases.includes(word));
    if (found) setPinned({ source: found.source, place: { left, top: bottom - 20, bottom } });
  };

  /** Adds a word typed in the glossary of the text. */
  const addWord = async (word: string): Promise<boolean> => {
    const w = await call(() => api.invoke("work.addWord", { source: word }));
    if (!w) return false;
    setWork(w);
    return true;
  };

  // ---- translating ----
  const modelInput = () => ({
    backend: setup.backend,
    modelId: model!.name,
    contextLimit: model!.contextLimit,
    maxOutputTokens: model!.maxOutputTokens,
    temperature: model!.temperature,
    promptId: model!.promptId,
    sourceLanguage: setup.sourceLanguage,
    targetLanguage: setup.targetLanguage,
  });
  const done = paragraphs.filter((p) => p.translation.trim() !== "").length;

  // ---- reading the source with the model, for the names and terms the dictionary missed ----
  const unread = paragraphs.filter((p) => !(work?.searched ?? []).includes(p.text)).length;
  /** The text the last reading on its own failed for: it is not tried again by itself until the text changes. */
  const findFailed = useRef<string | null>(null);
  const find = async (auto = false) => {
    if (!work || !model) return;
    setWorking("find");
    const what = "Reading the source for names and terms";
    setActivity({ what, stop: true });
    const poll = setInterval(() => {
      void api.invoke("work.get").then((r) => {
        if (!r.ok || !r.value) return;
        setWork(r.value);
        if (r.value.reading) setActivity({ what: `${what}: passage ${Math.min(r.value.reading.done + 1, r.value.reading.total)} of ${r.value.reading.total}`, stop: true });
      });
    }, 1000);
    const r = await api.invoke("work.find", modelInput());
    clearInterval(poll);
    if (r.ok) setWork(r.value);
    else {
      // Done on its own, a failure (no model server running, say) is only logged; asked for, it is shown.
      if (auto) {
        findFailed.current = work.source;
        log("warning", `Could not read the source for names and terms: ${r.error.message}`);
      } else setError(r.error.message);
      void api.invoke("work.get").then((g) => g.ok && g.value && setWork(g.value));
    }
    setActivity(null);
    setWorking(null);
  };
  // A moment after the text settles, the paragraphs not read yet are read, unless the model is busy.
  useEffect(() => {
    if (!work || !model || working !== null || unread === 0 || findFailed.current === work.source) return;
    const timer = setTimeout(() => void find(true), 1500);
    return () => clearTimeout(timer);
  }, [work?.source, unread, model?.name, working]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Translates every paragraph, one after the other, writing again the ones that already have a translation. A single paragraph is written again with its own button. */
  const translate = async () => {
    if (!work || !model) return;
    setWorking("translate");
    const n = paragraphs.length;
    const saying = (finished: number) => `Translating with ${model.name}: paragraph ${Math.min(n, finished + 1)} of ${n}`;
    setActivity({ what: saying(0), stop: true });
    // The paragraphs are written one after the other in one request; the ones done so far are asked for while it goes on.
    const poll = setInterval(() => {
      void api.invoke("work.get").then((r) => {
        if (!r.ok || !r.value) return;
        setWork(r.value);
        setActivity({ what: saying(r.value.paragraphs.filter((p) => p.translation.trim() !== "").length), stop: true });
      });
    }, 1000);
    const w = await call(() => api.invoke("work.translate", { ...modelInput(), redo: true }));
    clearInterval(poll);
    if (w) setWork(w);
    else void api.invoke("work.get").then((r) => r.ok && r.value && setWork(r.value));
    setActivity(null);
    setWorking(null);
    // With the translation written, the model reads it for suggestions to fill in what was read.
    if (w && !w.error && w.paragraphs.some((p) => p.translation.trim() !== "")) await suggest();
  };

  /** Reads the translation for suggestions: how each name was written, genders and who says each line. Nothing is confirmed by it. */
  const suggest = async (only?: string[]) => {
    if (!work || !model) return;
    setWorking("translate");
    setActivity({ what: "Reading the translation for suggestions", stop: true });
    const poll = setInterval(() => {
      void api.invoke("work.get").then((r) => {
        if (!r.ok || !r.value) return;
        setWork(r.value);
        if (r.value.reading) setActivity({ what: `Reading the translation for suggestions: ${r.value.reading.done} of ${r.value.reading.total}`, stop: true });
      });
    }, 1000);
    const w = await call(() => api.invoke("work.suggest", { ...modelInput(), ...(only ? { only } : {}) }));
    clearInterval(poll);
    // What the model could not suggest, and why: said, so that a row left as it was is explained.
    if (w && (w.misses ?? []).length > 0) {
      const shown = w.misses!.slice(0, 3).join("; ");
      toast({ level: "warning", text: `No suggestion from the translation. ${shown}${w.misses!.length > 3 ? `; and ${w.misses!.length - 3} more` : ""}.` });
    }
    if (w) setWork(w);
    else void api.invoke("work.get").then((r) => r.ok && r.value && setWork(r.value));
    setActivity(null);
    setWorking(null);
  };

  /** The words that stand in a paragraph of the text. */
  const wordsIn = (k: number): string[] => words.filter((n) => n.use !== false && occurrencesOf(paragraphs[k]?.text ?? "", [n.source, ...n.aliases], sources).length > 0).map((n) => n.source);
  /** Whether the model can be asked about a word: some paragraph that has it is translated. */
  const readable = (n: Word): boolean => !!model && working === null && paragraphs.some((p, k) => p.translation.trim() !== "" && wordsIn(k).includes(n.source));

  /** Translates one paragraph again, keeping the others as they are; as an alternative, the model is asked for a version that differs from the one it has. */
  const retranslate = async (paragraph: number, alternative = false) => {
    if (!work || !model) return;
    setWorking("translate");
    setActivity({ what: alternative ? `Writing another version of paragraph ${paragraph + 1} with ${model.name}` : `Translating paragraph ${paragraph + 1} again with ${model.name}`, stop: true });
    const w = await call(() => api.invoke("work.retranslate", { ...modelInput(), paragraph, ...(alternative ? { alternative } : {}) }));
    if (w) setWork(w);
    else void api.invoke("work.get").then((r) => r.ok && r.value && setWork(r.value));
    setActivity(null);
    setWorking(null);
    // The model reads its new translation for the words of that paragraph, as after translating everything.
    const inIt = wordsIn(paragraph);
    if (w && !w.error && inIt.length > 0) await suggest(inIt);
  };

  /** The user's own text for one paragraph is kept when they leave its box. */
  const saveDraft = async (paragraph: number) => {
    const text = draftsRef.current[paragraph] ?? "";
    if (!work || text === asLine(paragraphs[paragraph]?.translation ?? "")) return;
    const w = await call(() => api.invoke("work.setPart", { paragraph, text }));
    if (w) setWork(w);
  };

  // ---- the cursor: a paragraph in the source and its translation go together ----
  const [reveal, setReveal] = useState<{ at: number; n: number } | null>(null);
  const [revealTranslation, setRevealTranslation] = useState<{ paragraph: number; n: number } | null>(null);
  const goTo = (k: number, from: "source" | "translation") => {
    setCur(k);
    if (from === "translation" && places[k]) setReveal({ at: places[k]!.start, n: Date.now() });
    if (from === "source") setRevealTranslation({ paragraph: k, n: Date.now() });
  };
  const editDraft = (paragraph: number, text: string) => {
    const next = draftsRef.current.map((t, i) => (i === paragraph ? text : t));
    draftsRef.current = next;
    setDrafts(next);
  };
  const cursorAt = (position: number) => {
    if (!inSync || places.length === 0) return;
    let index = 0;
    places.forEach((p, i) => {
      if (p.start <= position) index = i;
    });
    goTo(index, "source");
  };

  const noteMarks: NoteMark[] = inSync ? paragraphs.flatMap((p, k) => (p.note && places[k] ? [{ paragraph: k, at: places[k]!.start, text: p.note }] : [])) : [];
  const openNote = (paragraph: number, place: { left: number; bottom: number }) => {
    setSelected(null);
    setNoteEdit({ paragraph, ...place, draft: paragraphs[paragraph]?.note ?? "" });
  };
  const saveNote = async (note: string) => {
    if (!noteEdit) return;
    const w = await call(() => api.invoke("work.setNote", { paragraph: noteEdit.paragraph, note }));
    if (w) setWork(w);
    setNoteEdit(null);
  };

  // ---- the words of the glossary, underlined where they stand in the source and in the translation ----
  const sourceUnderlines: Underline[] | undefined = useMemo(() => (inSync && work ? sourceMarks(work.source, words).map((m) => ({ from: m.start, to: m.end, source: m.source, kind: m.kind, status: m.status })) : undefined), [inSync, work]); // eslint-disable-line react-hooks/exhaustive-deps
  const translationUnderlines: Underline[] = useMemo(() => {
    let at = 0;
    return drafts.flatMap((d) => {
      const line = asLine(d);
      const start = at;
      at += line.length + 1;
      return translationMarks(line, words).map((m) => ({ from: start + m.start, to: start + m.end, source: m.source, kind: m.kind, status: m.status }));
    });
  }, [drafts, work?.words]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- a selection in one text, and the words of the other text that stand for it ----
  /** Where each line of the translation starts in its editor. */
  const lineStarts = useMemo(() => {
    let at = 0;
    return drafts.map((d) => {
      const start = at;
      at += asLine(d).length + 1;
      return start;
    });
  }, [drafts]);
  type Side = "source" | "translation";
  /** What is selected in one text (a paragraph of it), and where it ends on the screen, for the button that finds its match. */
  const [sel, setSel] = useState<{ side: Side; paragraph: number; text: string; at: number; left: number; bottom: number } | null>(null);
  const [match, setMatch] = useState<{ side: Side; range: Match } | null>(null);
  const [matchState, setMatchState] = useState<{ side: Side; what: "asking" | "none" } | null>(null);
  const matchCache = useRef(new Map<string, { start: number; end: number } | null>());
  const matchToken = useRef(0);
  const onSourceRange = (r: Selection | null) => {
    const k = r && inSync ? places.findIndex((p) => p.start <= r.from && r.to <= p.end) : -1;
    const p = places[k];
    setSel(r && p && asLine(drafts[k] ?? "").trim() !== "" ? { side: "source", paragraph: k, text: p.text.slice(r.from - p.start, r.to - p.start), at: r.from - p.start, left: r.left, bottom: r.bottom } : null);
  };
  const onTranslationRange = (r: Selection | null) => {
    const k = r ? lineStarts.findIndex((start, i) => start <= r.from && r.to <= start + asLine(drafts[i] ?? "").length) : -1;
    setSel(r && k >= 0 && paragraphs[k] ? { side: "translation", paragraph: k, text: asLine(drafts[k]!).slice(r.from - lineStarts[k]!, r.to - lineStarts[k]!), at: r.from - lineStarts[k]!, left: r.left, bottom: r.bottom } : null);
  };
  /** A span of a paragraph of one text, as a range of its editor. */
  const rangeIn = (side: Side, k: number, span: { start: number; end: number }): Match | null => {
    const start = side === "source" ? places[k]?.start : lineStarts[k];
    return start === undefined ? null : { from: start + span.start, to: start + span.end };
  };
  /** A glossary word selected: where it stands in the other text is known from its underlines, without asking. */
  const knownMatch = (s: NonNullable<typeof sel>): Match | null => {
    const other: Side = s.side === "source" ? "translation" : "source";
    const mine = s.side === "source" ? (sourceUnderlines ?? []) : translationUnderlines;
    const start = s.side === "source" ? places[s.paragraph]!.start : lineStarts[s.paragraph]!;
    const picked = mine.find((u) => u.from === start + s.at && u.to === start + s.at + s.text.length);
    if (!picked) return null;
    const theirs = (other === "source" ? (sourceUnderlines ?? []) : translationUnderlines).filter((u) => u.source === picked.source);
    const lo = other === "source" ? places[s.paragraph]!.start : lineStarts[s.paragraph]!;
    const hi = other === "source" ? places[s.paragraph]!.end : lo + asLine(drafts[s.paragraph] ?? "").length;
    const inIt = theirs.filter((u) => lo <= u.from && u.to <= hi);
    return inIt[0] ? { from: inIt[0].from, to: inIt[0].to } : null;
  };
  type Selected = NonNullable<typeof sel>;
  const otherOf = (side: Side): Side => (side === "source" ? "translation" : "source");
  /** What a match is kept under: the selection, where it stands, and both texts as they are. */
  const matchKey = (s: Selected) => [s.side, paragraphs[s.paragraph]?.text ?? "", asLine(drafts[s.paragraph] ?? ""), s.text, s.at].join("\u0000");
  const showMatch = (s: Selected, span: { start: number; end: number } | null) => {
    const range = span ? rangeIn(otherOf(s.side), s.paragraph, span) : null;
    if (range) setMatch({ side: otherOf(s.side), range });
    else setMatchState({ side: otherOf(s.side), what: "none" });
  };
  // A selection shows its match by itself only when it is known without asking: a word of the glossary, from its underlines, or a
  // selection the model was asked about before. Otherwise the button next to it asks.
  useEffect(() => {
    ++matchToken.current;
    setMatch(null);
    setMatchState(null);
    const s = sel;
    if (!s || s.text.trim() === "") return;
    const timer = setTimeout(() => {
      const known = knownMatch(s);
      if (known) setMatch({ side: otherOf(s.side), range: known });
      else if (matchCache.current.has(matchKey(s))) showMatch(s, matchCache.current.get(matchKey(s))!);
    }, 150);
    return () => clearTimeout(timer);
  }, [sel?.side, sel?.paragraph, sel?.text, sel?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Asks the model for the match of the selection; what it says replaces what it said before for the same selection. */
  const askMatch = () => {
    const s = sel;
    if (!s || !model) return;
    const token = ++matchToken.current;
    const key = matchKey(s);
    setMatch(null);
    setMatchState({ side: otherOf(s.side), what: "asking" });
    void api.invoke("work.match", { ...modelInput(), side: s.side, selected: s.text, at: s.at, source: paragraphs[s.paragraph]?.text ?? "", translation: asLine(drafts[s.paragraph] ?? "") }).then((r) => {
      if (token !== matchToken.current) return; // the selection changed meanwhile
      setMatchState(null);
      if (r.ok) {
        matchCache.current.set(key, r.value);
        showMatch(s, r.value);
      } else {
        log("warning", `Could not match the selection: ${r.error.message}`);
        if (r.error.code === "busy") toast({ level: "warning", text: "The model is busy. Try again when it is done." });
      }
    });
  };
  /** The button next to a selection that the glossary does not already match: to find it in the other text, or find it again. */
  const matchButton = (side: Side) => {
    const s = sel;
    if (!s || s.side !== side || !model || s.text.trim() === "" || knownMatch(s)) return null;
    const asking = matchState?.what === "asking";
    return (
      <Button size="2" variant="ghost" color="gray" disabled={asking || working !== null} onMouseDown={(e) => e.preventDefault()} onClick={askMatch} title={`Ask the model which part of the ${otherOf(side)} matches the selection`}>
        {matchCache.current.has(matchKey(s)) ? <ReloadIcon /> : <MagnifyingGlassIcon />}
        {asking ? "Finding…" : `${matchCache.current.has(matchKey(s)) ? "Find again" : "Find"} in the ${otherOf(side)}`}
      </Button>
    );
  };

  const matchNote = (side: Side) =>
    matchState?.side === side ? <span className="match-status">{matchState.what === "asking" ? "finding the matching words…" : "no matching words found"}</span> : null;

  /** What can be done to a word, from its card or its row in the glossary of the text. */
  const actionsFor = (n: Word): WordActions => ({
    onLocate: () => {
      look(n.source);
      setPinned(null);
      if (kb.open) onKb({ open: false, request: null });
    },
    onUse: (use) => update(() => api.invoke("work.setUse", { source: n.source, use })),
    onOpen: () => {
      setPinned(null);
      if (n.id) onKb({ open: true, request: { id: n.id, n: Date.now() } });
    },
    onRemove: () => void removeWord(n),
    canSuggest: readable(n),
    onSuggest: () => void suggest([n.source]),
    onLookup: () => update(() => api.invoke("work.lookup", { source: n.source })),
    onEnglish: (english) => update(() => api.invoke("work.setEnglish", { source: n.source, english })),
    onSuggestEnglish: (value) => update(() => api.invoke("work.setSuggestion", { source: n.source, key: "english", value })),
    onLoosen: () => void loosen(n),
    onHint: (hint) => update(() => api.invoke("work.setHint", { source: n.source, hint })),
    onKind: (kind) => update(() => changeKind(n.source, kind)),
    onAttribute: (key, values) => update(() => api.invoke("work.setAttribute", { source: n.source, key, values })),
    onAcceptSuggestion: (key) => update(() => api.invoke("work.acceptSuggestion", { source: n.source, key })),
    onDismissSuggestion: (key) => update(() => api.invoke("work.dismissSuggestion", { source: n.source, key })),
  });

  // ---- the cards: one shows while the pointer rests on a word, and a click pins it to change the word ----
  const clearPeekTimer = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  const entryEvents: EntryEvents = {
    onHover: (h) => {
      clearPeekTimer();
      // While words are selected, a card would cover the buttons next to them.
      if (h && sel) return;
      if (h) peekTimer.current = setTimeout(() => setPeek(h), peek ? 0 : PEEK_DELAY);
      else peekTimer.current = setTimeout(() => setPeek(null), PEEK_LINGER);
    },
    onPin: (source, place) => {
      clearPeekTimer();
      setPeek(null);
      setLinePop(null);
      setPinned({ source, place });
    },
  };
  useEffect(() => clearPeekTimer, []);
  const peekWord = peek && peek.source !== pinned?.source ? byName(peek.source) : undefined;
  const pinnedWord = pinned ? byName(pinned.source) : undefined;
  function byName(source: string): Word | undefined {
    return words.find((n) => n.source === source);
  }

  // ---- who says each line: written before it in the source, in the colour of the speaker ----
  /** A speaker by their English name (a suggested one too), or as the text writes them. */
  const speakerName = (source: string): string => {
    const w = byName(source);
    const english = w ? englishOf(w) : (topics.find((t) => t.source === source)?.english.trim() ?? "");
    return english !== "" ? english : source;
  };
  const lines = work?.lines ?? [];
  const speakers = [...new Set(lines.map((l) => l.speaker ?? l.suggested ?? "").filter((x) => x !== ""))];
  const speech: Speech[] | undefined = inSync
    ? lines.flatMap((l, i) => {
        const r = lineRanges[i];
        if (!r) return [];
        const who = l.speaker ?? l.suggested ?? "";
        return [{ from: r.start, to: r.end, line: i, speaker: who === "" ? "" : speakerName(who), status: l.speaker !== null ? "fixed" : who !== "" ? "suggested" : "unknown", color: who === "" ? 0 : (speakers.indexOf(who) % 6) + 1 } as Speech];
      })
    : undefined;
  const openLine = (line: number, place: Place) => {
    setPinned(null);
    setPeek(null);
    setLinePop({ line, place });
  };

  const currentRange = inSync && cur !== null && places[cur] ? { from: places[cur]!.start, to: places[cur]!.end } : null;
  const editorHits: Hit[] = inSync ? hits.map((h, i) => ({ from: h.start, to: h.end, current: i === current })) : [];

  // ---- the panes and the handles between them ----
  const total = widths.reduce((sum, x) => sum + x, 0);
  const columns = widths.map((x, n) => `minmax(0, ${x / total}fr)${n < widths.length - 1 ? " 8px" : ""}`).join(" ");
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ left: number; right: number; start: number; widths: number[] } | null>(null);
  const beginDrag = (left: number, right: number) => (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { left, right, start: e.clientX, widths };
  };
  const moveDrag = (e: ReactPointerEvent) => {
    const d = drag.current;
    const width = box.current?.getBoundingClientRect().width;
    if (!d || !width) return;
    // The handle moves the edge between two panes: one grows as the other shrinks, and the others keep their width.
    const delta = ((e.clientX - d.start) / width) * total;
    const pair = d.widths[d.left]! + d.widths[d.right]!;
    const left = Math.min(Math.max(MIN, d.widths[d.left]! + delta), pair - MIN);
    const next = [...d.widths];
    next[d.left] = left;
    next[d.right] = pair - left;
    setWidths(next);
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
    } catch {
      /* the choice is only kept for this session */
    }
  };

  // Next to a selection in the source: the button to add it to the glossary (a short selection that is not a word of it yet), and the one to find its match.
  const addable = selected !== null && !words.some((n) => n.source === selected.text);
  const selectAt = sel?.side === "source" ? sel : null;
  /** The buttons go just under the end of the selection, kept inside the window. */
  const barAt = (at: { left: number; bottom: number }) => ({ left: Math.max(4, Math.min(at.left, window.innerWidth - 260)), top: at.bottom + 6 });

  return (
    <div className="guided">
      <Flex align="center" justify="between" gap="3" wrap="wrap" px="3" py="2" className="guided-bar">
        <Flex align="center" gap="3" wrap="wrap">
          <Text size="2" color="gray">
            {paragraphs.length === 0 ? "No text yet" : `${paragraphs.length} paragraphs · ${done} translated`}
          </Text>
          <Button size="2" onClick={() => void translate()} disabled={working !== null || !model || paragraphs.length === 0}>
            {working === "translate" ? "Translating…" : "Translate"}
          </Button>
          <Button size="2" variant="ghost" color="gray" onClick={() => void find()} disabled={working !== null || !model || unread === 0} title={unread === 0 ? "Every paragraph has been read for names and terms. A changed or new paragraph is read again by itself." : `Ask the model for the names and terms of the ${unread} paragraphs not read yet, and what kind each is`}>
            {working === "find" ? "Reading…" : "Find names"}
          </Button>
          <Button size="2" variant="ghost" color="gray" onClick={() => void suggest()} disabled={working !== null || !model || done === 0} title="Ask the model to read the translation again for suggestions: English names, genders and who says each line">
            Suggest from the translation
          </Button>
        </Flex>
        <Flex align="center" gap="2">
          <Text size="1" color="gray">
            Model
          </Text>
          <Pick size="1" label="Model" value={model?.name ?? ""} placeholder="Add a model" options={setup.models.map((m) => ({ value: m.name, label: m.name }))} onChange={setModelName} />
        </Flex>
      </Flex>
      {error && (
        <Callout.Root color="red" size="1" m="2">
          <Flex align="center" justify="between" gap="3">
            <Callout.Text>{error}</Callout.Text>
            <Button variant="ghost" size="1" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </Flex>
        </Callout.Root>
      )}

      <div className="guided-cols" ref={box} style={{ gridTemplateColumns: columns }} onPointerMove={moveDrag} onPointerUp={endDrag}>
        <section className="guided-pane">
          <h3>Source{matchNote("source")}</h3>
          {looking !== null && (
            <Flex align="center" justify="between" gap="2" px="3" py="1" className="source-find">
              <Text size="2" weight="bold">
                {looking}
              </Text>
              <Text size="1" color="gray">
                {hits.length === 0 ? "not found in the text" : hits.length === 1 ? "1 place" : `${current + 1} of ${hits.length}`}
              </Text>
              <Flex gap="1">
                <IconButton variant="ghost" size="1" color="gray" onClick={() => setHit(current - 1)} disabled={hits.length < 2} aria-label="Previous place">
                  <ArrowUpIcon />
                </IconButton>
                <IconButton variant="ghost" size="1" color="gray" onClick={() => setHit(current + 1)} disabled={hits.length < 2} aria-label="Next place">
                  <ArrowDownIcon />
                </IconButton>
                <IconButton variant="ghost" size="1" color="gray" onClick={stopLooking} aria-label="Stop looking">
                  <Cross2Icon />
                </IconButton>
              </Flex>
            </Flex>
          )}
          {(addable || matchButton("source")) && (selectAt ?? selected) && (
            <Flex direction="column" gap="0" className="select-bar" role="menu" aria-label="What to do with the selection" style={barAt(selectAt ?? selected!)}>
              {addable && (
                <Button className="select-add" size="2" variant="ghost" color="gray" onMouseDown={(e) => e.preventDefault()} onClick={() => void addSelected()}>
                  <PlusIcon />
                  <span>Add</span>
                  <span className="select-add-word">{selected.text}</span>
                  <span>to the glossary</span>
                </Button>
              )}
              {matchButton("source")}
            </Flex>
          )}
          {noteEdit && (
            <form
              className="note-box"
              style={{ left: Math.max(4, Math.min(noteEdit.left, window.innerWidth - 360)), top: noteEdit.bottom + 6 }}
              onSubmit={(e) => {
                e.preventDefault();
                void saveNote(noteEdit.draft);
              }}
              onKeyDown={(e) => e.key === "Escape" && setNoteEdit(null)}
            >
              <Text as="label" size="1" weight="bold" htmlFor="note-draft">
                Note from paragraph {noteEdit.paragraph + 1} on
              </Text>
              <Text as="p" size="1" color="gray" mb="1">
                Who tells the story from here, whose point of view, a letter or a flashback. It is sent with this paragraph and the ones after it, until the next note.
              </Text>
              <TextArea
                id="note-draft"
                size="1"
                autoFocus
                value={noteEdit.draft}
                placeholder="Told by Noah, in the first person."
                onChange={(e) => setNoteEdit({ ...noteEdit, draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void saveNote(noteEdit.draft);
                  }
                }}
              />
              <Flex gap="2" mt="2" justify="end">
                {(paragraphs[noteEdit.paragraph]?.note ?? "") !== "" && (
                  <Button type="button" size="1" variant="soft" color="red" onClick={() => void saveNote("")}>
                    Remove
                  </Button>
                )}
                <Button type="button" size="1" variant="soft" color="gray" onClick={() => setNoteEdit(null)}>
                  Cancel
                </Button>
                <Button type="submit" size="1">
                  Save
                </Button>
              </Flex>
            </form>
          )}
          <div className="source-pane-editor">
            <SourceEditor key={editorKey} value={text} onChange={onText} placeholder="Paste or type the source text here." hits={editorHits} current={currentRange} onCursor={cursorAt} reveal={reveal} onSelect={setSelected} notes={noteMarks} {...(inSync ? { onNote: openNote } : {})} {...(sourceUnderlines ? { underlines: sourceUnderlines } : {})} {...(speech ? { speech } : {})} onLine={openLine} entries={entryEvents} onRange={onSourceRange} match={match?.side === "source" ? match.range : null} />
          </div>
        </section>

        <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the source and the translation" onPointerDown={beginDrag(0, 1)} />

        <section className="guided-pane">
          <h3>Translation{matchNote("translation")}</h3>
          {!work ? (
            <div className="guided-body">
              <Text as="p" size="2" color="gray">
                The translation appears here, one box for each paragraph.
              </Text>
            </div>
          ) : done === 0 && working !== "translate" ? (
            <div className="guided-body">
              <Text as="p" size="2" color="gray">
                The translation appears here when you translate the text.
              </Text>
            </div>
          ) : (
            <>
              {cur !== null && paragraphs[cur] && (
                <Flex align="center" justify="between" gap="2" wrap="wrap" px="3" py="1" className="source-find">
                  <Text size="1" color="gray" wrap="nowrap">
                    Paragraph {cur + 1}
                  </Text>
                  <Flex gap="3" wrap="wrap">
                    <Button variant="ghost" size="1" color="gray" title="Translate this paragraph again, with the glossary as it is now. The other paragraphs stay as they are." disabled={working !== null || !model} onClick={() => void retranslate(cur)}>
                      <ReloadIcon /> Translate again
                    </Button>
                    <Button variant="ghost" size="1" color="gray" title="Ask for an alternative: a different translation from this one. The other paragraphs stay as they are." disabled={working !== null || !model || paragraphs[cur]!.translation.trim() === ""} onClick={() => void retranslate(cur, true)}>
                      <ShuffleIcon /> Another version
                    </Button>
                  </Flex>
                </Flex>
              )}
              {sel?.side === "translation" && matchButton("translation") && (
                <Flex direction="column" gap="0" className="select-bar" role="menu" aria-label="What to do with the selection" style={barAt(sel)}>
                  {matchButton("translation")}
                </Flex>
              )}
              <div className="source-pane-editor">
                <TranslationEditor
                  key={editorKey}
                  lines={drafts}
                  onEdit={editDraft}
                  onLeave={(k) => void saveDraft(k)}
                  onCursor={(k) => goTo(k, "translation")}
                  current={cur}
                  reveal={revealTranslation}
                  issues={paragraphs.map((p) => p.issue)}
                  underlines={translationUnderlines}
                  entries={entryEvents}
                  onRange={onTranslationRange}
                  match={match?.side === "translation" ? match.range : null}
                />
              </div>
              {work.error && (
                <Text as="p" size="1" color="red" mx="3" role="status">
                  {work.error}
                </Text>
              )}
            </>
          )}
        </section>

      </div>

      {peekWord && peek && (
        <Floating place={peek.place} pinned={false} onClose={() => setPeek(null)} onEnter={clearPeekTimer} onLeave={() => entryEvents.onHover?.(null)} label={`About ${peekWord.source}`}>
          <WordPeek word={peekWord} kindLabel={kindLabel(peekWord.kind)} places={placesOf(peekWord).length} />
        </Floating>
      )}
      {pinnedWord && pinned && (
        <Floating place={pinned.place} pinned onClose={() => setPinned(null)} label={`Change ${pinnedWord.source}`}>
          <WordEdit word={pinnedWord} kindLabel={kindLabel(pinnedWord.kind)} places={placesOf(pinnedWord).length} classes={classes} topics={linkTargets} actions={actionsFor(pinnedWord)} onClose={() => setPinned(null)} />
        </Floating>
      )}
      {linePop && lines[linePop.line] && (
        <Floating place={linePop.place} pinned onClose={() => setLinePop(null)} label={`Who says line ${linePop.line + 1}`}>
          <LineEdit
            line={lines[linePop.line]!}
            index={linePop.line}
            people={people.map((p) => ({ value: p.source, label: label(p) }))}
            // A speaker that is fixed stays fixed when it is changed; otherwise what is chosen is a suggestion until it is fixed.
            onSpeaker={(v) => {
              const i = linePop.line;
              const l = lines[i]!;
              update(() => (l.speaker !== null ? api.invoke("work.setSpeaker", { line: i, speaker: v === "" ? null : v }) : api.invoke("work.setSpeakerSuggestion", { line: i, speaker: v === "" ? null : v })));
            }}
            onFix={() => {
              const i = linePop.line;
              const l = lines[i]!;
              update(() => (l.speaker === null ? api.invoke("work.acceptSpeaker", { line: i }) : loosenSpeaker(i, l.speaker!)));
            }}
            onClose={() => setLinePop(null)}
          />
        </Floating>
      )}

      <KnowledgeDrawer
        open={kb.open}
        request={kb.request}
        rev={knowledgeRev}
        counts={knowledgeCounts}
        onClose={() => onKb({ open: false, request: null })}
        {...(work
          ? {
              inText: {
                count: words.length,
                content: <TextGlossary words={words} classes={classes} topics={linkTargets} kindLabel={kindLabel} firstAt={firstAt} focus={focus} actionsFor={actionsFor} onAdd={addWord} />,
              },
            }
          : {})}
      />
    </div>
  );
}
