import { useEffect, useState } from "react";
import { Setup, initialSetup, type SetupState } from "./Setup";
import { Workspace } from "./Workspace";
import { countCells, summarize } from "./status";
import { useWorkspace } from "./useWorkspace";

export function App() {
  const { snapshot, error, clearError, send } = useWorkspace();
  const [setup, setSetup] = useState<SetupState>(initialSetup);

  const hasRevision = !!snapshot?.revision;
  const busy = snapshot?.busy ?? false;
  const canRun = !hasRevision && setup.text.trim() !== "" && setup.models.length > 0;
  const disabledReason = hasRevision
    ? null
    : setup.text.trim() === ""
      ? "Paste some text to translate first."
      : setup.models.length === 0
        ? "Add at least one model."
        : null;

  const run = () => {
    if (!canRun) return;
    void send("job.start", {
      text: setup.text,
      sourceLanguage: setup.sourceLanguage,
      targetLanguage: setup.targetLanguage,
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Local Translation Workbench</h1>
        <div className="toolbar-actions">
          {snapshot && hasRevision && <span className="summary">{summarize(countCells(snapshot))}</span>}
          {!hasRevision && (
            <>
              {disabledReason && <span className="muted">{disabledReason}</span>}
              <button className="primary" onClick={run} disabled={!canRun} title="Ctrl/Cmd + Enter">
                Run
              </button>
            </>
          )}
          {hasRevision && busy && (
            <button onClick={() => void send("job.cancel", { kind: "job" })} className="danger">
              Cancel everything
            </button>
          )}
          {hasRevision && !busy && (
            <button
              onClick={() => {
                void send("workspace.reset");
              }}
              title="Go back to the paste screen. The current results are discarded in this early version."
            >
              Edit source (starts over)
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="banner error-banner" role="alert">
          {error}
          <button onClick={clearError} aria-label="Dismiss message">
            Dismiss
          </button>
        </div>
      )}

      <main>
        {!snapshot ? (
          <p className="muted pad">Loading…</p>
        ) : snapshot.revision ? (
          <Workspace snap={snapshot} send={send} />
        ) : (
          <Setup value={setup} onChange={setSetup} />
        )}
      </main>
    </div>
  );
}
