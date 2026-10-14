import { useEffect, useMemo, useState } from "react";
import { labelLines } from "@ltw/domain/pure";
import type { GuidedName, GuidedState, Interpretation, NameKind } from "@ltw/domain";
import { api } from "./api";
import type { SetupState } from "./setup";

const KINDS: { value: NameKind; label: string }[] = [
  { value: "character", label: "Person" },
  { value: "family", label: "Family" },
  { value: "place", label: "Place" },
  { value: "organization", label: "Organization" },
  { value: "term", label: "Other" },
];

const shorten = (text: string, n: number): string => (Array.from(text).length > n ? `${Array.from(text).slice(0, n).join("")}…` : text);

/**
 * Translating one block at a time: the program reads who is named, who is telling it and who says each line,
 * the user checks that, and only then is the block translated. The result sits beside what was read.
 */
export function Guided({ setup, documentId, onClose }: { setup: SetupState; documentId: string; onClose: () => void }) {
  const [state, setState] = useState<GuidedState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState<"read" | "translate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelName, setModelName] = useState(setup.models[0]?.name ?? "");
  const [draft, setDraft] = useState<Interpretation | null>(null);
  const [newName, setNewName] = useState("");

  const model = setup.models.find((m) => m.name === modelName) ?? setup.models[0] ?? null;
  const block = state ? state.blocks[state.current] : undefined;

  const call = async <T,>(run: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T | null> => {
    setError(null);
    const r = await run();
    if (!r.ok) {
      setError(r.error.message);
      return null;
    }
    return r.value;
  };

  useEffect(() => {
    void api.invoke("guided.get").then((r) => {
      if (r.ok) setState(r.value);
      setLoaded(true);
    });
  }, []);

  // The interpretation being edited follows the block being shown.
  const shown = block?.interpretation ?? null;
  useEffect(() => {
    setDraft(shown ? structuredClone(shown) : null);
  }, [state?.current, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    const s = await call(() => api.invoke("guided.start", { documentId, text: setup.text, blockSize: setup.blockSize }));
    if (s) {
      setState(s);
      await read(0);
    }
  };

  const read = async (index: number) => {
    setWorking("read");
    const s = await call(() => api.invoke("guided.interpret", { index }));
    setWorking(null);
    if (s) setState(s);
  };

  const go = async (index: number) => {
    if (!state || index < 0 || index >= state.blocks.length) return;
    const s = await call(() => api.invoke("guided.go", { index }));
    if (!s) return;
    setState(s);
    if (s.blocks[index]!.status === "new") await read(index);
  };

  const translate = async () => {
    if (!state || !block || !model || !draft) return;
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
      else void api.invoke("guided.get").then((r) => r.ok && setState(r.value));
    }
    setWorking(null);
  };

  const startOver = async () => {
    if (state && state.blocks.some((b) => b.status === "translated") && !window.confirm("Start over? The blocks translated so far will be discarded. The names you confirmed are kept in the knowledge base.")) return;
    const r = await call(() => api.invoke("guided.clear"));
    if (r === null) setState(null);
  };

  const people = useMemo(() => draft?.names.filter((n) => n.kind === "character") ?? [], [draft]);
  /** Changes the draft. When names or the narrator changed, lines whose speaker is not known yet are worked out again; lines already set are left as they are. */
  const edit = (change: (d: Interpretation) => void, relabel = false) =>
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      change(next);
      if (relabel && block) {
        const fresh = labelLines(block.text, next.names, next.narrator, next.narratorWord);
        next.lines = next.lines.map((l, i) => (l.speaker === null && fresh[i]?.text === l.text ? { ...l, speaker: fresh[i]!.speaker } : l));
      }
      return next;
    });
  const english = (source: string | null): string => (source ? (draft?.names.find((n) => n.source === source)?.english || source) : "");
  const missing = draft?.names.filter((n) => n.english.trim() === "") ?? [];

  if (!loaded) return <p className="hint pad">Loading…</p>;

  if (!state) {
    return (
      <div className="guided-start">
        <h2>Translate step by step</h2>
        <p>
          The text is split into blocks. For each block the app reads who is named, who is telling it and who says each line. You check that, then the block is translated, and the next one starts with the end of
          this one.
        </p>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="primary" onClick={() => void start()} disabled={setup.text.trim() === "" || !model} title={!model ? "Add a model first" : setup.text.trim() === "" ? "Paste the text first" : undefined}>
            Start with the text in the editor
          </button>
          <button onClick={onClose}>Back to the editor</button>
        </div>
        {setup.text.trim() === "" && <p className="hint">Paste the text in the editor first.</p>}
        {!model && <p className="hint">Add a model in the left panel first.</p>}
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
        <div className="guided-cols">
          <section className="guided-pane">
            <h3>Source</h3>
            <div className="guided-body source-text">{block.text}</div>
          </section>

          <section className="guided-pane">
            <h3>What was read</h3>
            <div className="guided-body">
              {!draft ? (
                <div>
                  <p className="hint">This block has not been read yet.</p>
                  <button className="primary" onClick={() => void read(block.index)} disabled={working !== null}>
                    {working === "read" ? "Reading…" : "Read this block"}
                  </button>
                </div>
              ) : (
                <>
                  {draft.narratorWord && (
                    <div className="guided-field">
                      <label>
                        Told as “{draft.narratorWord}”. The narrator is
                        <select value={draft.narrator ?? ""} onChange={(e) => edit((d) => (d.narrator = e.target.value === "" ? null : e.target.value), true)}>
                          <option value="">not set</option>
                          {people.map((p) => (
                            <option key={p.source} value={p.source}>
                              {p.english || p.source}
                            </option>
                          ))}
                        </select>
                      </label>
                      {draft.narrator === null && <p className="hint">Choose who “{draft.narratorWord}” is; it is remembered for the next blocks.</p>}
                    </div>
                  )}

                  <h4>Names</h4>
                  {draft.names.length === 0 && <p className="hint">No names found in this block.</p>}
                  <ul className="guided-names">
                    {draft.names.map((n, i) => (
                      <li key={n.source}>
                        <span className="name-source" title={n.reading ? `Reads: ${n.reading}` : undefined}>
                          {n.source}
                          {n.known && <span className="tag">in glossary</span>}
                        </span>
                        <select aria-label={`Kind of ${n.source}`} value={n.kind} onChange={(e) => edit((d) => (d.names[i]!.kind = e.target.value as GuidedName["kind"]), true)}>
                          {KINDS.map((k) => (
                            <option key={k.value} value={k.value}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                        {n.kind === "character" && (
                          <select aria-label={`Gender of ${n.source}`} value={n.gender ?? ""} title="Sent to the model so it keeps he and she right" onChange={(e) => edit((d) => (d.names[i]!.gender = e.target.value === "" ? null : (e.target.value as "female" | "male")))}>
                            <option value="">gender?</option>
                            <option value="female">she</option>
                            <option value="male">he</option>
                          </select>
                        )}
                        <input
                          aria-label={`English name of ${n.source}`}
                          value={n.english}
                          placeholder={n.reading ? `reads: ${n.reading}` : "English name"}
                          onChange={(e) => edit((d) => (d.names[i]!.english = e.target.value))}
                        />
                        <button
                          className="small"
                          aria-label={`Remove ${n.source}`}
                          title="This is not a name"
                          onClick={() =>
                            edit((d) => {
                              d.names.splice(i, 1);
                              if (d.narrator === n.source) d.narrator = null;
                              for (const l of d.lines) if (l.speaker === n.source) l.speaker = null;
                            }, true)
                          }
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const source = newName.trim();
                      if (source === "" || draft.names.some((n) => n.source === source)) return;
                      edit((d) => d.names.push({ source, english: "", kind: "character", aliases: [], reading: "", known: false, gender: null }), true);
                      setNewName("");
                    }}
                  >
                    <input aria-label="Add a name from the text" value={newName} placeholder="Add a name from the text" onChange={(e) => setNewName(e.target.value)} />
                    <button className="small" type="submit" disabled={newName.trim() === ""}>
                      Add
                    </button>
                  </form>

                  {draft.lines.length > 0 && (
                    <>
                      <h4>Who says each line</h4>
                      <ul className="guided-lines">
                        {draft.lines.map((l, i) => (
                          <li key={i}>
                            <span className="line-text" title={l.text}>
                              {shorten(l.text, 24)}
                            </span>
                            <select aria-label={`Speaker of line ${i + 1}`} value={l.speaker ?? ""} onChange={(e) => edit((d) => (d.lines[i]!.speaker = e.target.value === "" ? null : e.target.value))}>
                              <option value="">not known</option>
                              {people.map((p) => (
                                <option key={p.source} value={p.source}>
                                  {english(p.source)}
                                </option>
                              ))}
                            </select>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  <div className="row guided-actions">
                    <button className="primary" onClick={() => void translate()} disabled={working !== null || !model}>
                      {working === "translate" ? "Translating…" : block.status === "translated" ? "Confirm and translate again" : "Confirm and translate"}
                    </button>
                    <button onClick={() => void read(block.index)} disabled={working !== null} title="Read the block again, discarding your changes here">
                      Read again
                    </button>
                  </div>
                  {missing.length > 0 && <p className="hint">{missing.length === 1 ? `「${missing[0]!.source}」 has no English name, so it is sent as it is.` : `${missing.length} names have no English name, so they are sent as they are.`}</p>}
                </>
              )}
            </div>
          </section>

          <section className="guided-pane">
            <h3>Translation</h3>
            <div className="guided-body">
              {block.status === "translated" ? (
                <>
                  <div className="translation-text">{block.translation}</div>
                  <div className="row guided-actions">
                    <button className="primary" onClick={() => void go(block.index + 1)} disabled={block.index >= state.blocks.length - 1 || working !== null}>
                      {block.index >= state.blocks.length - 1 ? "Last block" : "Next block →"}
                    </button>
                  </div>
                </>
              ) : (
                <p className="hint">{working === "translate" ? "Translating…" : block.error ? block.error : "The translation appears here once you confirm what was read."}</p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
