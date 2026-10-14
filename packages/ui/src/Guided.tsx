import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { occurrencesOf } from "@ltw/domain/pure";
import type { GuidedName, GuidedState } from "@ltw/domain";
import { api } from "./api";
import { KnowledgeFiles } from "./KnowledgeFiles";
import { NameRow, type ClassInfo, type TopicRef } from "./NameRow";
import type { SetupState } from "./setup";

const WIDTHS_KEY = "ltw.guided.widths.v3";
const MIN = 0.1;
const DEFAULT_WIDTHS = [0.2, 0.27, 0.23, 0.3];

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
 * Translating one block at a time. The program reads who is named, who is telling it and who says each line. The names
 * are topics of the glossary: they are listed here and opened as files in the pane on the right. The narrator and the
 * speakers are chosen from them. Only then is the block translated, and the translation can be corrected beside it.
 */
export function Guided({ setup, documentId, knowledgeRev, knowledgeCounts }: { setup: SetupState; documentId: string; knowledgeRev: number; knowledgeCounts: { terms: number; notes: number; suggested: number } }) {
  const [state, setState] = useState<GuidedState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState<"read" | "translate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelName, setModelName] = useState(setup.models[0]?.name ?? "");
  const [translation, setTranslation] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [widths, setWidths] = useState<number[]>(loadWidths);
  const [topic, setTopic] = useState<{ id: string; n: number } | null>(null);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [lineFocus, setLineFocus] = useState<number | null>(null);
  // The words whose details are open. It belongs here, not to each row, so a word that moves to another group keeps its place.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [hit, setHit] = useState(0);
  const [filter, setFilter] = useState("");
  const sourceBox = useRef<HTMLDivElement>(null);
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
    if (setup.text.trim() === "") return;
    setWorking("read");
    const made = await call(() => api.invoke("guided.sync", { documentId, text: setup.text, blockSize: setup.blockSize }));
    if (made) {
      setState(made);
      const all = await call(() => api.invoke("guided.readAll"));
      if (all) setState(all);
    }
    setWorking(null);
  };

  // This screen always shows the text in the editor: opening it makes the blocks from it, and a block whose text is unchanged keeps its work.
  useEffect(() => {
    void sync().then(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A change in the text while this is open is followed too.
  const seenText = useRef(setup.text);
  useEffect(() => {
    if (seenText.current === setup.text) return;
    seenText.current = setup.text;
    void sync();
  }, [setup.text]); // eslint-disable-line react-hooks/exhaustive-deps

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
    sourceBox.current?.querySelector("mark.current")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, lineFocus, current, state?.current]);
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
    if (name?.id) setTopic({ id: name.id, n: Date.now() });
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

  // ---- the panes and the handles between them ----
  const shown = topic ? [0, 1, 2, 3] : [0, 1, 2];
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

  if (!loaded) return <p className="hint pad">Loading…</p>;

  if (!state) {
    return (
      <div className="guided-empty">
        <p className="hint">{error ?? (!model ? "Add a model in the left panel to translate step by step." : setup.text.trim() === "" ? "Paste the text in the editor, and its blocks appear here." : "Reading…")}</p>
      </div>
    );
  }

  const done = state.blocks.filter((b) => b.status === "translated").length;

  return (
    <div className="guided">
      <div className="guided-bar">
        <span className="row">
          <button className="small" onClick={() => void go(state.current - 1)} disabled={state.current === 0 || working !== null}>
            ←
          </button>
          <strong>
            Block {state.current + 1} of {state.blocks.length}
          </strong>
          <button className="small" onClick={() => void go(state.current + 1)} disabled={state.current >= state.blocks.length - 1 || working !== null}>
            →
          </button>
          <span className="hint">{done} translated</span>
        </span>
        <span className="guided-dots" aria-label="Blocks">
          {state.blocks.map((b) => (
            <button key={b.index} className={`dot ${b.status}${b.index === state.current ? " here" : ""}`} onClick={() => void go(b.index)} title={`Block ${b.index + 1}: ${b.status === "translated" ? "translated" : b.status === "interpreted" ? "read" : "not read yet"}`} disabled={working !== null}>
              {b.index + 1}
            </button>
          ))}
        </span>
        <span className="row">
          <label className="inline-select">
            Model
            <select value={model?.name ?? ""} onChange={(e) => setModelName(e.target.value)}>
              {setup.models.map((m) => (
                <option key={m.name}>{m.name}</option>
              ))}
            </select>
          </label>
        </span>
      </div>
      {error && (
        <div className="strip">
          <span>{error}</span>
          <button className="small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {block && (
        <div className="guided-cols" ref={box} style={{ gridTemplateColumns: columns }} onPointerMove={moveDrag} onPointerUp={endDrag}>
          <section className="guided-pane">
            <h3>Source</h3>
            {looking !== null && (
              <div className="source-find">
                <span className="source-find-word">{looking}</span>
                <span className="hint">{hits.length === 0 ? "not found in the text" : hits.length === 1 ? "1 place" : `${current + 1} of ${hits.length}`}</span>
                <span className="row">
                  <button className="small" onClick={() => setHit(current - 1)} disabled={hits.length < 2} aria-label="Previous place">
                    ↑
                  </button>
                  <button className="small" onClick={() => setHit(current + 1)} disabled={hits.length < 2} aria-label="Next place">
                    ↓
                  </button>
                  <button className="small" onClick={stopLooking} aria-label="Stop looking">
                    ×
                  </button>
                </span>
              </div>
            )}
            <div className="guided-body source-text" ref={sourceBox}>
              {hits.length === 0
                ? block.text
                : (() => {
                    const parts: React.ReactNode[] = [];
                    let at = 0;
                    hits.forEach((h, i) => {
                      parts.push(block.text.slice(at, h.start));
                      parts.push(
                        <mark key={i} className={i === current ? "current" : undefined}>
                          {block.text.slice(h.start, h.end)}
                        </mark>,
                      );
                      at = h.end;
                    });
                    parts.push(block.text.slice(at));
                    return parts;
                  })()}
            </div>
          </section>

          <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the source and the reading" onPointerDown={beginDrag(0, 1)} />

          <section className="guided-pane">
            <h3>What was read</h3>
            {!base ? (
              <div className="guided-body">
                <p className="hint">This block has not been read yet.</p>
                <button className="primary" onClick={() => void read(block.index)} disabled={working !== null}>
                  {working === "read" ? "Reading…" : "Read this block"}
                </button>
              </div>
            ) : (
              <>
                <div className="guided-scroll">
                  <label className="guided-narrator">
                    {base.narratorWord ? `Told as “${base.narratorWord}”. Narrator` : "Narrator"}
                    <select aria-label="Narrator" value={base.narrator ?? ""} onChange={(e) => void choose(e.target.value === "" ? null : e.target.value, speakers, true)}>
                      <option value="">not set</option>
                      {people.map((p) => (
                        <option key={p.source} value={p.source}>
                          {label(p)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {base.narratorWord && base.narrator === null && <p className="hint guided-hint">Who is “{base.narratorWord}” here? It carries on to the next blocks until you change it.</p>}

                  <h4>
                    Glossary in this block <span className="hint">{base.names.length}</span>
                  </h4>
                  {base.names.length === 0 && <p className="hint guided-hint">Nothing from the glossary found in this block. Add a word from the text below.</p>}
                  {base.names.length > 0 && <input className="glossary-search" type="search" aria-label="Search the glossary in this block" placeholder="Search this glossary" value={filter} onChange={(e) => setFilter(e.target.value)} />}
                  {base.names.length > 0 && groups.length === 0 && <p className="hint guided-hint">Nothing matches.</p>}
                  {groups.map((g) => (
                    <section key={g.kind} className="glossary-group">
                      <h5>
                        {kindLabel(g.kind)} <span className="hint">{g.names.length}</span>
                      </h5>
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
                            onOpen={() => n.id && setTopic({ id: n.id, n: Date.now() })}
                            onEnglish={(english) => void call(() => api.invoke("guided.setEnglish", { source: n.source, english })).then((s) => s && setState(s))}
                            onKind={(kind) => void call(() => api.invoke("guided.setKind", { source: n.source, kind })).then((s) => s && setState(s))}
                            onAttribute={(key, values) => void call(() => api.invoke("guided.setAttribute", { source: n.source, key, values })).then((s) => s && setState(s))}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void addTerm();
                    }}
                  >
                    <input aria-label="Add a word from the text to the glossary" value={newTerm} placeholder="Add a word from the text" onChange={(e) => setNewTerm(e.target.value)} />
                    <button className="small" type="submit" disabled={newTerm.trim() === ""}>
                      Add
                    </button>
                  </form>

                  <h4>Who says each line</h4>
                  {base.lines.length === 0 && <p className="hint guided-hint">There are no lines of speech in this block.</p>}
                  <ul className="guided-lines">
                    {base.lines.map((l, i) => (
                      <li key={i}>
                        <button className={lineFocus === i ? "line-text focused" : "line-text"} onClick={() => lookAtLine(i)} aria-pressed={lineFocus === i} title="Show where it is in the text">
                          {Array.from(l.text).length > 22 ? `${Array.from(l.text).slice(0, 22).join("")}…` : l.text}
                        </button>
                        <select aria-label={`Speaker of line ${i + 1}`} value={l.speaker ?? ""} onChange={(e) => void choose(base.narrator, speakers.map((s, n) => (n === i ? (e.target.value === "" ? null : e.target.value) : s)), false)}>
                          <option value="">not known</option>
                          {people.map((p) => (
                            <option key={p.source} value={p.source}>
                              {label(p)}
                            </option>
                          ))}
                        </select>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="guided-foot">
                  <button className="primary" onClick={() => void translate()} disabled={working !== null || !model}>
                    {working === "translate" ? "Translating…" : block.status === "translated" ? "Translate again" : "Translate"}
                  </button>
                  <button onClick={() => void choose(base.narrator, speakers, true)} disabled={working !== null} title="Work out who says the lines still set to not known, from the names and the narrator">
                    Guess the speakers
                  </button>
                  <button onClick={() => void read(block.index)} disabled={working !== null} title="Read the block again">
                    Read again
                  </button>
                </div>
              </>
            )}
          </section>

          <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the reading and the translation" onPointerDown={beginDrag(1, 2)} />

          <section className="guided-pane">
            <h3>Translation</h3>
            {block.status === "translated" ? (
              <>
                {block.warning && <p className="guided-warning">{block.warning}</p>}
                <textarea className="guided-translation" aria-label="Translation of this block" value={translation} onChange={(e) => setTranslation(e.target.value)} onBlur={() => void saveTranslation()} spellCheck />
                <div className="guided-foot">
                  <button className="primary" onClick={() => void go(block.index + 1)} disabled={block.index >= state.blocks.length - 1 || working !== null}>
                    {block.index >= state.blocks.length - 1 ? "Last block" : "Next block →"}
                  </button>
                </div>
              </>
            ) : (
              <div className="guided-body">
                <p className="hint">{working === "translate" ? "Translating…" : block.error ? block.error : "The translation appears here once you translate the block."}</p>
              </div>
            )}
          </section>

          {topic && (
            <>
              <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the translation and the knowledge base" onPointerDown={beginDrag(2, 3)} />
              <section className="guided-pane">
                <h3 className="guided-pane-title">
                  Knowledge base
                  <button className="small" onClick={() => setTopic(null)} aria-label="Close the knowledge base pane">
                    ×
                  </button>
                </h3>
                <div className="guided-kb">
                  <KnowledgeFiles rev={knowledgeRev} counts={knowledgeCounts} openRequest={topic} compact />
                </div>
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
