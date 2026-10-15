import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, Cross2Icon, MagnifyingGlassIcon, ReloadIcon } from "@radix-ui/react-icons";
import { Button, Callout, Flex, Heading, IconButton, Text, TextArea, TextField } from "@radix-ui/themes";
import { normalizeSource, occurrencesOf, paragraphsOf } from "@ltw/domain/pure";
import type { Word, Work } from "@ltw/domain";
import { api } from "./api";
import type { Activity } from "./Toolbar";
import { SourceEditor, type Hit } from "./SourceEditor";
import { NameRow, type ClassInfo, type TopicRef } from "./NameRow";
import { Pick } from "./Pick";
import { useToast } from "./Toast";
import type { SetupState } from "./setup";

const WIDTHS_KEY = "ltw.workspace.widths.v3";
const MIN = 0.1;
const DEFAULT_WIDTHS = [0.36, 0.32, 0.32];

const loadWidths = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "null") as unknown;
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && x >= MIN)) return v as number[];
  } catch {
    /* storage may be unavailable */
  }
  return DEFAULT_WIDTHS;
};

/**
 * The workspace: the source text, which is edited here and numbered by paragraph; what was read from the whole text (its glossary words
 * and who says each line of speech); and the translation, one box for each paragraph. The knowledge base opens as a drawer over it.
 */
