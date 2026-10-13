import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeGlossary, normalizeSource } from "@ltw/domain/pure";
import { ExportDialog } from "./ExportDialog";
import { Grid, type SourceMode } from "./Grid";
import { Rail } from "./Rail";
import { SettingsDrawer, type SettingsTab } from "./SettingsDrawer";
import { Toolbar } from "./Toolbar";
import { Tray } from "./Tray";
import { api } from "./api";
import { labelOf, loadSetup, mergeRunModels, modelsFromRuns, saveSetup, toStartInput, type SetupState } from "./setup";
import { useProvider } from "./useProvider";
import { useSplitPreview } from "./useSplitPreview";
import { useWorkspace } from "./useWorkspace";

/** One screen: the text, the models, the translations side by side, and the controls around them. */
export function App() {
  const { snapshot: snap, error, clearError, send } = useWorkspace();
  const provider = useProvider();
  const [setup, setSetup] = useState<SetupState>(loadSetup);
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const [mode, setMode] = useState<SourceMode | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [trayOpen, setTrayOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const setupRef = useRef(setup);
  setupRef.current = setup;
  useEffect(() => saveSetup(setup), [setup]);

  // Tell the background process which choices decide how blocks are translated, so Retry and Run use the current ones
  // and it can mark blocks translated under older choices.
  const syncKey = JSON.stringify([setup.models, setup.glossary, setup.prompts, setup.sourceLanguage, setup.targetLanguage]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const s = setupRef.current;
      void api.invoke("settings.sync", { sourceLanguage: s.sourceLanguage, targetLanguage: s.targetLanguage, models: s.models, glossary: s.glossary, prompts: s.prompts });
    }, 250);
    return () => clearTimeout(timer);
  }, [syncKey]);

  const hasVersion = !!snap?.revision;
  const viewingLatest = !snap || snap.viewingId === snap.latestId;
  const busy = snap?.busy ?? false;
  const edited = snap?.latestText != null && normalizeSource(setup.text) !== snap.latestText;
  const effectiveMode: SourceMode = mode ?? (hasVersion ? "blocks" : "text");

  // ---- keep the editor and the model list in step with the project ----
  const seenLatest = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!snap) return;
    const first = seenLatest.current === undefined;
    if (!first && seenLatest.current === snap.latestId) return;
    seenLatest.current = snap.latestId;
    const cur = setupRef.current;
    if (snap.latestId === null) {
      if (!first && cur.text !== "") setSetup({ ...cur, text: "" }); // a new project starts with an empty editor
      return;
    }
    // A project was opened or restored (or this is the first load): show its text and models.
    if (snap.latestText !== null && normalizeSource(cur.text) !== snap.latestText) {
      const latestRuns = snap.viewingId === snap.latestId ? snap.runs : [];
      setSetup({ ...cur, text: snap.latestText, ...(latestRuns.length > 0 ? { models: modelsFromRuns(latestRuns) } : {}) });
      setMode(null);
    }
  }, [snap?.latestId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Runs that exist (for example one just brought back) always have a model entry.
  const runKey = snap ? snap.runs.map((r) => r.label).join("\u0000") : "";
  useEffect(() => {
    if (!snap || snap.viewingId !== snap.latestId) return;
    const cur = setupRef.current;
    const merged = mergeRunModels(cur, snap.runs);
    if (merged !== cur.models) setSetup({ ...cur, models: merged });
  }, [runKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- what Run would do, and why it might not ----
  const startInput = useMemo(() => toStartInput(setup), [setup]);
  const split = useSplitPreview(startInput);
  const glossaryProblem = normalizeGlossary(setup.glossary).problems[0] ?? null;
  const splitProblem = split.preview ? (split.preview.problem ?? split.preview.issues[0] ?? null) : null;
  const runHint =
    setup.text.trim() === ""
      ? "No text"
      : setup.models.length === 0
        ? "No model"
        : glossaryProblem
          ? "Glossary problem"
          : splitProblem
            ? "Doesn't fit"
            : setup.backend === "provider" && provider.view?.problem
              ? "Server problem"
              : null;
  const canRun = runHint === null && !busy;

  // Is there anything for Run to do? New text, a model not run yet, unfinished blocks, or blocks translated with older settings.
  const needsRun =
    !snap?.revision ||
    edited ||
    !viewingLatest ||
    setup.models.some((m) => !snap.runs.some((r) => r.label === labelOf(m, setup))) ||
    snap.runs.some((r) => r.unfinished > 0 || r.outdated > 0);

  const run = async (rerun: string[] = []) => {
    if (busy || (rerun.length === 0 && !canRun)) return;
    let labels = rerun;
    if (labels.length === 0 && !needsRun) {
      // Nothing is missing, but the user asked: translate everything again rather than refusing.
      if (!window.confirm("Everything is already translated with the current settings. Translate it all again?")) return;
      labels = setupRef.current.models.map((m) => labelOf(m, setupRef.current));
    }
    setMode(null);
    await send("job.start", toStartInput(setupRef.current, labels));
  };

  // ---- shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void run();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (snap?.revision) void send("project.save", { saveAs: e.shiftKey });
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setTab((t) => (t ? null : "server"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    document.title = `${snap?.project.dirty ? "● " : ""}${snap?.project.title ?? "Untitled"} – Local Translation Workbench`;
  }, [snap?.project.dirty, snap?.project.title]);

  const confirmDiscard = (what: string): boolean => !snap?.project.dirty || window.confirm(`This project has unsaved changes. ${what} will discard them. Continue?`);
  const project = snap?.project;
  const visibleRuns = (snap?.runs ?? []).filter((r) => !hidden.has(r.label));
  // Embedding models cannot translate; leave them out of the suggestions (they can still be typed in).
  const discovered = provider.test?.ok ? provider.test.models.filter((id) => !/embed/i.test(id)) : [];

  return (
    <div className="app">
      <Toolbar
        snap={snap}
        send={send}
        canRun={canRun}
        runHint={runHint}
        onRun={() => void run()}
        onSettings={() => setTab((t) => (t ? null : "server"))}
        onExport={() => setExporting(true)}
        confirmDiscard={confirmDiscard}
        splitCount={split.preview && split.preview.blocks.length > 0 ? split.preview.blocks.length : null}
        onSplit={() => setTab("text")}
      />

      {project?.recovery && (
        <div className="banner warn" role="alert">
          <span>
            Unsaved work from last time ({project.recovery.blocks} blocks, {project.recovery.models} model{project.recovery.models === 1 ? "" : "s"}).
          </span>
          <span className="row">
            <button className="small primary" onClick={() => void send("project.restoreRecovery")}>
              Restore
            </button>
            <button className="small" onClick={() => window.confirm("Discard the recovered work? This cannot be undone.") && void send("project.discardRecovery")}>
              Discard
            </button>
          </span>
        </div>
      )}
      {project?.openProblem && (
        <div className="banner err" role="alert">
          <span>{project.openProblem.message}</span>
          <span className="row">
            {project.openProblem.canOpenBackup && (
              <button className="small primary" onClick={() => void send("project.open", { useBackup: true })}>
                Open previous copy
              </button>
            )}
            <button className="small" onClick={() => void send("project.dismissProblem")}>
              Dismiss
            </button>
          </span>
        </div>
      )}
      {project?.notice && !project.openProblem && (
        <div className="banner info" role="status">
          <span>{project.notice}</span>
          <button className="small" onClick={() => void send("project.dismissProblem")}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <div className="banner err" role="alert">
          <span>{error}</span>
          <button className="small" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}
      {snap?.waiting && (
        <div className="banner warn" role="alert">
          <span>
            <strong>{snap.waiting.label}</strong> is waiting: {snap.waiting.message}
          </span>
          <span className="row">
            {snap.backend === "practice" && snap.waiting.code === "model_unavailable" && snap.demoModelUnloaded && (
              <button className="small" onClick={() => void send("demo.loadModel")}>
                Load model
              </button>
            )}
            <button className="small primary" onClick={() => void send("run.resolveWaiting", { runId: snap.waiting!.runId, resolution: "retry" })}>
              Retry
            </button>
            <button className="small" onClick={() => void send("run.resolveWaiting", { runId: snap.waiting!.runId, resolution: "skip" })}>
              Skip
            </button>
          </span>
        </div>
      )}
      {snap?.job?.stopReason && (
        <div className="banner err" role="alert">
          Stopped: {snap.job.stopReason}
        </div>
      )}

      <div className="body">
        <Rail
          snap={snap}
          setup={setup}
          onSetup={setSetup}
          send={send}
          hidden={hidden}
          onToggleHidden={(label) =>
            setHidden((h) => {
              const next = new Set(h);
              if (!next.delete(label)) next.add(label);
              return next;
            })
          }
          discovered={discovered}
          viewingLatest={viewingLatest}
          onRunAgain={(label) => void run([label])}
          provider={provider}
          onSettings={() => setTab("server")}
        />

        <main className="center">
          {snap && hasVersion && !viewingLatest && (
            <div className="strip">
              <span>Looking at an earlier version of the text.</span>
              <button className="small" onClick={() => void send("version.view", { versionId: snap.latestId! })}>
                Back to latest
              </button>
            </div>
          )}
          {snap && hasVersion && viewingLatest && edited && (
            <div className="strip">
              <span>Text edited. The translations below are from the previous text.</span>
              <button className="small primary" onClick={() => void run()} disabled={!canRun}>
                Run
              </button>
            </div>
          )}
          {snap ? (
            <Grid
              snap={snap}
              text={setup.text}
              onText={(text) => setSetup({ ...setup, text })}
              mode={effectiveMode}
              onMode={setMode}
              runs={visibleRuns}
              send={send}
              edited={edited && viewingLatest}
              readOnlyOld={!viewingLatest}
            />
          ) : (
            <p className="hint pad">Loading…</p>
          )}
          {snap && hasVersion && <Tray snap={snap} open={trayOpen} onToggle={() => setTrayOpen((o) => !o)} send={send} />}
        </main>

        {tab && <SettingsDrawer tab={tab} onTab={setTab} onClose={() => setTab(null)} setup={setup} onSetup={setSetup} provider={provider} split={split} />}
      </div>

      {exporting && snap?.revision && <ExportDialog snap={snap} onClose={() => setExporting(false)} />}
    </div>
  );
}
