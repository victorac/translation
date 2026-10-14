import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, Cross2Icon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { Button, Callout, Flex, Heading, IconButton, Text, TextArea, TextField } from "@radix-ui/themes";
import { estimateTokens, normalizeSource, occurrencesOf } from "@ltw/domain/pure";
import type { GuidedName, GuidedState } from "@ltw/domain";
import { api } from "./api";
import type { PreviewBlock } from "./blockMarkers";
import { KnowledgeFiles } from "./KnowledgeFiles";
import { SourceEditor, type Hit } from "./SourceEditor";
import { NameRow, type ClassInfo, type TopicRef } from "./NameRow";
import { Pick } from "./Pick";
import type { SetupState } from "./setup";

const WIDTHS_KEY = "ltw.workspace.widths.v1";
const MIN = 0.1;
const DEFAULT_WIDTHS = [0.3, 0.27, 0.23, 0.2];

const loadWidths = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "null") as unknown;
    if (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && x >= MIN)) return v as number[];
  } catch {
    /* storage may be unavailable */
  }
  return DEFAULT_WIDTHS;
};

/**
 * The workspace: the source text, which is edited here and shown cut into blocks; what was read from the block being worked on
 * (its glossary words, the narrator and who says each line); and its translation. The knowledge base opens as a pane on the right.
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
}: {
  setup: SetupState;
  documentId: string;
  text: string;
  onText: (text: string) => void;
  /** Changes when another document or project is opened, so the editor starts over. */
  editorKey: string;
  knowledgeRev: number;
  knowledgeCounts: { terms: number; notes: number; suggested: number };
  /** Whether the knowledge base pane is showing, and the topic it was asked to open. */
  kb: { open: boolean; request: { id: string; n: number } | null };
  onKb: (kb: { open: boolean; request: { id: string; n: number } | null }) => void;
}) {
  const [state, setState] = useState<GuidedState | null>(null);
  const [working, setWorking] = useState<"read" | "translate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelName, setModelName] = useState(setup.models[0]?.name ?? "");
  const [translation, setTranslation] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [widths, setWidths] = useState<number[]>(loadWidths);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [lineFocus, setLineFocus] = useState<number | null>(null);
  // The words whose details are open. It belongs here, not to each row, so a word that moves to another group keeps its place.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [hit, setHit] = useState(0);
  const [filter, setFilter] = useState("");
  // The cursor was put in a block by the user; the editor then does not need to scroll to it.
  const fromCursor = useRef(false);
  const [topics, setTopics] = useState<TopicRef[]>([]);

  const model = setup.models.find((m) => m.name === modelName) ?? setup.models[0] ?? null;
  const block = state ? state.blocks[state.current] : undefined;
  const base = block?.interpretation ?? null;

  const call = async <T,>(run: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T | null> => {
    setError(null);
    const r = await run();
    if (!r.ok) {
      setError(r.error.message);
      return null;
    }
    return r.value;
  };

  const read = async (index: number) => {
    setWorking("read");
    const s = await call(() => api.invoke("guided.interpret", { index }));
    setWorking(null);
    if (s) setState(s);
  };

  /** Makes the blocks from the text in the editor, or brings them up to date with it, and reads every block that has not been read. */
  const sync = async () => {
    if (text.trim() === "") return;
    setWorking("read");
    const made = await call(() => api.invoke("guided.sync", { documentId, text, blockSize: setup.blockSize }));
    if (made) {
      setState(made);
      const all = await call(() => api.invoke("guided.readAll"));
      if (all) setState(all);
    }
    setWorking(null);
  };

  // The blocks always follow the text: made when it first appears, and brought up to date a moment after typing stops. A block whose
  // text is unchanged keeps its work.
  useEffect(() => {
    const timer = setTimeout(() => void sync(), state === null ? 0 : 600);
    return () => clearTimeout(timer);
  }, [text, setup.blockSize, documentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the glossary changes (a topic edited in the pane on the right), the names listed here follow it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void api.invoke("guided.get").then((r) => r.ok && r.value && setState(r.value));
  }, [knowledgeRev]);

  // What the choices on a name are made from: the kinds of topic and their attributes, and the topics a link can point to.
  useEffect(() => {
    void api.invoke("knowledge.files").then((r) => r.ok && setClasses(r.value.classes));
    void api.invoke("knowledge.list", { kind: "term" }).then((r) => r.ok && setTopics(r.value.entries.map((e) => ({ source: e.source, english: e.target, category: e.category }))));
  }, [knowledgeRev]);

  useEffect(() => {
    setTranslation(block?.translation ?? "");
  }, [state?.current, block?.translation]); // eslint-disable-line react-hooks/exhaustive-deps

  const people = (base?.names ?? []).filter((n) => n.kind === "character" && n.use !== false);

  // The word being looked at: where it stands in the block, for the source pane.
  const focused = base?.names.find((n) => n.source === focus) ?? null;
  // Where each line of speech stands in the text, in order.
  const lineRanges = (() => {
    let at = 0;
    return (base?.lines ?? []).map((l) => {
      const i = (block?.text ?? "").indexOf(l.text, at);
      if (i < 0) return null;
      at = i + l.text.length;
      return { start: i, end: at };
    });
  })();
  const lineHit = lineFocus !== null ? lineRanges[lineFocus] : null;
  const hits = lineFocus !== null ? (lineHit ? [lineHit] : []) : focused && block ? occurrencesOf(block.text, [focused.source, ...focused.aliases], topics.map((t) => t.source)) : [];
  const current = hits.length > 0 ? ((hit % hits.length) + hits.length) % hits.length : 0;
  const looking = lineFocus !== null ? `Line ${lineFocus + 1}` : (focused?.source ?? null);
  useEffect(() => {
    setFocus(null);
    setLineFocus(null);
    setHit(0);
  }, [state?.current]);
  const look = (source: string) => {
    setLineFocus(null);
    setFocus((f) => (f === source ? null : source));
    setOpened((o) => {
      const next = new Set(o);
      if (!next.delete(source)) next.add(source);
      return next;
    });
    setHit(0);
  };
  const lookAtLine = (i: number) => {
    setFocus(null);
    setLineFocus((f) => (f === i ? null : i));
    setHit(0);
  };
  const stopLooking = () => {
    setFocus(null);
    setLineFocus(null);
  };

  // The words of this block's glossary, found by the app: grouped by kind in the order of the classes file, in the order they appear in the text, and narrowed by the search.
  const q = filter.trim().toLocaleLowerCase();
  const kindLabel = (kind: string): string => classes.find((c) => c.name === kind)?.label ?? kind;
  // What a link can point to: the topics of the knowledge base, and the words of this block that are not in it yet.
  const linkTargets: TopicRef[] = [...topics, ...(base?.names ?? []).filter((n) => n.draft && !topics.some((t) => t.source === n.source)).map((n) => ({ source: n.source, english: n.english, category: n.kind }))];
  const shownNames = (base?.names ?? []).filter((n) => q === "" || [n.source, n.english, kindLabel(n.kind), ...n.aliases].some((s) => s.toLocaleLowerCase().includes(q)));
  const firstAt = (n: GuidedName): number => occurrencesOf(block?.text ?? "", [n.source, ...n.aliases], topics.map((t) => t.source))[0]?.start ?? Number.MAX_SAFE_INTEGER;
  const kinds = [...new Set([...classes.map((c) => c.name), ...shownNames.map((n) => n.kind)])];
  const groups = kinds.map((kind) => ({ kind, names: shownNames.filter((n) => n.kind === kind).sort((a, b) => firstAt(a) - firstAt(b)) })).filter((g) => g.names.length > 0);
  const label = (p: GuidedName): string => (p.english.trim() !== "" ? `${p.english.trim()} (${p.source})` : p.source);
  const speakers = (base?.lines ?? []).map((l) => l.speaker);

  /** Saves the narrator and speakers as chosen. With `fill`, lines whose speaker is not known yet are worked out by the app. */
  const choose = async (narrator: string | null, who: (string | null)[], fill: boolean) => {
    if (!block || !base) return;
    const s = await call(() => api.invoke("guided.save", { index: block.index, narrator, speakers: who, fill }));
    if (s) setState(s);
  };

  const addTerm = async () => {
    const word = newTerm.trim();
    if (!block || word === "") return;
    const s = await call(() => api.invoke("guided.addName", { index: block.index, source: word }));
    if (!s) return;
    setNewTerm("");
    setState(s);
    const name = s.blocks[block.index]?.interpretation?.names.find((n) => n.source === word || n.aliases.includes(word));
    if (name?.id) onKb({ open: true, request: { id: name.id, n: Date.now() } });
  };

  const go = async (index: number) => {
    if (!state || index < 0 || index >= state.blocks.length) return;
    const s = await call(() => api.invoke("guided.go", { index }));
    if (!s) return;
    setState(s);
    if (s.blocks[index]!.status === "new") await read(index);
  };

  const translate = async () => {
    if (!state || !block || !model || !base) return;
    setWorking("translate");
    const s = await call(() =>
      api.invoke("guided.translate", {
        index: block.index,
        backend: setup.backend,
        modelId: model.name,
        contextLimit: model.contextLimit,
        maxOutputTokens: model.maxOutputTokens,
        temperature: model.temperature,
        promptId: model.promptId,
        sourceLanguage: setup.sourceLanguage,
        targetLanguage: setup.targetLanguage,
      }),
    );
    if (s) setState(s);
    else void api.invoke("guided.get").then((r) => r.ok && r.value && setState(r.value));
    setWorking(null);
  };

  const saveTranslation = async () => {
    if (!block || translation === block.translation) return;
    const s = await call(() => api.invoke("guided.setTranslation", { index: block.index, text: translation }));
    if (s) setState(s);
  };

  // ---- the source, shown as blocks in the editor ----
  const view: GuidedState = state ?? { documentId, blocks: [], current: 0 };
  const inSync = state !== null && state.source !== undefined && normalizeSource(text) === state.source;
  const starts: number[] = [];
  {
    let at = 0;
    for (const b of view.blocks) {
      starts.push(at);
      at += b.text.length;
    }
  }
  const editorBlocks: PreviewBlock[] | null = inSync ? view.blocks.map((b) => ({ index: b.index, text: b.text, estimatedTokens: estimateTokens(b.text), boundaryKind: "paragraph" as const })) : null;
  const currentRange = inSync && block ? { from: starts[view.current]!, to: starts[view.current]! + block.text.length } : null;
  const editorHits: Hit[] = inSync && block ? hits.map((h, i) => ({ from: starts[view.current]! + h.start, to: starts[view.current]! + h.end, current: i === current })) : [];
  // Moving to another block with the arrows or the numbers takes the editor there; clicking in the text does not need to.
  const [reveal, setReveal] = useState<{ at: number; n: number } | null>(null);
  useEffect(() => {
    if (fromCursor.current) {
      fromCursor.current = false;
      return;
    }
    if (inSync && starts[view.current] !== undefined) setReveal({ at: starts[view.current]!, n: Date.now() });
  }, [view.current]); // eslint-disable-line react-hooks/exhaustive-deps
  const cursorAt = (position: number) => {
    if (!inSync) return;
    let index = 0;
    starts.forEach((s, i) => {
      if (s <= position) index = i;
    });
    if (index !== view.current) {
      fromCursor.current = true;
      void go(index);
    }
  };

  // ---- the panes and the handles between them ----
  const shown = kb.open ? [0, 1, 2, 3] : [0, 1, 2];
  const total = shown.reduce((sum, i) => sum + widths[i]!, 0);
  const columns = shown.map((i, n) => `${widths[i]! / total}fr${n < shown.length - 1 ? " 6px" : ""}`).join(" ");
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

  const done = view.blocks.filter((b) => b.status === "translated").length;

  return (
    <div className="guided">
      <Flex align="center" justify="between" gap="3" wrap="wrap" px="3" py="2" className="guided-bar">
        <Flex align="center" gap="2">
          <IconButton variant="soft" color="gray" size="1" aria-label="Previous block" onClick={() => void go(view.current - 1)} disabled={view.current === 0 || working !== null}>
            <ArrowLeftIcon />
          </IconButton>
          <Text weight="bold" size="2">
            {view.blocks.length === 0 ? "No blocks yet" : `Block ${view.current + 1} of ${view.blocks.length}`}
          </Text>
          <IconButton variant="soft" color="gray" size="1" aria-label="Next block" onClick={() => void go(view.current + 1)} disabled={view.current >= view.blocks.length - 1 || working !== null}>
            <ArrowRightIcon />
          </IconButton>
          {view.blocks.length > 0 && (
            <Text size="1" color="gray">
              {done} translated
            </Text>
          )}
        </Flex>
        <Flex gap="1" wrap="wrap" justify="center" flexGrow="1" aria-label="Blocks" role="group">
          {view.blocks.map((b) => (
            <Button
              key={b.index}
              size="1"
              radius="full"
              variant={b.index === view.current ? "solid" : b.status === "translated" ? "soft" : "outline"}
              color={b.status === "translated" || b.index === view.current ? "indigo" : "gray"}
              onClick={() => void go(b.index)}
              title={`Block ${b.index + 1}: ${b.status === "translated" ? "translated" : b.status === "interpreted" ? "read" : "not read yet"}`}
              disabled={working !== null}
            >
              {b.index + 1}
            </Button>
          ))}
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
          <Callout.Text>
            <Flex align="center" justify="between" gap="3">
              {error}
              <Button variant="ghost" size="1" onClick={() => setError(null)}>
                Dismiss
              </Button>
            </Flex>
          </Callout.Text>
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
          <div className="source-pane-editor">
            <SourceEditor key={editorKey} value={text} onChange={onText} blocks={editorBlocks} placeholder="Paste or type the source text here." hits={editorHits} current={currentRange} onCursor={cursorAt} reveal={reveal} />
          </div>
        </section>

        <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the source and the reading" onPointerDown={beginDrag(0, 1)} />

          <section className="guided-pane">
            <h3>What was read</h3>
            {!block ? (
              <div className="guided-body">
                <Text as="p" size="2" color="gray">
                  Paste or type the source text on the left. It is cut into blocks, and what is read from each one shows here.
                </Text>
              </div>
            ) : !base ? (
              <div className="guided-body">
                <Text as="p" size="2" color="gray" mb="2">
                  This block has not been read yet.
                </Text>
                <Button onClick={() => void read(block.index)} disabled={working !== null}>
                  {working === "read" ? "Reading…" : "Read this block"}
                </Button>
              </div>
            ) : (
              <>
                <div className="guided-scroll">
                  <Flex align="center" gap="2" wrap="wrap">
                    <Text size="2" color="gray">
                      {base.narratorWord ? `Told as “${base.narratorWord}”. Narrator` : "Narrator"}
                    </Text>
                    <Pick label="Narrator" value={base.narrator ?? ""} options={[{ value: "", label: "not set" }, ...people.map((p) => ({ value: p.source, label: label(p) }))]} onChange={(v) => void choose(v === "" ? null : v, speakers, true)} />
                  </Flex>
                  {base.narratorWord && base.narrator === null && (
                    <Text as="p" size="1" color="gray" mt="1">
                      Who is “{base.narratorWord}” here? It carries on to the next blocks until you change it.
                    </Text>
                  )}

                  <Heading as="h4" size="2" mt="4" mb="2">
                    Glossary in this block{" "}
                    <Text size="1" color="gray" weight="regular">
                      {base.names.length}
                    </Text>
                  </Heading>
                  {base.names.length === 0 && (
                    <Text as="p" size="1" color="gray">
                      Nothing from the glossary found in this block. Add a word from the text below.
                    </Text>
                  )}
                  {base.names.length > 0 && (
                    <TextField.Root size="2" mb="2" type="search" aria-label="Search the glossary in this block" placeholder="Search this glossary" value={filter} onChange={(e) => setFilter(e.target.value)}>
                      <TextField.Slot>
                        <MagnifyingGlassIcon />
                      </TextField.Slot>
                    </TextField.Root>
                  )}
                  {base.names.length > 0 && groups.length === 0 && (
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
                            onToggle={() => look(n.source)}
                            onUse={(use) => void call(() => api.invoke("guided.setUse", { source: n.source, use })).then((s) => s && setState(s))}
                            onOpen={() => n.id && onKb({ open: true, request: { id: n.id, n: Date.now() } })}
                            onEnglish={(english) => void call(() => api.invoke("guided.setEnglish", { source: n.source, english })).then((s) => s && setState(s))}
                            onKind={(kind) => void call(() => api.invoke("guided.setKind", { source: n.source, kind })).then((s) => s && setState(s))}
                            onAttribute={(key, values) => void call(() => api.invoke("guided.setAttribute", { source: n.source, key, values })).then((s) => s && setState(s))}
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

                  <Heading as="h4" size="2" mt="5" mb="2">
                    Who says each line
                  </Heading>
                  {base.lines.length === 0 && (
                    <Text as="p" size="1" color="gray">
                      There are no lines of speech in this block.
                    </Text>
                  )}
                  <ul className="guided-lines">
                    {base.lines.map((l, i) => (
                      <li key={i}>
                        <Button variant={lineFocus === i ? "soft" : "ghost"} color={lineFocus === i ? "indigo" : "gray"} size="1" onClick={() => lookAtLine(i)} aria-pressed={lineFocus === i} title={`Show where it is in the text: ${l.text}`} className="line-text">
                          <Text truncate size="2">
                            {l.text}
                          </Text>
                        </Button>
                        <Pick
                          size="1"
                          label={`Speaker of line ${i + 1}`}
                          value={l.speaker ?? ""}
                          options={[{ value: "", label: "not known" }, ...people.map((p) => ({ value: p.source, label: label(p) }))]}
                          onChange={(v) => void choose(base.narrator, speakers.map((s, n) => (n === i ? (v === "" ? null : v) : s)), false)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
                <Flex gap="2" wrap="wrap" p="3" className="guided-foot">
                  <Button onClick={() => void translate()} disabled={working !== null || !model}>
                    {working === "translate" ? "Translating…" : block.status === "translated" ? "Translate again" : "Translate"}
                  </Button>
                  <Button variant="soft" color="gray" onClick={() => void choose(base.narrator, speakers, true)} disabled={working !== null} title="Work out who says the lines still set to not known, from the names and the narrator">
                    Guess the speakers
                  </Button>
                  <Button variant="ghost" color="gray" onClick={() => void read(block.index)} disabled={working !== null} title="Read the block again">
                    Read again
                  </Button>
                </Flex>
              </>
            )}
          </section>


        <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the reading and the translation" onPointerDown={beginDrag(1, 2)} />

          <section className="guided-pane">
            <h3>Translation</h3>
            {!block ? (
              <div className="guided-body">
                <Text as="p" size="2" color="gray">
                  The translation of the block you are working on appears here.
                </Text>
              </div>
            ) : block.status === "translated" ? (
              <>
                <TextArea className="guided-translation" variant="soft" aria-label="Translation of this block" value={translation} onChange={(e) => setTranslation(e.target.value)} onBlur={() => void saveTranslation()} spellCheck />
                <Flex gap="2" p="3" className="guided-foot">
                  <Button onClick={() => void go(block.index + 1)} disabled={block.index >= view.blocks.length - 1 || working !== null}>
                    {block.index >= view.blocks.length - 1 ? "Last block" : "Next block"}
                    {block.index < view.blocks.length - 1 && <ArrowRightIcon />}
                  </Button>
                </Flex>
              </>
            ) : (
              <div className="guided-body">
                <Text as="p" size="2" color={block.error ? "red" : "gray"}>
                  {working === "translate" ? "Translating…" : block.error ? block.error : "The translation appears here once you translate the block."}
                </Text>
              </div>
            )}
          </section>


        {kb.open && (
          <>
            <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the translation and the knowledge base" onPointerDown={beginDrag(2, 3)} />
            <section className="guided-pane">
              <h3 className="guided-pane-title">
                Knowledge base
                <IconButton variant="ghost" size="1" color="gray" onClick={() => onKb({ open: false, request: null })} aria-label="Close the knowledge base pane">
                  <Cross2Icon />
                </IconButton>
              </h3>
              <div className="guided-kb">
                <KnowledgeFiles rev={knowledgeRev} counts={knowledgeCounts} openRequest={kb.request} compact={kb.request !== null} />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
