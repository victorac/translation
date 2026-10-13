import { useState } from "react";
import type { DocumentView } from "@ltw/domain";
import { Menu } from "./Popover";

/** The project's documents (chapters, scenes...), at the top of the rail. Click one to open it. */
export function Documents({
  documents,
  activeId,
  busy,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  documents: DocumentView[];
  activeId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");

  const commit = (d: DocumentView) => {
    const next = name.trim();
    setRenaming(null);
    if (next !== "" && next !== d.title) onRename(d.id, next);
  };

  return (
    <section className="docs" aria-label="Documents">
      <div className="rail-head">
        <span className="rail-title">Documents</span>
        <button className="icon-button" aria-label="New document" title="New document" onClick={onCreate}>
          +
        </button>
      </div>
      <ul className="rail-list">
        {documents.map((d) => {
          const active = d.id === activeId;
          const progress = d.total > 0 ? `${d.done}/${d.total}` : d.hasText ? "draft" : "empty";
          return (
            <li key={d.id} className={active ? "rail-item doc active" : "rail-item doc"}>
              {renaming === d.id ? (
                <input
                  className="rename"
                  aria-label={`Rename ${d.title}`}
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={() => commit(d)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit(d);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button
                  className="rail-name"
                  aria-current={active ? "true" : undefined}
                  title={d.title}
                  onClick={() => onSelect(d.id)}
                  onDoubleClick={() => {
                    setName(d.title);
                    setRenaming(d.id);
                  }}
                >
                  <span className="ellipsis">{d.title}</span>
                </button>
              )}
              {renaming !== d.id && <span className="hint count">{progress}</span>}
              <Menu
                label={`Actions for ${d.title}`}
                trigger="⋯"
                items={[
                  {
                    label: "Rename",
                    onSelect: () => {
                      setName(d.title);
                      setRenaming(d.id);
                    },
                  },
                  { label: "Delete…", onSelect: () => onDelete(d.id), disabled: busy, danger: true, separated: true },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
