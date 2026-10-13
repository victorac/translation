import { useState } from "react";
import { entriesToText, entryProblems, type EntryInput, type EntryKind, type EntryStatus, type KnowledgeEntry } from "@ltw/domain/pure";
import { api } from "./api";
import { useKnowledgeList } from "./useKnowledge";

const blank = (kind: EntryKind): EntryInput => ({ kind, source: "", target: "", hint: "", keys: [], text: "" });
const fromEntry = (e: KnowledgeEntry): EntryInput => ({ id: e.id, kind: e.kind, source: e.source, target: e.target, hint: e.hint, keys: e.keys, text: e.text });

function fromWhere(e: KnowledgeEntry): { short: string; long: string } {
  if (e.origin.by === "user") return { short: "You", long: "Written by you" };
  const place = [e.origin.documentTitle, e.origin.block ? `block ${e.origin.block}` : null].filter(Boolean).join(", ");
  return { short: e.origin.model ?? "Model", long: `Suggested by ${e.origin.model ?? "a model"}${place ? ` from ${place}` : ""}` };
}

function EntryForm({ initial, onSave, onCancel }: { initial: EntryInput; onSave: (e: EntryInput) => Promise<string | null>; onCancel: () => void }) {
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
      {!e.id && (
        <div className="segmented small" role="radiogroup" aria-label="Kind">
          <button type="button" role="radio" aria-checked={e.kind === "term"} className={e.kind === "term" ? "on" : ""} onClick={() => set({ kind: "term" })}>
            Name or term
          </button>
          <button type="button" role="radio" aria-checked={e.kind === "note"} className={e.kind === "note" ? "on" : ""} onClick={() => set({ kind: "note" })}>
            Note
          </button>
        </div>
      )}
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
          <label className="wide">
            Applies when these words appear (empty: every block)
            <input autoFocus value={e.keys.join(", ")} onChange={(ev) => set({ keys: ev.target.value.split(/[,、，]/) })} />
          </label>
          <label className="wide">
            Note
            <textarea rows={2} value={e.text} onChange={(ev) => set({ text: ev.target.value })} />
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

/** The project's names, hints and notes: search, filter, edit, confirm what a model suggested, add or paste more. */
export function KnowledgeTable({ rev }: { rev: number }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<EntryKind | "">("");
  const [status, setStatus] = useState<EntryStatus | "">("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const list = useKnowledgeList(rev, { ...(text.trim() ? { text } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) });

  const save = async (input: EntryInput): Promise<string | null> => {
    const r = await api.invoke("knowledge.save", input);
    if (!r.ok) return r.error.message;
    setEditing(null);
    return null;
  };
  const remove = async (e: KnowledgeEntry) => {
    if (e.origin.by === "user" && !window.confirm(`Delete "${e.kind === "term" ? e.source : e.text.slice(0, 40)}"?`)) return;
    await api.invoke("knowledge.remove", { ids: [e.id] });
  };
  const counts = list?.counts;

  return (
    <div className="kb-table">
      <div className="kb-bar">
        <input type="search" aria-label="Search names and notes" placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Show" value={kind} onChange={(e) => setKind(e.target.value as EntryKind | "")}>
          <option value="">All</option>
          <option value="term">Names & terms</option>
          <option value="note">Notes</option>
        </select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as EntryStatus | "")}>
          <option value="">Any status</option>
          <option value="suggested">Suggested</option>
          <option value="confirmed">Confirmed</option>
        </select>
      </div>
      <div className="kb-bar">
        <span className="hint">
          {counts ? `${counts.terms} names · ${counts.notes} notes` : ""}
          {list && list.total !== counts!.terms + counts!.notes ? ` · ${list.total} shown` : ""}
        </span>
        <span className="kb-actions">
          {counts && counts.suggested > 0 && (
            <button className="small" onClick={() => void api.invoke("knowledge.confirm", {})} title="Mark everything a model suggested as checked">
              Confirm {counts.suggested} suggested
            </button>
          )}
          <button className="small" onClick={() => setPasting((p) => !p)}>
            Paste list
          </button>
          <button
            className="small"
            onClick={() =>
              void api.invoke("knowledge.list", {}).then(async (r) => {
                if (!r.ok) return setMessage(r.error.message);
                try {
                  await navigator.clipboard.writeText(entriesToText(r.value.entries));
                  setMessage("Copied as text.");
                } catch {
                  setMessage("Could not copy.");
                }
              })
            }
          >
            Copy as text
          </button>
          <button className="small primary" onClick={() => setEditing("new")}>
            Add
          </button>
        </span>
      </div>
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}
      {pasting && (
        <div className="kb-form">
          <textarea rows={4} value={paste} placeholder={"魔王 = Demon King # villain\n> 魔王 | He speaks formally.\n> A note for every block"} onChange={(e) => setPaste(e.target.value)} />
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
      {editing === "new" && <EntryForm initial={blank("term")} onSave={save} onCancel={() => setEditing(null)} />}
      {list && list.entries.length === 0 && editing !== "new" && <p className="hint">{counts && counts.terms + counts.notes > 0 ? "Nothing matches." : "Nothing here yet. Add names and notes, paste a list, or let a model suggest them."}</p>}
      <ul className="kb-rows">
        {list?.entries.map((e) => {
          const w = fromWhere(e);
          return (
            <li key={e.id} className={e.status === "suggested" ? "kb-row suggested" : "kb-row"}>
              {editing === e.id ? (
                <EntryForm initial={fromEntry(e)} onSave={save} onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <div className="kb-main">
                    {e.kind === "term" ? (
                      <>
                        <strong>{e.source}</strong> <span className="muted">→</span> {e.target}
                        {e.hint && <span className="kb-hint"> · {e.hint}</span>}
                      </>
                    ) : (
                      <>
                        <span className="kb-keys">{e.keys.length > 0 ? e.keys.join(", ") : "every block"}</span>
                        <span className="muted"> · </span>
                        {e.text}
                      </>
                    )}
                  </div>
                  <div className="kb-meta-row">
                    <span className={e.status === "suggested" ? "tag warn-tag" : "hint"} title={w.long}>
                      {e.status === "suggested" ? `Suggested · ${w.short}` : w.short}
                    </span>
                    <span className="kb-row-actions">
                      {e.status === "suggested" && (
                        <button className="small" onClick={() => void api.invoke("knowledge.confirm", { ids: [e.id] })}>
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
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
