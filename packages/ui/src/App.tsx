import { useEffect, useState } from "react";
import { ExportDialog } from "./ExportDialog";
import { Setup, initialSetup, type SetupState } from "./Setup";
import { Workspace } from "./Workspace";
import { countCells, summarize } from "./status";
import { useProvider } from "./useProvider";
import { useWorkspace } from "./useWorkspace";

export function App() {
  const { snapshot, error, clearError, send } = useWorkspace();
  const provider = useProvider();
  const [setup, setSetup] = useState<SetupState>(initialSetup);
  const [exporting, setExporting] = useState(false);

  const hasRevision = !!snapshot?.revision;
  const project = snapshot?.project;
  const dirty = project?.dirty ?? false;
  const busy = snapshot?.busy ?? false;
  const canRun = !hasRevision && setup.text.trim() !== "" && setup.models.length > 0 && !(setup.backend === "provider" && provider.view?.problem);
  const disabledReason = hasRevision
    ? null
    : setup.text.trim() === ""
      ? "Paste some text to translate first."
      : setup.models.length === 0
        ? "Add at least one model."
        : setup.backend === "provider" && provider.view?.problem
          ? "The server address cannot be used yet (see step 3)."
          : null;

  const run = () => {
    if (!canRun) return;
    void send("job.start", {
      text: setup.text,
      sourceLanguage: setup.sourceLanguage,
      targetLanguage: setup.targetLanguage,
      backend: setup.backend,
      models: setup.models,
      demo: setup.demo,
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (hasRevision) void send("project.save", { saveAs: e.shiftKey });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    document.title = `${dirty ? "● " : ""}${project?.title ?? "Untitled"} – Local Translation Workbench`;
  }, [dirty, project?.title]);

  const confirmDiscard = (what: string): boolean =>
    !dirty || window.confirm(`This project has unsaved changes. ${what} will discard them. Continue?`);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-title">
          <h1>Local Translation Workbench</h1>
          <span className="project-name" title={project?.path ?? "Not saved yet"}>
            {project?.title ?? "Untitled"}
            {hasRevision && (
              <span className={dirty ? "save-state unsaved" : "save-state"}>
                {dirty ? " · Unsaved changes" : project?.path ? " · Saved" : ""}
              </span>
            )}
          </span>
        </div>
        <div className="toolbar-actions">
          {snapshot && hasRevision && <span className="summary">{summarize(countCells(snapshot))}</span>}
          {!hasRevision && disabledReason && <span className="muted">{disabledReason}</span>}
          <button
            onClick={() => confirmDiscard("Opening another project") && void send("project.open", { useBackup: false })}
            disabled={busy || !!project?.recovery}
          >
            Open…
          </button>
          {hasRevision && (
            <>
              <button className={dirty ? "primary" : undefined} onClick={() => void send("project.save", { saveAs: false })} title="Ctrl/Cmd + S">
                Save
              </button>
              <button onClick={() => void send("project.save", { saveAs: true })} title="Ctrl/Cmd + Shift + S">
                Save As…
              </button>
              <button onClick={() => setExporting(true)}>Export…</button>
            </>
          )}
          {!hasRevision && (
            <button className="primary" onClick={run} disabled={!canRun} title="Ctrl/Cmd + Enter">
              Run
            </button>
          )}
          {hasRevision && busy && (
            <button onClick={() => void send("job.cancel", { kind: "job" })} className="danger">
              Cancel everything
            </button>
          )}
          {hasRevision && !busy && (
            <button
              onClick={() => confirmDiscard("Starting a new project") && void send("project.new")}
              title="Close this project and go back to the paste screen"
            >
              New
            </button>
          )}
        </div>
      </header>

      {project?.recovery && (
        <div className="banner warn-box" role="alert">
          <span>
            <strong>Unsaved work from last time was found.</strong> It has {project.recovery.blocks} blocks and {project.recovery.models} model
            {project.recovery.models === 1 ? "" : "s"}, last updated {new Date(project.recovery.updatedAt).toLocaleString()}.
          </span>
          <span className="actions">
            <button className="primary" onClick={() => void send("project.restoreRecovery")}>
              Restore it
            </button>
            <button onClick={() => window.confirm("Discard the recovered work? This cannot be undone.") && void send("project.discardRecovery")}>Discard</button>
          </span>
        </div>
      )}
      {project?.openProblem && (
        <div className="banner error-banner" role="alert">
          <span>{project.openProblem.message}</span>
          <span className="actions">
            {project.openProblem.canOpenBackup && (
              <button className="primary" onClick={() => void send("project.open", { useBackup: true })}>
                Open the previous saved copy
              </button>
            )}
            <button onClick={() => void send("project.dismissProblem")}>Dismiss</button>
          </span>
        </div>
      )}
      {project?.notice && !project.openProblem && (
        <div className="banner info-box" role="status">
          <span>{project.notice}</span>
          <button onClick={() => void send("project.dismissProblem")}>Dismiss</button>
        </div>
      )}

      {error && (
        <div className="banner error-banner" role="alert">
          {error}
          <button onClick={clearError} aria-label="Dismiss message">
            Dismiss
          </button>
        </div>
      )}

      {exporting && snapshot?.revision && <ExportDialog snap={snapshot} onClose={() => setExporting(false)} />}

      <main>
        {!snapshot ? (
          <p className="muted pad">Loading…</p>
        ) : snapshot.revision ? (
          <Workspace snap={snapshot} send={send} />
        ) : (
          <Setup value={setup} onChange={setSetup} provider={provider} />
        )}
      </main>
    </div>
  );
}
