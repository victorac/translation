import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { labelLines, namesFromText, namesToText } from "@ltw/domain/pure";
import type { GuidedName, GuidedState, Interpretation } from "@ltw/domain";
import { api } from "./api";
import { ReadingEditor } from "./ReadingEditor";
import type { SetupState } from "./setup";

const WIDTHS_KEY = "ltw.guided.widths";
const MIN = 0.12;

const loadWidths = (): [number, number] => {
  try {
    const v = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "null") as unknown;
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && x >= MIN) && v[0] + v[1] <= 1 - MIN) return [v[0], v[1]];
  } catch {
    /* storage may be unavailable */
  }
  return [1 / 3, 1 / 3];
};

/**
 * Translating one block at a time: the program reads who is named, who is telling it and who says each line, and shows
 * that as a text to check and fix. Only then is the block translated, with the result beside it, which can be fixed too.
 */
export function Guided({ setup, documentId, onClose }: { setup: SetupState; documentId: string; onClose: () => void }) {
  const [state, setState] = useState<GuidedState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState<"read" | "translate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelName, setModelName] = useState(setup.models[0]?.name ?? "");
  const [namesText, setNamesText] = useState("");
  const [narrator, setNarrator] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<(string | null)[]>([]);
  const [translation, setTranslation] = useState("");
  const [widths, setWidths] = useState<[number, number]>(loadWidths);
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

  // What is being edited follows the block being shown.
  useEffect(() => {
    setNamesText(base ? namesToText(base.names) : "");
    setNarrator(base?.narrator ?? null);
    setSpeakers(base ? base.lines.map((l) => l.speaker) : []);
  }, [state?.current, base]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setTranslation(block?.translation ?? "");
  }, [state?.current, block?.translation]); // eslint-disable-line react-hooks/exhaustive-deps

  // The names as typed. Everything that refers to a name (the narrator, who says each line) is checked against them as they are now.
  const parsed = useMemo(() => (base ? namesFromText(namesText, base.names) : null), [namesText, base]);
  const problems = parsed?.problems ?? [];
  const people: GuidedName[] = useMemo(() => (parsed?.names ?? []).filter((n) => n.kind === "character"), [parsed]);
  const has = (source: string | null): source is string => source !== null && people.some((p) => p.source === source);
  const effectiveNarrator = has(narrator) ? narrator : null;
  const effectiveSpeakers = speakers.map((s) => (has(s) ? s : null));
  const label = (p: GuidedName): string => (p.english.trim() !== "" ? `${p.english.trim()} (${p.source})` : p.source);

  /** What is shown and what is sent: the names as typed, the narrator and the speakers chosen. */
  const draft: Interpretation | null =
    base && parsed
      ? { names: parsed.names, narrator: effectiveNarrator, narratorWord: base.narratorWord, lines: base.lines.map((l, i) => ({ text: l.text, speaker: effectiveSpeakers[i] ?? null })) }
      : null;

  /** After the names or the narrator change, lines whose speaker is not known yet are worked out again; the ones already set stay. */
  const fill = (names: GuidedName[], who: string | null, current: (string | null)[]) => {
    if (!block || !base) return current;
    const fresh = labelLines(block.text, names, who, base.narratorWord);
    return current.map((s, i) => (s === null && fresh[i]?.text === base.lines[i]?.text ? (fresh[i]?.speaker ?? null) : s));
  };
  const onNames = (text: string) => {
    setNamesText(text);
    if (!base) return;
    const next = namesFromText(text, base.names);
    setSpeakers((cur) => fill(next.names, has(narrator) ? narrator : null, cur));
  };
  const onNarrator = (value: string | null) => {
    setNarrator(value);
    setSpeakers((cur) => fill(parsed?.names ?? [], value, cur));
  };

  const go = async (index: number) => {
    if (!state || index < 0 || index >= state.blocks.length) return;
    const s = await call(() => api.invoke("guided.go", { index }));
    if (!s) return;
    setState(s);
    if (s.blocks[index]!.status === "new") await read(index);
  };

  const translate = async () => {
    if (!state || !block || !model || !draft || problems.length > 0) return;
    setWorking("translate");
    const saved = await call(() => api.invoke("guided.save", { index: block.index, interpretation: draft }));
    if (saved) {
      setState(saved);
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
    }
    setWorking(null);
  };

  /** Lines whose speaker is not known are worked out again from the names and the narrator as they are now. */
  const guessSpeakers = () => setSpeakers(fill(parsed?.names ?? [], effectiveNarrator, effectiveSpeakers));

  const saveTranslation = async () => {
    if (!block || translation === block.translation) return;
    const s = await call(() => api.invoke("guided.setTranslation", { index: block.index, text: translation }));
    if (s) setState(s);
  };

  const startOver = async () => {
    if (state && state.blocks.some((b) => b.status === "translated") && !window.confirm("Start over? The blocks translated so far will be discarded. The names you confirmed are kept in the knowledge base.")) return;
    await call(() => api.invoke("guided.clear"));
    setState(null);
    onClose();
  };

  // ---- the three panes and the handles between them ----
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ which: 0 | 1; start: number; widths: [number, number] } | null>(null);
  const beginDrag = (which: 0 | 1) => (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { which, start: e.clientX, widths };
  };
  const moveDrag = (e: ReactPointerEvent) => {
    const d = drag.current;
    const width = box.current?.getBoundingClientRect().width;
    if (!d || !width) return;
    const delta = (e.clientX - d.start) / width;
    const [a, b] = d.widths;
    // The handle between two panes moves their shared edge: one grows as the other shrinks, and the third keeps its width.
    if (d.which === 0) {
      const na = Math.min(Math.max(MIN, a + delta), a + b - MIN);
      setWidths([na, a + b - na]);
    } else {
      const nb = Math.min(Math.max(MIN, b + delta), 1 - a - MIN);
      setWidths([a, nb]);
    }
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
  const columns = `${widths[0]}fr 6px ${widths[1]}fr 6px ${Math.max(MIN, 1 - widths[0] - widths[1])}fr`;

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

          <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the source and the reading" onPointerDown={beginDrag(0)} />

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
                    <select aria-label="Narrator" value={effectiveNarrator ?? ""} onChange={(e) => onNarrator(e.target.value === "" ? null : e.target.value)}>
                      <option value="">not set</option>
                      {people.map((p) => (
                        <option key={p.source} value={p.source}>
                          {label(p)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {base.narratorWord && effectiveNarrator === null && <p className="hint guided-hint">Who is “{base.narratorWord}” here? It carries on to the next blocks until you change it.</p>}
                  <h4>Names</h4>
                  <div className="guided-editor">
                    <ReadingEditor docKey={`${state.current}`} text={namesText} problems={problems} onText={onNames} />
                  </div>
                  <h4>Who says each line</h4>
                  {base.lines.length === 0 && <p className="hint guided-hint">There are no lines of speech in this block.</p>}
                  <ul className="guided-lines">
                    {base.lines.map((l, i) => (
                      <li key={i}>
                        <span className="line-text" title={l.text}>
                          {Array.from(l.text).length > 22 ? `${Array.from(l.text).slice(0, 22).join("")}…` : l.text}
                        </span>
                        <select
                          aria-label={`Speaker of line ${i + 1}`}
                          value={effectiveSpeakers[i] ?? ""}
                          onChange={(e) => setSpeakers((cur) => cur.map((s, n) => (n === i ? (e.target.value === "" ? null : e.target.value) : s)))}
                        >
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
                  <button className="primary" onClick={() => void translate()} disabled={working !== null || !model || problems.length > 0} title={problems.length > 0 ? "Fix what is marked first" : undefined}>
                    {working === "translate" ? "Translating…" : block.status === "translated" ? "Confirm and translate again" : "Confirm and translate"}
                  </button>
                  <button onClick={guessSpeakers} disabled={working !== null} title="Work out who says the lines still set to not known, from the names and the narrator">
                    Guess the speakers
                  </button>
                  <button onClick={() => void read(block.index)} disabled={working !== null} title="Read the block again, discarding your changes here">
                    Read again
                  </button>
                  {problems.length > 0 && <span className="hint">{problems.length === 1 ? "1 thing to fix" : `${problems.length} things to fix`}</span>}
                </div>
              </>
            )}
          </section>

          <div className="guided-handle" role="separator" aria-orientation="vertical" aria-label="Resize the reading and the translation" onPointerDown={beginDrag(1)} />

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
                <p className="hint">{working === "translate" ? "Translating…" : block.error ? block.error : "The translation appears here once you confirm what was read."}</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
