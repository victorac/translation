import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeFiles as FileList } from "@ltw/domain";
import { api } from "./api";
import { TopicEditor, type Problem } from "./TopicEditor";

const KEY = "ltw.kbtabs.v1";

function loadTabs(): { open: string[]; active: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { open?: unknown; active?: unknown } | null;
    const open = Array.isArray(raw?.open) ? raw!.open.filter((x): x is string => typeof x === "string") : [];
    return { open, active: typeof raw?.active === "string" ? raw.active : null };
  } catch {
    return { open: [], active: null };
  }
}

/**
 * The knowledge base as files: a list of topics (and scenes, summaries, notes and classes) you can search, open in tabs
 * and edit as text. Links between files can be followed, and each file shows what links to it.
 */
export function KnowledgeFiles({ rev, counts, onRewriteSummary }: { rev: number; counts: { terms: number; notes: number; suggested: number }; onRewriteSummary?: ((documentId: string) => void) | undefined }) {
  const [list, setList] = useState<FileList | null>(null);
  const [tabs, setTabs] = useState(loadTabs);
  const [query, setQuery] = useState("");
  const [onlyChecking, setOnlyChecking] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [creating, setCreating] = useState<{ type: string; name: string } | null>(null);
  const [loaded, setLoaded] = useState<{ title: string; problems: Problem[]; backlinks: { id: string; title: string }[] } | null>(null);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const resolving = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    void api.invoke("knowledge.files").then((r) => live && r.ok && setList(r.value));
    return () => {
      live = false;
    };
  }, [rev]);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(tabs));
    } catch {
      /* the open tabs then last for this session only */
    }
  }, [tabs]);

  const files = list?.files ?? [];
  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  // Tabs for files that no longer exist are dropped once the list is known.
  const open = list ? tabs.open.filter((id) => byId.has(id)) : tabs.open;
  const active = tabs.active && open.includes(tabs.active) ? tabs.active : (open[0] ?? null);

  const openFile = useCallback((id: string) => setTabs((t) => ({ open: t.open.includes(id) ? t.open : [...t.open, id], active: id })), []);
  const closeFile = (id: string) =>
    setTabs((t) => {
      const next = t.open.filter((x) => x !== id);
      return { open: next, active: t.active === id ? (next[next.indexOf(id) - 1] ?? next[0] ?? null) : t.active };
    });

  const q = query.trim().toLocaleLowerCase();
  const shown = files.filter((f) => (!onlyChecking || f.suggested) && (q === "" || `${f.title} ${f.subtitle}`.toLocaleLowerCase().includes(q)));
  const groups = [...new Set(shown.map((f) => f.groupLabel))].map((label) => ({ label, files: shown.filter((f) => f.groupLabel === label) }));

  // The links in the file being edited, and which of them lead somewhere.
  const links = useMemo(() => [...new Set([...typed.matchAll(/\[\[(.*?)\]\]/g)].map((m) => m[1]!.trim()).filter(Boolean))], [typed]);
  useEffect(() => {
    resolving.current.clear();
    setResolved({});
  }, [rev]);
  useEffect(() => {
    for (const name of links) {
      if (resolving.current.has(name)) continue;
      resolving.current.add(name);
      void api.invoke("knowledge.resolve", { name }).then((r) => r.ok && setResolved((x) => ({ ...x, [name]: r.value.id })));
    }
  }, [links, rev]);

  const follow = async (name: string, key = "") => {
    const r = await api.invoke("knowledge.resolve", { name });
    if (r.ok && r.value.id) return openFile(r.value.id);
    // No topic of that name yet: offer to make one, as the kind the attribute points to when that is known.
    const type = list?.classes.find((c) => c.name === key)?.name ?? "term";
    if (window.confirm(`There is no topic called "${name}". Create it?`)) {
      const made = await api.invoke("knowledge.create", { type, name });
      if (made.ok) openFile(made.value.id);
      else setMessage(made.error.message);
    }
  };

  const create = async () => {
    if (!creating || creating.name.trim() === "") return;
    const r = await api.invoke("knowledge.create", { type: creating.type, name: creating.name.trim() });
    if (!r.ok) return setMessage(r.error.message);
    setCreating(null);
    openFile(r.value.id);
  };

  const deletable = active && byId.get(active) && ["topic", "scene", "summary"].includes(byId.get(active)!.kind);

  return (
    <div className="kbf">
      <div className="kbf-bar">
        <span className="hint">
          {counts.terms} {counts.terms === 1 ? "topic" : "topics"}
          {counts.suggested > 0 && ` · ${counts.suggested} to check`}
        </span>
        <span className="kb-actions">
          {counts.suggested > 0 && (
            <button className="small" onClick={() => void api.invoke("knowledge.confirm", {})} title="Accept everything a model suggested">
              Accept all
            </button>
          )}
          <button
            className="small"
            onClick={() =>
              void api.invoke("knowledge.check").then((r) => setMessage(r.ok ? (r.value.found === 0 ? "No problems found." : `${r.value.found} possible ${r.value.found === 1 ? "problem" : "problems"}. They are noted as "Check:" on the topics concerned.`) : r.error.message))
            }
            title="Look through the knowledge base for names that clash and links that lead nowhere"
          >
            Check
          </button>
          <button className="small" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>
            {listOpen ? "Hide files" : "Files"}
          </button>
          <button className="small primary" onClick={() => setCreating(creating ? null : { type: list?.classes[0]?.name ?? "character", name: "" })}>
            New topic
          </button>
        </span>
      </div>

      {creating && (
        <form
          className="kbf-new"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <select aria-label="Kind of topic" value={creating.type} onChange={(e) => setCreating({ ...creating, type: e.target.value })}>
            {list?.classes.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name[0]?.toLocaleUpperCase()}
                {c.name.slice(1)}
              </option>
            ))}
          </select>
          <input autoFocus placeholder="Name as written in the text" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
          <button type="submit" className="small primary" disabled={creating.name.trim() === ""}>
            Create
          </button>
          <button type="button" className="small" onClick={() => setCreating(null)}>
            Cancel
          </button>
        </form>
      )}
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}

      {listOpen && (
        <div className="kbf-list">
          <div className="kbf-search">
            <input type="search" aria-label="Search the files" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            {counts.suggested > 0 && (
              <label className="check">
                <input type="checkbox" checked={onlyChecking} onChange={(e) => setOnlyChecking(e.target.checked)} />
                To check
              </label>
            )}
          </div>
          {groups.map((g) => (
            <section key={g.label}>
              <h4 className="kb-h">
                {g.label} {g.files.length}
              </h4>
              <ul className="kbf-files">
                {g.files.map((f) => (
                  <li key={f.id}>
                    <button className={f.id === active ? "kbf-file on" : "kbf-file"} onClick={() => openFile(f.id)} title={f.subtitle}>
                      <span className="ellipsis">{f.title}</span>
                      {f.subtitle && f.kind === "topic" && <span className="hint ellipsis">{f.subtitle}</span>}
                      {f.suggested && <span className="tag warn-tag">?</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {list && groups.length === 0 && <p className="hint">Nothing matches.</p>}
        </div>
      )}

      {open.length > 0 && (
        <div className="kbf-tabs" role="tablist">
          {open.map((id) => (
            <span key={id} className={id === active ? "kbf-tab on" : "kbf-tab"}>
              <button role="tab" aria-selected={id === active} onClick={() => setTabs((t) => ({ ...t, active: id }))}>
                {byId.get(id)?.title ?? "…"}
                {byId.get(id)?.suggested && <span className="tag warn-tag">?</span>}
              </button>
              <button className="kbf-x" aria-label={`Close ${byId.get(id)?.title ?? "file"}`} onClick={() => closeFile(id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {active ? (
        <>
          <TopicEditor key={active} id={active} rev={rev} onLink={(name, key) => void follow(name, key)} onLoaded={(f) => setLoaded({ title: f.title, problems: f.problems, backlinks: f.backlinks })} onText={setTyped} />
          <div className="kbf-foot">
            {loaded && loaded.problems.length > 0 && <span className="hint err-text">{loaded.problems.length} to fix</span>}
            {links.length > 0 && (
              <div className="kbf-links">
                <span className="hint">Links:</span>
                {links.map((name) => (
                  <button key={name} className={resolved[name] ? "chip-link" : "chip-link missing"} title={resolved[name] ? "Open" : "No topic of that name yet. Click to create it."} onClick={() => void follow(name)}>
                    {name}
                  </button>
                ))}
              </div>
            )}
            {loaded && loaded.backlinks.length > 0 && (
              <div className="kbf-links">
                <span className="hint">Linked from:</span>
                {loaded.backlinks.map((b) => (
                  <button key={b.id} className="chip-link" onClick={() => openFile(b.id)}>
                    {b.title}
                  </button>
                ))}
              </div>
            )}
            {byId.get(active)?.kind === "summary" && byId.get(active)?.documentId && onRewriteSummary && (
              <button
                className="small"
                onClick={() => {
                  const f = byId.get(active)!;
                  if (!f.suggested && !window.confirm("Replace your summary with a new one written from the scenes?")) return;
                  onRewriteSummary(f.documentId!);
                }}
                title="Write the summary again from the scenes. If the scenes are short, it is just the scenes put together."
              >
                Rewrite summary
              </button>
            )}
            {byId.get(active)?.suggested && (
              <button className="small primary" onClick={() => void api.invoke("knowledge.confirm", { ids: [active] })} title="Accept what a model suggested in this file: the topic, its attributes and its notes">
                Accept this file
              </button>
            )}
            {deletable && (
              <button
                className="small"
                onClick={() => {
                  const f = byId.get(active)!;
                  if (window.confirm(f.suggested ? `Reject "${f.title}"? It will not be suggested again.` : `Delete "${f.title}"?`)) {
                    closeFile(active);
                    void api.invoke("knowledge.delete", { id: active });
                  }
                }}
              >
                {byId.get(active)?.suggested ? "Reject this file" : "Delete this file"}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="hint kbf-empty">{files.length <= 1 ? "No topics yet. Make one with New topic, or use Extract knowledge to let a model read the text." : "Open a file from the list."}</p>
      )}
    </div>
  );
}
