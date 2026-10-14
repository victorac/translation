import { useEffect, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "@ltw/domain";
import { Menu } from "./Popover";
import { countCells } from "./status";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];

/** The project's name, which becomes a field to rename it when clicked. */
function ProjectName({ title, path, onRename }: { title: string; path: string | null; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(title), [title]);
  useEffect(() => {
    if (editing) box.current?.select();
  }, [editing]);
  const done = (save: boolean) => {
    setEditing(false);
    if (save && value.trim() !== title) onRename(value);
    else setValue(title);
  };
  return editing ? (
    <input
      ref={box}
      className="project-name-input"
      aria-label="Project name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
    />
  ) : (
    <button className="project-name" title={`${path ?? "Not saved yet"}\nClick to rename`} onClick={() => setEditing(true)}>
      {title}
    </button>
  );
}

/**
 * The top line: the project's name on the left; on the right the two ways of translating, the knowledge base, the file menu
 * (open, save, export) and the settings.
 */
export function Toolbar({
  snap,
  send,
  canRun,
  runHint,
  onRun,
  onSettings,
  onExport,
  confirmDiscard,
  splitCount,
  onSplit,
  knowledge,
  guided,
}: {
  snap: WorkspaceSnapshot | null;
  send: Send;
  canRun: boolean;
  /** Why Translate is unavailable, in a couple of words. */
  runHint: string | null;
  onRun: () => void;
  onSettings: () => void;
  onExport: () => void;
  confirmDiscard: (what: string) => boolean;
  /** Number of blocks the editor text would make, or null if unknown. */
  splitCount: number | null;
  onSplit: () => void;
  /** The knowledge base pane: whether it is showing, how many entries there are, and how many are waiting to be checked. */
  knowledge: { open: boolean; count: number; suggested: number; onToggle: () => void };
  /** Deep translate, the block-by-block way: whether its screen is showing. */
  guided: { open: boolean; onToggle: () => void };
}) {
  const project = snap?.project;
  const has = !!snap?.revision;
  const busy = snap?.busy ?? false;
  const c = snap ? countCells(snap) : null;
  const pct = c && c.total > 0 ? Math.round(((c.done + c.failed + c.canceled + c.review) / c.total) * 100) : 0;

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <ProjectName title={project?.title ?? "Untitled"} path={project?.path ?? null} onRename={(title) => void send("project.rename", { title })} />
        {project?.dirty && (
          <span className="dirty" title="Unsaved changes" role="img" aria-label="Unsaved changes">
            ●
          </span>
        )}
        {snap && snap.versions.length > 1 && (
          <select aria-label="Version of the text" className="version-select" value={snap.viewingId ?? ""} onChange={(e) => void send("version.view", { versionId: e.target.value })}>
            {snap.versions.map((v) => (
              <option key={v.id} value={v.id}>
                Version {v.number}
                {v.id === snap.latestId ? " (latest)" : ""}
              </option>
            ))}
          </select>
        )}
        {splitCount !== null && (
          <button className="link-button" onClick={onSplit} title="How the text will be split into blocks">
            {splitCount} {splitCount === 1 ? "block" : "blocks"}
          </button>
        )}
      </div>

      <div className="toolbar-right">
        {busy && c && (
          <span className="progress" role="img" aria-label={`${pct}% finished`} title={`${c.done} of ${c.total} done`}>
            <span className="progress-fill" style={{ width: `${pct}%` }} />
          </span>
        )}
        {!busy && runHint && <span className="hint">{runHint}</span>}
        <button className={guided.open ? "primary pressed" : "primary"} aria-pressed={guided.open} onClick={guided.onToggle} title="Translate one block at a time, checking the words, who is speaking and the result">
          Deep translate
        </button>
        {busy ? (
          <button className="danger" onClick={() => void send("job.cancel", { kind: "job" })} title="Stop everything">
            ■ Stop
          </button>
        ) : (
          <button onClick={onRun} disabled={!canRun} title="Translate the whole text with every model (Ctrl/Cmd + Enter)">
            Translate
          </button>
        )}
        <span className="sep" />
        <button className={knowledge.open ? "toggle on" : "toggle"} aria-pressed={knowledge.open} onClick={knowledge.onToggle} title="Show or hide the knowledge base">
          Knowledge base
          {knowledge.count > 0 && <span className="count">{knowledge.count}</span>}
          {knowledge.suggested > 0 && <span className="tag warn-tag">{knowledge.suggested} to check</span>}
        </button>
        <Menu
          label="File"
          trigger="File ▾"
          items={[
            { label: "Open…", onSelect: () => confirmDiscard("Opening another project") && void send("project.open", { useBackup: false }), disabled: busy || !!project?.recovery },
            { label: "Save", onSelect: () => void send("project.save", { saveAs: false }), disabled: !has },
            { label: "Save as…", onSelect: () => void send("project.save", { saveAs: true }), disabled: !has },
            { label: "Export…", onSelect: onExport, disabled: !has },
            { label: "New project", onSelect: () => confirmDiscard("Starting a new project") && void send("project.new"), disabled: busy, separated: true },
          ]}
        />
        <button className="icon-button" onClick={onSettings} aria-label="Settings" title="Settings">
          ⚙
        </button>
      </div>
    </header>
  );
}
