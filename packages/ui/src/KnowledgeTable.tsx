import { useState } from "react";
import { entriesToText, entryProblems, type EntryInput, type KnowledgeEntry } from "@ltw/domain/pure";
import { api } from "./api";
import { useKnowledgeList } from "./useKnowledge";

type Tab = "summary" | "terms" | "scenes";

const input = (kind: KnowledgeEntry["kind"], over: Partial<EntryInput> = {}): EntryInput => ({ kind, source: "", target: "", hint: "", text: "", about: null, ...over });
const fromEntry = (e: KnowledgeEntry): EntryInput => ({ id: e.id, kind: e.kind, source: e.source, target: e.target, hint: e.hint, text: e.text, about: e.about });

function fromWhere(e: KnowledgeEntry): string {
  if (e.origin.by === "user") return "Written by you";
  const place = [e.origin.documentTitle, e.origin.block ? `block ${e.origin.block}` : null].filter(Boolean).join(", ");
  return `Suggested by ${e.origin.model ?? "a model"}${place ? ` from ${place}` : ""}`;
}

/** A small tag for what a model suggested and nobody has checked yet. */
const Suggested = ({ e }: { e: KnowledgeEntry }) => (e.status === "suggested" ? <span className="tag warn-tag" title={fromWhere(e)}>suggested</span> : null);

function EntryForm({ initial, terms, onSave, onCancel }: { initial: EntryInput; terms: KnowledgeEntry[]; onSave: (e: EntryInput) => Promise<string | null>; onCancel: () => void }) {
  const [e, setE] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<EntryInput>) => setE({ ...e, ...patch });
  const submit = async () => {
    const own = entryProblems(e)[0];
    if (own) return setProblem(own);
    setProblem(await onSave(e));
  };
  return (
    <form
      className="kb-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      {e.kind === "term" ? (
        <div className="kb-fields">
          <label>
            Word in the text
            <input autoFocus value={e.source} onChange={(ev) => set({ source: ev.target.value })} />
          </label>
          <label>
            Translate as
            <input value={e.target} onChange={(ev) => set({ target: ev.target.value })} />
          </label>
          <label className="wide">
            Hint
            <input value={e.hint} placeholder="girl, speaks politely" onChange={(ev) => set({ hint: ev.target.value })} />
          </label>
        </div>
      ) : (
        <div className="kb-fields">
          {e.kind === "note" && (
            <label className="wide">
              About
              <select value={e.about ?? ""} onChange={(ev) => set({ about: ev.target.value || null })}>
                <option value="">Nothing in particular</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.source} → {t.target}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="wide">
            {e.kind === "scene" ? "What is happening" : e.kind === "summary" ? "Summary" : "Fact or note"}
            <textarea autoFocus rows={e.kind === "summary" ? 6 : 3} value={e.text} onChange={(ev) => set({ text: ev.target.value })} />
          </label>
        </div>
      )}
      <div className="row-end">
        {problem && <span className="hint err-text">{problem}</span>}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Save
        </button>
      </div>
    </form>
  );
}

/**
 * The knowledge base: a summary of the open document, the people and terms with the facts about each, and what is
 * happening in each block. Everything a model suggested is marked until you confirm it.
 */