export function Workspace({
  setup,
  documentId,
  text,
  onText,
  editorKey,
  knowledgeRev,
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
  /** Asks for the knowledge base to open, on a topic. */
  onKb: (kb: { open: boolean; request: { id: string; n: number } | null }) => void;
  /** What the model is doing for the user right now, in words; null when it is idle. */
  onActivity: (what: Activity | null) => void;
}) {
  const [work, setWork] = useState<Work | null>(null);
  const [working, setWorking] = useState<"read" | "translate" | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  useEffect(() => onActivity(activity), [activity]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null);
  const [modelName, setModelName] = useState(setup.models[0]?.name ?? "");
  // What is in the box of each paragraph of the translation while it is being edited.
  const [drafts, setDrafts] = useState<string[]>([]);
  // The paragraph being worked on: the one the cursor is in, in the source or in the translation.
  const [cur, setCur] = useState<number | null>(null);
  const [newTerm, setNewTerm] = useState("");
  const [widths, setWidths] = useState<number[]>(loadWidths);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [lineFocus, setLineFocus] = useState<number | null>(null);
  // The words whose details are open. It belongs here, not to each row, so a word that moves to another group keeps its place.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [hit, setHit] = useState(0);
  const [showIgnored, setShowIgnored] = useState(false);
  /** Words selected in the source: the button to add them to the glossary shows beside them. */
  const [selected, setSelected] = useState<{ text: string; left: number; bottom: number } | null>(null);
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [topics, setTopics] = useState<TopicRef[]>([]);
  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const lineItems = useRef<(HTMLLIElement | null)[]>([]);

  const model = setup.models.find((m) => m.name === modelName) ?? setup.models[0] ?? null;

  const call = async <T,>(run: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T | null> => {
    setError(null);
    const r = await run();
    if (!r.ok) {
      setError(r.error.message);
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
    setLineFocus(null);
    setOpened(new Set());
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

  // The word or line being looked at: where it stands in the text, for the source pane.
  const focused = words.find((n) => n.source === focus) ?? null;
  const lineHit = lineFocus !== null ? lineRanges[lineFocus] : null;
  const hits = lineFocus !== null ? (lineHit ? [lineHit] : []) : focused && work ? occurrencesOf(work.source, [focused.source, ...focused.aliases], sources) : [];
  const current = hits.length > 0 ? ((hit % hits.length) + hits.length) % hits.length : 0;
  const looking = lineFocus !== null ? `Line ${lineFocus + 1}` : (focused?.source ?? null);
  const look = (source: string) => {
    setLineFocus(null);
    setFocus((f) => (f === source ? null : source));
    setHit(0);
  };
  const toggleDetails = (source: string) =>
    setOpened((o) => {
      const next = new Set(o);
      if (!next.delete(source)) next.add(source);
      return next;
    });
  const lookAtLine = (i: number) => {
    setFocus(null);
    setLineFocus((f) => (f === i ? null : i));
    setHit(0);
  };
  const stopLooking = () => {
    setFocus(null);
    setLineFocus(null);
  };

  // The words of the glossary, found by the app: grouped by kind in the order of the classes file, in the order they appear in the text, and narrowed by the search.
  const q = filter.trim().toLocaleLowerCase();
  const kindLabel = (kind: string): string => classes.find((c) => c.name === kind)?.label ?? kind;
  // What a link can point to: the topics of the knowledge base, and the words of the text that are not in it yet.
  const linkTargets: TopicRef[] = [...topics, ...words.filter((n) => n.draft && !topics.some((t) => t.source === n.source)).map((n) => ({ source: n.source, english: n.english, category: n.kind }))];
  const shownNames = words.filter((n) => n.use !== false).filter((n) => q === "" || [n.source, n.english, kindLabel(n.kind), ...n.aliases].some((s) => s.toLocaleLowerCase().includes(q)));
  const firstAt = (n: Word): number => occurrencesOf(work?.source ?? "", [n.source, ...n.aliases], sources)[0]?.start ?? Number.MAX_SAFE_INTEGER;
  const kinds = [...new Set([...classes.map((c) => c.name), ...shownNames.map((n) => n.kind)])];
  const groups = kinds.map((kind) => ({ kind, names: shownNames.filter((n) => n.kind === kind).sort((a, b) => firstAt(a) - firstAt(b)) })).filter((g) => g.names.length > 0);
  const ignoredNames = words.filter((n) => n.use === false);
  const label = (p: { source: string; english: string }): string => (p.english.trim() !== "" ? `${p.english.trim()} (${p.source})` : p.source);

  const update = (run: () => Promise<{ ok: true; value: Work } | { ok: false; error: { message: string } }>) => void call(run).then((w) => w && setWork(w));

  /** Takes a word out of the glossary (and says so, with a way back): it is not found again in this text. */
  const removeWord = async (word: Word) => {
    const w = await call(() => api.invoke("work.removeWord", { source: word.source }));
    if (!w) return;
    setWork(w);
    setOpened((o) => new Set([...o].filter((x) => x !== word.source)));
    if (focus === word.source) stopLooking();
    toast({
      text: `Removed ${word.source} from the glossary.`,
      action: {
        label: "Undo",
        run: () => void call(() => api.invoke("work.undoRemove")).then((back) => back && setWork(back)),
      },
    });
  };

  /** Adds the selected words to the glossary and puts the cursor in the English name of the new row, ready to write it. */
  const addSelected = async () => {
    const word = selected?.text;
    if (!word) return;
    setSelected(null);
    const w = await call(() => api.invoke("work.addWord", { source: word }));
    if (!w) return;
    setWork(w);
    const label = `English name of ${word}`;
    setTimeout(() => (Array.from(document.querySelectorAll("input")).find((i) => i.getAttribute("aria-label") === label) as HTMLInputElement | undefined)?.focus(), 50);
  };

  const addTerm = async () => {
    const word = newTerm.trim();
    if (word === "") return;
    const w = await call(() => api.invoke("work.addWord", { source: word }));
    if (!w) return;
    setNewTerm("");
    setWork(w);
    const found = w.words.find((n) => n.source === word || n.aliases.includes(word));
    if (found?.id) onKb({ open: true, request: { id: found.id, n: Date.now() } });
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

  /** Translates the paragraphs one after the other. Without `redo` it carries on where it stopped (the paragraphs that have a translation are skipped). */
  const translate = async (redo: boolean) => {
    if (!work || !model) return;
    if (redo && done > 0 && !window.confirm(`Write all ${paragraphs.length} paragraphs again? Translations you wrote or changed are replaced.`)) return;
    setWorking("translate");
    const n = paragraphs.length;
    const saying = (finished: number) => `Translating with ${model.name}: paragraph ${Math.min(n, finished + 1)} of ${n}`;
    setActivity({ what: saying(redo ? 0 : done), stop: true });
    // The paragraphs are written one after the other in one request; the ones done so far are asked for while it goes on.
    const poll = setInterval(() => {
      void api.invoke("work.get").then((r) => {
        if (!r.ok || !r.value) return;
        setWork(r.value);
        setActivity({ what: saying(r.value.paragraphs.filter((p) => p.translation.trim() !== "").length), stop: true });
      });
    }, 1000);
    const w = await call(() => api.invoke("work.translate", { ...modelInput(), redo }));
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
    const before = JSON.stringify(work.words.filter((n) => !only || only.includes(n.source)).map((n) => [n.source, n.suggestions]));
    const w = await call(() => api.invoke("work.suggest", { ...modelInput(), ...(only ? { only } : {}) }));
    clearInterval(poll);
    // Asked for particular words and nothing new came back: say so, instead of leaving the row as it was.
    if (w && only && JSON.stringify(w.words.filter((n) => only.includes(n.source)).map((n) => [n.source, n.suggestions])) === before) {
      toast({ text: `The model did not find how ${only.length === 1 ? only[0] : "those words"} was written in the translation. You can write a suggestion yourself.` });
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

  /** Translates one paragraph again, keeping the others as they are. */
  const retranslate = async (paragraph: number) => {
    if (!work || !model) return;
    setWorking("translate");
    setActivity({ what: `Translating paragraph ${paragraph + 1} again with ${model.name}`, stop: true });
    const w = await call(() => api.invoke("work.retranslate", { ...modelInput(), paragraph }));
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
    if (!work || (drafts[paragraph] ?? "") === (paragraphs[paragraph]?.translation ?? "")) return;
    const w = await call(() => api.invoke("work.setPart", { paragraph, text: drafts[paragraph] ?? "" }));
    if (w) setWork(w);
  };

  // ---- the cursor: a paragraph in the source and its translation go together ----
  const [reveal, setReveal] = useState<{ at: number; n: number } | null>(null);
  const goTo = (k: number, from: "source" | "translation") => {
    setCur(k);
    if (from === "translation" && places[k]) setReveal({ at: places[k]!.start, n: Date.now() });
    if (from === "source") boxes.current[k]?.scrollIntoView({ block: "nearest" });
  };
  const cursorAt = (position: number) => {
    if (!inSync || places.length === 0) return;
    let index = 0;
    places.forEach((p, i) => {
      if (p.start <= position) index = i;
    });
    goTo(index, "source");
  };
  // The lines of speech of the paragraph being worked on are brought into view.
  useEffect(() => {
    const at = (work?.lines ?? []).findIndex((l) => l.paragraph === cur);
    if (at >= 0) lineItems.current[at]?.scrollIntoView({ block: "nearest" });
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const lines = work?.lines ?? [];

  return (
    <div className="guided">
      <Flex align="center" justify="between" gap="3" wrap="wrap" px="3" py="2" className="guided-bar">
        <Flex align="center" gap="3" wrap="wrap">
          <Text size="2" color="gray">
            {paragraphs.length === 0 ? "No text yet" : `${paragraphs.length} paragraphs · ${done} translated`}
          </Text>
          <Button size="2" onClick={() => void translate(false)} disabled={working !== null || !model || paragraphs.length === 0 || done === paragraphs.length}>
            {working === "translate" ? "Translating…" : done > 0 && done < paragraphs.length ? "Carry on translating" : "Translate"}
          </Button>
          {done > 0 && (
            <Button size="2" variant="soft" color="gray" onClick={() => void translate(true)} disabled={working !== null || !model} title="Write every paragraph again, with the glossary as it is now">
              Translate everything again
            </Button>
          )}
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
          <h3>Source</h3>
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
          {selected && !words.some((n) => n.source === selected.text) && (
            <Button className="select-add" size="1" style={{ left: Math.max(4, selected.left), top: selected.bottom + 6 }} onMouseDown={(e) => e.preventDefault()} onClick={() => void addSelected()}>
              Add {selected.text} to the glossary
            </Button>
          )}
          <div className="source-pane-editor">
            <SourceEditor key={editorKey} value={text} onChange={onText} placeholder="Paste or type the source text here." hits={editorHits} current={currentRange} onCursor={cursorAt} reveal={reveal} onSelect={setSelected} />
          </div>
        </section>

        <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the source and the reading" onPointerDown={beginDrag(0, 1)} />

        <section className="guided-pane">
          <h3>What was read</h3>
          {!work ? (
            <div className="guided-body">
              <Text as="p" size="2" color="gray">
                Paste or type the source text on the left. The words in it and who says each line show here.
              </Text>
            </div>
          ) : (
            <>
              <div className="guided-scroll">
                <Heading as="h4" size="2" mb="2">
                  Glossary of the text{" "}
                  <Text size="1" color="gray" weight="regular">
                    {words.length}
                  </Text>
                </Heading>
                {words.length === 0 && (
                  <Text as="p" size="1" color="gray">
                    Nothing from the glossary found in the text. Add a word from the text below.
                  </Text>
                )}
                {words.length > 0 && (
                  <TextField.Root size="2" mb="2" type="search" aria-label="Search the glossary" placeholder="Search this glossary" value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <TextField.Slot>
                      <MagnifyingGlassIcon />
                    </TextField.Slot>
                  </TextField.Root>
                )}
                {words.length > 0 && groups.length === 0 && (
                  <Text as="p" size="1" color="gray">
                    Nothing matches.
                  </Text>
                )}
                {groups.map((g) => (
                  <section key={g.kind} className="glossary-group">
                    <Text as="div" size="1" weight="bold" color="gray" mt="3" mb="1" className="group-title">
                      {kindLabel(g.kind)} · {g.names.length}
                    </Text>
                    <ul className="guided-glossary">
                      {g.names.map((n) => (
                        <NameRow
                          key={n.source}
                          name={n}
                          classes={classes}
                          topics={linkTargets}
                          expanded={opened.has(n.source)}
                          focused={focus === n.source}
                          onToggle={() => toggleDetails(n.source)}
                          onLocate={() => look(n.source)}
                          onRemove={() => void removeWord(n)}
                          onUse={(use) => update(() => api.invoke("work.setUse", { source: n.source, use }))}
                          onOpen={() => n.id && onKb({ open: true, request: { id: n.id, n: Date.now() } })}
                          onEnglish={(english) => update(() => api.invoke("work.setEnglish", { source: n.source, english }))}
                          onSuggestEnglish={(value) => update(() => api.invoke("work.setSuggestion", { source: n.source, key: "english", value }))}
                          onHint={(hint) => update(() => api.invoke("work.setHint", { source: n.source, hint }))}
                          onKind={(kind) => update(() => api.invoke("work.setKind", { source: n.source, kind }))}
                          onAttribute={(key, values) => update(() => api.invoke("work.setAttribute", { source: n.source, key, values }))}
                          canSuggest={readable(n)}
                          onSuggest={() => void suggest([n.source])}
                          onAcceptSuggestion={(key) => update(() => api.invoke("work.acceptSuggestion", { source: n.source, key }))}
                          onDismissSuggestion={(key) => update(() => api.invoke("work.dismissSuggestion", { source: n.source, key }))}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addTerm();
                  }}
                >
                  <Flex gap="2" mt="2">
                    <TextField.Root size="2" style={{ flex: 1 }} aria-label="Add a word from the text to the glossary" value={newTerm} placeholder="Add a word from the text" onChange={(e) => setNewTerm(e.target.value)} />
                    <Button size="2" variant="soft" type="submit" disabled={newTerm.trim() === ""}>
                      Add
                    </Button>
                  </Flex>
                </form>
                {ignoredNames.length > 0 && (
                  <section className="glossary-group">
                    <Button variant="ghost" color="gray" size="1" mt="3" onClick={() => setShowIgnored((v) => !v)} aria-expanded={showIgnored}>
                      {showIgnored ? <ChevronDownIcon /> : <ChevronRightIcon />} Ignored · {ignoredNames.length}
                    </Button>
                    {showIgnored && (
                      <ul className="guided-glossary">
                        {ignoredNames.map((n) => (
                          <NameRow
                            key={n.source}
                            name={n}
                            classes={classes}
                            topics={linkTargets}
                            expanded={false}
                            focused={false}
                            onToggle={() => undefined}
                            onLocate={() => look(n.source)}
                            onUse={(use) => update(() => api.invoke("work.setUse", { source: n.source, use }))}
                            onOpen={() => n.id && onKb({ open: true, request: { id: n.id, n: Date.now() } })}
                            onRemove={() => void removeWord(n)}
                            onEnglish={(english) => update(() => api.invoke("work.setEnglish", { source: n.source, english }))}
                          onSuggestEnglish={(value) => update(() => api.invoke("work.setSuggestion", { source: n.source, key: "english", value }))}
                            onHint={(hint) => update(() => api.invoke("work.setHint", { source: n.source, hint }))}
                            onKind={(kind) => update(() => api.invoke("work.setKind", { source: n.source, kind }))}
                            onAttribute={(key, values) => update(() => api.invoke("work.setAttribute", { source: n.source, key, values }))}
                            canSuggest={readable(n)}
                            onSuggest={() => void suggest([n.source])}
                            onAcceptSuggestion={(key) => update(() => api.invoke("work.acceptSuggestion", { source: n.source, key }))}
                            onDismissSuggestion={(key) => update(() => api.invoke("work.dismissSuggestion", { source: n.source, key }))}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                <Heading as="h4" size="2" mt="5" mb="2">
                  Who says each line{" "}
                  <Text size="1" color="gray" weight="regular">
                    {lines.length}
                  </Text>
                </Heading>
                {lines.length === 0 && (
                  <Text as="p" size="1" color="gray">
                    There are no lines of speech in the text.
                  </Text>
                )}
                <ul className="guided-lines">
                  {lines.map((l, i) => (
                    <li key={i} ref={(el) => void (lineItems.current[i] = el)} className={l.paragraph === cur ? "line-current" : undefined}>
                      <Button variant={lineFocus === i ? "soft" : "ghost"} color={lineFocus === i ? "indigo" : "gray"} size="1" onClick={() => lookAtLine(i)} aria-pressed={lineFocus === i} title={`Paragraph ${l.paragraph + 1}. Show where it is in the text: ${l.text}`} className="line-text">
                        <Text truncate size="2">
                          {l.text}
                        </Text>
                      </Button>
                      <Flex align="center" gap="1" className={l.speaker === null && l.suggested ? "speaker suggested-speaker" : "speaker"}>
                        <Pick
                          size="1"
                          label={`Speaker of line ${i + 1}`}
                          value={l.speaker ?? l.suggested ?? ""}
                          options={[{ value: "", label: "not known" }, ...people.map((p) => ({ value: p.source, label: l.speaker === null && l.suggested === p.source ? `${label(p)} · suggested` : label(p) }))]}
                          onChange={(v) => update(() => api.invoke("work.setSpeaker", { line: i, speaker: v === "" ? null : v }))}
                        />
                        {l.speaker === null && l.suggested && (
                          <IconButton variant="ghost" size="1" onClick={() => update(() => api.invoke("work.acceptSpeaker", { line: i }))} aria-label={`Confirm the suggested speaker of line ${i + 1}`} title="Confirm the suggested speaker">
                            <CheckIcon />
                          </IconButton>
                        )}
                      </Flex>
                    </li>
                  ))}
                </ul>
              </div>
              <Flex gap="2" wrap="wrap" p="3" className="guided-foot">
                <Button variant="soft" color="gray" onClick={() => void suggest()} disabled={working !== null || !model || done === 0} title="Ask the model to read the translation again for suggestions">
                  Suggest from the translation
                </Button>
              </Flex>
            </>
          )}
        </section>

        <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the reading and the translation" onPointerDown={beginDrag(1, 2)} />

        <section className="guided-pane">
          <h3>Translation</h3>
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
              <div className="guided-parts">
                {paragraphs.map((p, k) => (
                  <div key={k} ref={(el) => void (boxes.current[k] = el)} className={cur === k ? "part part-focus" : "part"}>
                    <Text size="1" color="gray" className="part-n" aria-hidden>
                      {k + 1}
                    </Text>
                    <div className="part-body">
                      <TextArea
                        className="part-text"
                        variant="soft"
                        aria-label={`Translation of paragraph ${k + 1}`}
                        placeholder="…"
                        value={drafts[k] ?? ""}
                        onFocus={() => goTo(k, "translation")}
                        onChange={(e) => setDrafts((d) => d.map((t, i) => (i === k ? e.target.value : t)))}
                        onBlur={() => void saveDraft(k)}
                        spellCheck={false}
                      />
                      {p.issue && (
                        <Text as="p" size="1" color="amber" role="status">
                          {p.issue}
                        </Text>
                      )}
                    </div>
                    <IconButton variant="ghost" size="1" color="gray" aria-label={`Translate paragraph ${k + 1} again`} title="Translate this paragraph again, with the glossary as it is now. The other paragraphs stay as they are." disabled={working !== null || !model} onClick={() => void retranslate(k)}>
                      <ReloadIcon />
                    </IconButton>
                  </div>
                ))}
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
    </div>
  );
}
