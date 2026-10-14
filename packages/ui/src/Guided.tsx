import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
export function Guided({ setup, documentId, knowledgeRev, knowledgeCounts, onClose }: { setup: SetupState; documentId: string; knowledgeRev: number; knowledgeCounts: { terms: number; notes: number; suggested: number }; onClose: () => void }) {
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
  const [topics, setTopics] = useState<TopicRef[]>([]);
  const started = useRef(false);

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

  // Opening this screen picks up where it was left, or starts on the text in the editor straight away.
  useEffect(() => {
    void api.invoke("guided.get").then(async (r) => {
      if (r.ok && r.value) setState(r.value);
      setLoaded(true);
      if ((r.ok && r.value) || started.current || setup.text.trim() === "" || !model) return;
      started.current = true;
      const s = await call(() => api.invoke("guided.start", { documentId, text: setup.text, blockSize: setup.blockSize }));
      if (s) {
        setState(s);
        await read(0);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const people = (base?.names ?? []).filter((n) => n.kind === "character");
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

  const startOver = async () => {
    if (state && state.blocks.some((b) => b.status === "translated") && !window.confirm("Start over? The blocks translated so far will be discarded. The names stay in the knowledge base.")) return;
    await call(() => api.invoke("guided.clear"));
    setState(null);
    onClose();
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
        <p className="hint">{error ?? (!model ? "Add a model in the left panel to translate step by step." : setup.text.trim() === "" ? "Paste the text in the editor first, then open this again." : "Starting…")}</p>
        <button onClick={onClose}>Back to the editor</button>
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
          <button className="small" onClick={() => void startOver()}>
            Start over
          </button>
          <button className="small" onClick={onClose}>
            Back to the editor
          </button>
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
            <div className="guided-body source-text">{block.text}</div>
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

                  <h4>Names in this block</h4>
                  {base.names.length === 0 && <p className="hint guided-hint">No names found. Add a word from the text below.</p>}
                  <ul className="guided-glossary">
                    {base.names.map((n) => (
                      <NameRow
                        key={n.source}
                        name={n}
                        classes={classes}
                        topics={topics}
                        onOpen={() => n.id && setTopic({ id: n.id, n: Date.now() })}
                        onKind={(kind) => void call(() => api.invoke("guided.setKind", { source: n.source, kind })).then((s) => s && setState(s))}
                        onAttribute={(key, values) => void call(() => api.invoke("guided.setAttribute", { source: n.source, key, values })).then((s) => s && setState(s))}
                      />
                    ))}
                  </ul>
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
                        <span className="line-text" title={l.text}>
                          {Array.from(l.text).length > 22 ? `${Array.from(l.text).slice(0, 22).join("")}…` : l.text}
                        </span>
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