export function KnowledgeTable({ rev, documentId, documentTitle }: { rev: number; documentId: string; documentTitle: string }) {
  const [tab, setTab] = useState<Tab>("terms");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // an entry id, or "new:<kind>[:<about>]"
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const list = useKnowledgeList(rev, {});
  const all = list?.entries ?? [];
  const counts = list?.counts;
  const q = text.trim().toLocaleLowerCase();
  const matches = (...parts: string[]) => q === "" || parts.some((p) => p.toLocaleLowerCase().includes(q));

  const terms = all.filter((e) => e.kind === "term");
  const byId = new Map(all.map((e) => [e.id, e]));
  const factsOf = (t: KnowledgeEntry) => all.filter((e) => e.kind === "note" && e.about === t.id);
  const loose = all.filter((e) => e.kind === "note" && (e.about === null || !byId.has(e.about)));
  const scenes = all.filter((e) => e.kind === "scene" && e.scope?.documentId === documentId).sort((a, b) => (a.scope?.block ?? 0) - (b.scope?.block ?? 0));
  const summary = all.find((e) => e.kind === "summary" && e.scope?.documentId === documentId);
  const scenesOf = (t: KnowledgeEntry) => scenes.filter((s) => s.related.includes(t.id)).map((s) => s.scope?.block ?? 0);

  const save = async (e: EntryInput): Promise<string | null> => {
    const r = await api.invoke("knowledge.save", e);
    if (!r.ok) return r.error.message;
    setEditing(null);
    return null;
  };
  const remove = async (e: KnowledgeEntry) => {
    const what = e.kind === "term" ? `"${e.source}" and its facts` : "this entry";
    if (window.confirm(`Delete ${what}?`)) await api.invoke("knowledge.remove", { ids: [e.id] });
  };
  const confirm = (ids?: string[]) => void api.invoke("knowledge.confirm", ids ? { ids } : {});

  const Actions = ({ e }: { e: KnowledgeEntry }) => (
    <span className="kb-row-actions">
      {e.status === "suggested" && (
        <button className="small" onClick={() => confirm([e.id])}>
          Confirm
        </button>
      )}
      <button className="small" onClick={() => setEditing(e.id)}>
        Edit
      </button>
      <button className="small" aria-label="Delete" onClick={() => void remove(e)}>
        ×
      </button>
    </span>
  );
  const formFor = (e: KnowledgeEntry) => <EntryForm initial={fromEntry(e)} terms={terms} onSave={save} onCancel={() => setEditing(null)} />;

  return (
    <div className="kb-table">
      <div className="segmented small" role="tablist" aria-label="Knowledge base">
        {(
          [
            ["summary", "Summary"],
            ["terms", `Terms${counts ? ` ${counts.terms}` : ""}`],
            ["scenes", `Scenes${counts ? ` ${scenes.length}` : ""}`],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <div className="kb-bar">
        <input type="search" aria-label="Search the knowledge base" placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} />
        {counts && counts.suggested > 0 && (
          <button className="small" onClick={() => confirm()} title="Mark everything a model suggested as checked">
            Confirm {counts.suggested} suggested
          </button>
        )}
      </div>
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}

      {tab === "summary" && (
        <div className="kb-section">
          <p className="hint">An abridged version of “{documentTitle}”. Every block of it is translated with this summary in view.</p>
          {editing === "new:summary" && <EntryForm initial={input("summary", { documentId })} terms={terms} onSave={save} onCancel={() => setEditing(null)} />}
          {summary ? (
            editing === summary.id ? (
              formFor(summary)
            ) : (
              <div className="kb-row">
                <div className="kb-main">{summary.text}</div>
                <div className="kb-meta-row">
                  <Suggested e={summary} />
                  <Actions e={summary} />
                </div>
              </div>
            )
          ) : (
            editing !== "new:summary" && (
              <p className="hint">
                No summary yet. Extract knowledge writes one from the scenes, or{" "}
                <button className="link-button" onClick={() => setEditing("new:summary")}>
                  write it yourself
                </button>
                .
              </p>
            )
          )}
        </div>
      )}

      {tab === "terms" && (
        <div className="kb-section">
          <div className="kb-bar">
            <span className="hint">{terms.length} {terms.length === 1 ? "term" : "terms"}</span>
            <span className="kb-actions">
              <button className="small" onClick={() => setPasting((p) => !p)}>
                Paste list
              </button>
              <button
                className="small"
                onClick={() =>
                  void navigator.clipboard.writeText(entriesToText(all)).then(
                    () => setMessage("Copied as text."),
                    () => setMessage("Could not copy."),
                  )
                }
              >
                Copy as text
              </button>
              <button className="small primary" onClick={() => setEditing("new:term")}>
                Add term
              </button>
            </span>
          </div>
          {pasting && (
            <div className="kb-form">
              <textarea rows={4} value={paste} placeholder={"魔王 = Demon King # villain\n> A note about the story"} onChange={(e) => setPaste(e.target.value)} />
              <div className="row-end">
                <button onClick={() => setPasting(false)}>Close</button>
                <button
                  className="primary"
                  disabled={paste.trim() === ""}
                  onClick={() =>
                    void api.invoke("knowledge.import", { text: paste }).then((r) => {
                      if (!r.ok) return setMessage(r.error.message);
                      setMessage(`Added ${r.value.added}${r.value.unreadable > 0 ? `; ${r.value.unreadable} lines were not understood` : ""}.`);
                      if (r.value.unreadable === 0) {
                        setPaste("");
                        setPasting(false);
                      }
                    })
                  }
                >
                  Add these
                </button>
              </div>
            </div>
          )}
          {editing === "new:term" && <EntryForm initial={input("term")} terms={terms} onSave={save} onCancel={() => setEditing(null)} />}
          <ul className="kb-rows">
            {terms
              .filter((t) => matches(t.source, t.target, t.hint, ...factsOf(t).map((f) => f.text)))
              .map((t) => {
                const seen = scenesOf(t);
                return (
                  <li key={t.id} className={t.status === "suggested" ? "kb-row suggested" : "kb-row"}>
                    {editing === t.id ? (
                      formFor(t)
                    ) : (
                      <>
                        <div className="kb-main">
                          <strong>{t.source}</strong> <span className="muted">→</span> {t.target}
                          {t.hint && <span className="kb-hint"> · {t.hint}</span>} <Suggested e={t} />
                        </div>
                        <ul className="kb-facts">
                          {factsOf(t).map((f) => (
                            <li key={f.id}>
                              {editing === f.id ? (
                                formFor(f)
                              ) : (
                                <>
                                  <span>{f.text}</span> <Suggested e={f} />
                                  <Actions e={f} />
                                </>
                              )}
                            </li>
                          ))}
                          {editing === `new:note:${t.id}` && (
                            <li>
                              <EntryForm initial={input("note", { about: t.id })} terms={terms} onSave={save} onCancel={() => setEditing(null)} />
                            </li>
                          )}
                        </ul>
                        <div className="kb-meta-row">
                          <span className="hint">{seen.length > 0 ? `In scenes: ${seen.join(", ")}` : ""}</span>
                          <span className="kb-row-actions">
                            <button className="small" onClick={() => setEditing(`new:note:${t.id}`)}>
                              Add fact
                            </button>
                            {t.status === "suggested" && (
                              <button className="small" onClick={() => confirm([t.id])}>
                                Confirm
                              </button>
                            )}
                            <button className="small" onClick={() => setEditing(t.id)}>
                              Edit
                            </button>
                            <button className="small" aria-label="Delete" onClick={() => void remove(t)}>
                              ×
                            </button>
                          </span>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
          </ul>
          {(loose.length > 0 || editing === "new:note") && (
            <>
              <h4 className="kb-h">Other notes</h4>
              {editing === "new:note" && <EntryForm initial={input("note")} terms={terms} onSave={save} onCancel={() => setEditing(null)} />}
              <ul className="kb-rows">
                {loose
                  .filter((n) => matches(n.text))
                  .map((n) => (
                    <li key={n.id} className={n.status === "suggested" ? "kb-row suggested" : "kb-row"}>
                      {editing === n.id ? (
                        formFor(n)
                      ) : (
                        <>
                          <div className="kb-main">
                            {n.text} <Suggested e={n} />
                          </div>
                          <div className="kb-meta-row">
                            <span />
                            <Actions e={n} />
                          </div>
                        </>
                      )}
                    </li>
                  ))}
              </ul>
            </>
          )}
          {terms.length === 0 && loose.length === 0 && editing === null && <p className="hint">Nothing here yet. Add terms, paste a list, or use Extract knowledge to let a model read the text.</p>}
          {editing !== "new:note" && (
            <button className="link-button" onClick={() => setEditing("new:note")}>
              Add a note that is not about one term
            </button>
          )}
        </div>
      )}

      {tab === "scenes" && (
        <div className="kb-section">
          <p className="hint">What is happening around each block, with the people present. Each block is translated with its own scene.</p>
          <ul className="kb-rows">
            {scenes
              .filter((s) => matches(s.text, ...s.related.map((r) => byId.get(r)?.source ?? "")))
              .map((s) => (
                <li key={s.id} className={s.status === "suggested" ? "kb-row suggested" : "kb-row"}>
                  {editing === s.id ? (
                    formFor(s)
                  ) : (
                    <>
                      <div className="kb-main">
                        <span className="tag">Block {s.scope?.block ?? "?"}</span> {s.text} <Suggested e={s} />
                      </div>
                      {s.related.length > 0 && (
                        <div className="kb-chips">
                          {s.related.map((r) => (
                            <span key={r} className="chip-static" title={byId.get(r)?.hint}>
                              {byId.get(r)?.target ?? "?"}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="kb-meta-row">
                        <span />
                        <Actions e={s} />
                      </div>
                    </>
                  )}
                </li>
              ))}
          </ul>
          {scenes.length === 0 && <p className="hint">No scenes yet. Extract knowledge describes the scene of every block.</p>}
        </div>
      )}
    </div>
  );
}
