import type { WorkspaceSnapshot } from "@ltw/domain";
import { Menu } from "./Popover";
import { countCells } from "./status";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];

/** Run, save and export on one slim line. */
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
  researcher,
  onExtract,
  canExtract,
  extractHint,
}: {
  snap: WorkspaceSnapshot | null;
  send: Send;
  canRun: boolean;
  /** Why Run is unavailable, in a couple of words. */
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
  /** The model that reads the text for knowledge and chooses the background for each block. */
  researcher: { models: string[]; value: string | null; onChange: (name: string) => void };
  onExtract: () => void;
  canExtract: boolean;
  extractHint: string;
}) {
  const project = snap?.project;
  const has = !!snap?.revision;
  const busy = snap?.busy ?? false;
  const c = snap ? countCells(snap) : null;
  const pct = c && c.total > 0 ? Math.round(((c.done + c.failed + c.canceled + c.review) / c.total) * 100) : 0;

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <span className="project-name" title={project?.path ?? "Not saved yet"}>
          {project?.title ?? "Untitled"}
        </span>
        {project?.dirty && (
          <span className="dirty" title="Unsaved changes" role="img" aria-label="Unsaved changes">
            ●
          </span>
        )}
        {snap && snap.versions.length > 1 && (
          <select
            aria-label="Version of the text"
            className="version-select"
            value={snap.viewingId ?? ""}
            onChange={(e) => void send("version.view", { versionId: e.target.value })}
          >
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
        <button className={knowledge.open ? "toggle on" : "toggle"} aria-pressed={knowledge.open} onClick={knowledge.onToggle} title="Show or hide the knowledge base">
          Knowledge base
          {knowledge.count > 0 && <span className="count">{knowledge.count}</span>}
          {knowledge.suggested > 0 && <span className="tag warn-tag">{knowledge.suggested} to check</span>}
        </button>
        <label className="inline-select" title="The model that reads the text for the knowledge base and chooses the background for each block">
          Researcher
          <select value={researcher.value ?? ""} onChange={(e) => researcher.onChange(e.target.value)} disabled={researcher.models.length === 0}>
            {researcher.models.length === 0 && <option value="">No model</option>}
            {researcher.models.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button onClick={onExtract} disabled={!canExtract || busy} title={extractHint}>
          Extract knowledge
        </button>
        {!busy && runHint && <span className="hint">{runHint}</span>}
        {busy ? (
          <button className="danger" onClick={() => void send("job.cancel", { kind: "job" })} title="Stop everything">
            ■ Stop
          </button>
        ) : (
          <button className="primary" onClick={onRun} disabled={!canRun} title="Run (Ctrl/Cmd + Enter)">
            ▶ Run
          </button>
        )}
        <span className="sep" />
        <button onClick={() => confirmDiscard("Opening another project") && void send("project.open", { useBackup: false })} disabled={busy || !!project?.recovery}>
          Open
        </button>
        <button className={project?.dirty ? "emph" : undefined} onClick={() => void send("project.save", { saveAs: false })} disabled={!has} title="Save (Ctrl/Cmd + S)">
          Save
        </button>
        <button onClick={onExport} disabled={!has}>
          Export
        </button>
        <button className="icon-button" onClick={onSettings} aria-label="Settings" title="Settings">
          ⚙
        </button>
        <Menu
          label="More"
          trigger="⋯"
          items={[
            { label: "Save as…", onSelect: () => void send("project.save", { saveAs: true }), disabled: !has },
            { label: "New project", onSelect: () => confirmDiscard("Starting a new project") && void send("project.new"), disabled: busy, separated: true },
          ]}
        />
      </div>
    </header>
  );
}
