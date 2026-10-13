import { useState } from "react";
import type { ModelSetting, RunView, WorkspaceSnapshot } from "@ltw/domain";
import { ConnectionStatus } from "./ConnectionStatus";
import { Documents } from "./Documents";
import { Menu } from "./Popover";
import { ModelEditor } from "./ModelEditor";
import { IconButton } from "./Cell";
import { countCells } from "./status";
import { labelOf, newModel, type SetupState } from "./setup";
import type { useProvider } from "./useProvider";
import type { useWorkspace } from "./useWorkspace";

type Send = ReturnType<typeof useWorkspace>["send"];

interface Entry {
  label: string;
  config: ModelSetting | null;
  configIndex: number;
  run: RunView | null;
}

/** The models in this project, with their progress. Add, adjust, hide, redo or remove them here. */
export function Rail({
  snap,
  setup,
  onSetup,
  send,
  hidden,
  onToggleHidden,
  discovered,
  viewingLatest,
  onRunAgain,
  provider,
  onSettings,
  docs,
  layoutControl,
}: {
  snap: WorkspaceSnapshot | null;
  setup: SetupState;
  onSetup: (s: SetupState) => void;
  send: Send;
  hidden: Set<string>;
  onToggleHidden: (label: string) => void;
  discovered: string[];
  viewingLatest: boolean;
  onRunAgain: (label: string) => void;
  provider: ReturnType<typeof useProvider>;
  onSettings: () => void;
  /** How the workspace is arranged, and ways to change it. */
  layoutControl: { mode: "aligned" | "panes"; linked: boolean; onMode: (m: "aligned" | "panes") => void; onLinked: (l: boolean) => void; onReset: () => void };
  docs: {
    onSelect: (id: string) => void;
    onCreate: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
  };
}) {
  const [adding, setAdding] = useState(false);
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const runs = snap?.runs ?? [];
  const busy = snap?.busy ?? false;
  const entries: Entry[] = [];
  if (viewingLatest) {
    setup.models.forEach((m, i) => {
      const label = labelOf(m, setup);
      entries.push({ label, config: m, configIndex: i, run: runs.find((r) => r.label === label) ?? null });
    });
  }
  for (const r of runs) if (!entries.some((e) => e.run?.id === r.id)) entries.push({ label: r.label, config: null, configIndex: -1, run: r });

  const takenLabels = (except: number) => new Set(setup.models.filter((_, i) => i !== except).map((m) => labelOf(m, setup)));
  const remove = async (e: Entry) => {
    if (e.run) await send("run.archive", { runId: e.run.id });
    if (e.config) onSetup({ ...setup, models: setup.models.filter((_, i) => i !== e.configIndex) });
  };

  return (
    <nav className="rail" aria-label="Documents and models">
      {snap && (
        <Documents
          documents={snap.documents}
          activeId={snap.activeDocumentId}
          busy={busy}
          onSelect={docs.onSelect}
          onCreate={docs.onCreate}
          onRename={docs.onRename}
          onDelete={docs.onDelete}
        />
      )}
      <div className="rail-head">
        <span className="rail-title">Models</span>
        <span className="rail-reset">
          <Menu
            label="Layout"
            trigger="Layout"
            items={[
              { label: `${layoutControl.mode === "aligned" ? "✓ " : ""}Aligned columns`, onSelect: () => layoutControl.onMode("aligned") },
              { label: `${layoutControl.mode === "panes" ? "✓ " : ""}Free panes`, onSelect: () => layoutControl.onMode("panes") },
              { label: `${layoutControl.linked ? "✓ " : ""}Link scrolling (panes)`, onSelect: () => layoutControl.onLinked(!layoutControl.linked), disabled: layoutControl.mode !== "panes", separated: true },
              { label: "Reset layout", onSelect: layoutControl.onReset },
            ]}
          />
        </span>
        <button className="icon-button" aria-label="Add a model" title="Add a model" aria-expanded={adding} onClick={() => setAdding((x) => !x)}>
          {adding ? "−" : "+"}
        </button>
      </div>

      {adding && (
        <div className="rail-inline">
          {discovered.length > 0 && (
            <div className="quick-add">
              <span className="hint">From the server — click to add</span>
              <ul className="chips">
                {discovered.map((id) => {
                  const taken = takenLabels(-1).has(labelOf(newModel(id), setup));
                  return (
                    <li key={id}>
                      <button
                        className="chip"
                        disabled={taken}
                        onClick={() => {
                          onSetup({ ...setup, models: [...setup.models, newModel(id)] });
                          setAdding(false);
                        }}
                      >
                        {taken ? "✓ " : "+ "}
                        {id}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <span className="hint">…or type a name below</span>
            </div>
          )}
          <ModelEditor
            initial={null}
            setup={setup}
            discovered={discovered}
            takenLabels={takenLabels(-1)}
            existingRun={false}
            onSave={(m) => {
              onSetup({ ...setup, models: [...setup.models, m] });
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      {entries.length === 0 && <p className="hint pad">Add a model to start.</p>}
      <ul className="rail-list">
        {entries.map((e) => {
          const c = e.run ? countCells(snap!, e.run.id) : null;
          const state = e.run?.state;
          const status = !e.run ? "idle" : state === "running" || state === "queued" ? "running" : state === "waiting" ? "waiting" : c && c.done === c.total ? "done" : c && (c.failed || c.review || c.stale || c.canceled) ? "issues" : "idle";
          const glyph = { idle: "○", running: "◔", waiting: "⏸", done: "✓", issues: "⚠" }[status];
          const words = { idle: "Not run", running: "Translating", waiting: "Waiting", done: "Done", issues: "Needs attention" }[status];
          const isHidden = hidden.has(e.label);
          const unfinished = e.run ? Object.values(e.run.blocks).some((b) => ["failed", "canceled", "pending", "waiting"].includes(b.state)) : false;
          const sub = e.run?.promptName && e.run.promptName !== "Standard" ? e.run.promptName : null;
          return (
            <li key={e.label} className={isHidden ? "rail-item hiddenx" : "rail-item"}>
              <span className={`dot dot-${status}`} role="img" aria-label={words}>
                {glyph}
              </span>
              {e.config ? (
                <button className="rail-name" title={e.label} aria-expanded={openLabel === e.label} onClick={() => setOpenLabel(openLabel === e.label ? null : e.label)}>
                  <span className="ellipsis">{e.config.name}</span>
                  {sub && <span className="hint ellipsis">{sub}</span>}
                </button>
              ) : (
                <span className="rail-name static" title={e.label}>
                  <span className="ellipsis">{e.run?.settings.modelId ?? e.label}</span>
                  {sub && <span className="hint ellipsis">{sub}</span>}
                </span>
              )}
              {e.run && e.run.outdated > 0 && (
                <span className="outdated-mark" title={`${e.run.outdated} block${e.run.outdated === 1 ? "" : "s"} translated with older settings. Run to update.`}>
                  ↻{e.run.outdated}
                </span>
              )}
              {c && (
                <span className="hint count">
                  {c.done}/{c.total}
                </span>
              )}
              <IconButton label={isHidden ? `Show ${e.label}` : `Hide ${e.label}`} onClick={() => onToggleHidden(e.label)}>
                {isHidden ? "◌" : "◉"}
              </IconButton>
              <Menu
                label={`Actions for ${e.label}`}
                trigger="⋯"
                items={[
                  { label: "Cancel", onSelect: () => e.run && void send("job.cancel", { kind: "run", runId: e.run.id }), disabled: !e.run || !["running", "queued", "waiting"].includes(e.run.state) },
                  { label: "Retry unfinished", onSelect: () => e.run && void send("run.retryUnfinished", { runId: e.run.id }), disabled: !e.run || busy || !unfinished },
                  { label: "Retranslate out-of-date", onSelect: () => e.run && void send("run.retranslateDownstream", { runId: e.run.id }), disabled: !e.run || busy || !(c && c.stale > 0) },
                  { label: "Translate everything again", onSelect: () => onRunAgain(e.label), disabled: !e.run || !e.config || busy || !viewingLatest },
                  { label: "Remove", onSelect: () => void remove(e), danger: true, separated: true },
                ]}
              />
              {e.config && openLabel === e.label && (
                <div className="rail-inline">
                  <ModelEditor
                    live
                    initial={e.config}
                    setup={setup}
                    discovered={discovered}
                    takenLabels={takenLabels(e.configIndex)}
                    existingRun={!!e.run}
                    onSave={(m) => onSetup({ ...setup, models: setup.models.map((x, i) => (i === e.configIndex ? m : x)) })}
                    onCancel={() => setOpenLabel(null)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {snap && snap.archived.length > 0 && (
        <details className="removed">
          <summary>Removed ({snap.archived.length})</summary>
          <ul className="rail-list">
            {snap.archived.map((a) => (
              <li key={a.runId} className="rail-item">
                <span className="rail-name static ellipsis" title={a.label}>
                  {a.label}
                </span>
                <button className="small" onClick={() => void send("run.restore", { runId: a.runId })}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="rail-spacer" />
      <ConnectionStatus backend={setup.backend} provider={provider} onSettings={onSettings} />
    </nav>
  );
}

