import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeSource } from "@ltw/domain/pure";
import { ExportDialog } from "./ExportDialog";
import { Grid, type SourceMode } from "./Grid";
import { Panes } from "./Panes";
import { useColumnLayout } from "./useColumnLayout";
import { Rail } from "./Rail";
import { SettingsDrawer, type SettingsTab } from "./SettingsDrawer";
import { Toolbar } from "./Toolbar";
import { Tray } from "./Tray";
import { api } from "./api";
import { labelOf, loadSetup, mergeRunModels, saveSetup, settingsOf, toStartInput, withSettings, type SetupState } from "./setup";
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
  const columns = useColumnLayout();
  const [trayOpen, setTrayOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const setupRef = useRef(setup);
  setupRef.current = setup;
  useEffect(() => saveSetup(setup), [setup]);

  // Tell the background process which choices decide how blocks are translated, so Retry and Run use the current ones
  // and it can mark blocks translated under older choices.
  const syncKey = JSON.stringify(settingsOf(setup));
  useEffect(() => {
    const timer = setTimeout(() => {
      const s = setupRef.current;
      void api.invoke("settings.sync", settingsOf(s));
    }, 250);
    return () => clearTimeout(timer);
  }, [syncKey]);

  const hasVersion = !!snap?.revision;
  const viewingLatest = !snap || snap.viewingId === snap.latestId;
  const busy = snap?.busy ?? false;
  const edited = snap?.latestText != null && normalizeSource(setup.text) !== snap.latestText;
  const effectiveMode: SourceMode = mode ?? (hasVersion ? "blocks" : "text");

  // ---- keep the editor and the choices in step with the project ----
  // The text belongs to the open document, and the models, glossary and styles to the project.
  // They are taken from the project when it is opened or started and when another document is opened,
  // never while typing.
  const seen = useRef<{ epoch: number; doc: string }>({ epoch: -1, doc: "" });
  useEffect(() => {
    if (!snap) return;
    const epochChanged = seen.current.epoch !== snap.epoch;
    const docChanged = seen.current.doc !== snap.activeDocumentId;
    if (!epochChanged && !docChanged) return;
    seen.current = { epoch: snap.epoch, doc: snap.activeDocumentId };
    const cur = setupRef.current;
    const base = epochChanged && snap.settings ? withSettings(cur, snap.settings) : cur;
    setSetup({ ...base, text: snap.draftText });
    setMode(null);
  }, [snap?.epoch, snap?.activeDocumentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Text typed into the editor is sent to the open document shortly after typing stops (and before switching documents).
  const pendingText = useRef<{ documentId: string; text: string } | null>(null);
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushText = async () => {
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = null;
    const p = pendingText.current;
    pendingText.current = null;
    if (p) await send("document.setText", p);
  };
  const onText = (text: string) => {
    setSetup((s) => ({ ...s, text }));
    if (!snap) return;
    pendingText.current = { documentId: snap.activeDocumentId, text };
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => void flushText(), 400);
  };

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
  const splitProblem = split.preview ? (split.preview.problem ?? split.preview.issues[0] ?? null) : null;
  const runHint =
    setup.text.trim() === ""
      ? "No text"
      : setup.models.length === 0
        ? "No model"
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

  // The researcher model reads the text for knowledge, and before translating it chooses the background for each block.
  const researcher = setup.models.find((m) => m.name === setup.researcher) ?? setup.models[0] ?? null;
  const [work, setWork] = useState<{ what: "extract" | "choose" | "summarize"; at: number; of: number } | null>(null);
  const [workNote, setWorkNote] = useState<string | null>(null);
  /** The longer account behind the note: what was left out, replaced or flagged. */
  const [workDetails, setWorkDetails] = useState<string[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const stopWork = useRef(false);
  const known = (snap?.knowledge.terms ?? 0) + (snap?.knowledge.notes ?? 0);
  const blockTexts = split.preview?.blocks.map((b) => b.text) ?? [];
  const sideRequest = researcher && !busy && !work;
  const activeTitle = snap?.documents.find((d) => d.id === snap.activeDocumentId)?.title ?? "Document";

  /** The researcher reads the text block by block and adds what it finds to the knowledge base as suggestions. */
  const extract = async () => {
    const s = setupRef.current;
    if (!researcher || blockTexts.length === 0) return;
    stopWork.current = false;
    setWorkNote(null);
    setWorkDetails([]);
    setShowDetails(false);
    let added = 0;
    const left: string[] = [];
    // Reading again starts from what you accepted: suggestions nobody checked are dropped, and what you rejected stays rejected.
    const begin = await api.invoke("knowledge.beginExtraction", { documentId: snap?.activeDocumentId ?? "" });
    const discarded = begin.ok ? begin.value.discarded : 0;
    try {
      for (let i = 0; i < blockTexts.length; i++) {
        setWork({ what: "extract", at: i + 1, of: blockTexts.length });
        const r = await api.invoke("notes.analyze", {
          backend: s.backend,
          modelId: researcher.name,
          contextLimit: researcher.contextLimit,
          maxOutputTokens: researcher.maxOutputTokens,
          sourceLanguage: s.sourceLanguage,
          targetLanguage: s.targetLanguage,
          passage: blockTexts[i]!,
          documentId: snap?.activeDocumentId ?? "",
          documentTitle: activeTitle,
          block: i + 1,
          ...(i > 0 ? { previousPassage: blockTexts[i - 1]! } : {}),
        });
        if (stopWork.current || (r.ok && r.value.canceled)) break;
        if (!r.ok) return setWorkNote(r.error.message);
        added += r.value.added;
        left.push(...r.value.notes);
      }
      if (stopWork.current) return setWorkNote(`Stopped. ${added} ${added === 1 ? "suggestion was" : "suggestions were"} added so far.`);
      setWork({ what: "summarize", at: 0, of: 0 });
      const s2 = await api.invoke("knowledge.summarize", {
        backend: s.backend,
        modelId: researcher.name,
        contextLimit: researcher.contextLimit,
        maxOutputTokens: researcher.maxOutputTokens,
        sourceLanguage: s.sourceLanguage,
        targetLanguage: s.targetLanguage,
        documentId: snap?.activeDocumentId ?? "",
        documentTitle: activeTitle,
      });
      if (!s2.ok) return setWorkNote(`${added} suggestions were added, but the summary could not be written: ${s2.error.message}`);
      // A last look over everything for names that clash and links that lead nowhere.
      const checked = await api.invoke("knowledge.check");
      const flagged = checked.ok ? checked.value.found : 0;
      setWorkDetails([...(discarded > 0 ? [`${discarded} unchecked ${discarded === 1 ? "suggestion was" : "suggestions were"} replaced.`] : []), ...left, ...(flagged > 0 ? [`${flagged} possible ${flagged === 1 ? "problem was" : "problems were"} noted as "Check:" on the topics concerned.`] : [])]);
      setWorkNote(`Added ${added} ${added === 1 ? "suggestion" : "suggestions"}${s2.value.updated ? " and a summary" : ""}, marked with a ?.${left.length + flagged > 0 ? ` ${left.length + flagged} ${left.length + flagged === 1 ? "thing needs" : "things need"} a look.` : ""}`);
    } finally {
      setWork(null);
    }
  };

  /** Writes the summary of a document again from its scenes, replacing the one there (even one the user accepted). */
  const rewriteSummary = async (documentId: string) => {
    const s = setupRef.current;
    if (!researcher || work || busy) return;
    const title = snap?.documents.find((d) => d.id === documentId)?.title ?? activeTitle;
    setWorkNote(null);
    setWork({ what: "summarize", at: 0, of: 0 });
    try {
      const r = await api.invoke("knowledge.summarize", {
        backend: s.backend,
        modelId: researcher.name,
        contextLimit: researcher.contextLimit,
        maxOutputTokens: researcher.maxOutputTokens,
        sourceLanguage: s.sourceLanguage,
        targetLanguage: s.targetLanguage,
        documentId,
        documentTitle: title,
        rewrite: true,
      });
      setWorkNote(!r.ok ? r.error.message : r.value.canceled ? "Stopped." : r.value.updated ? "The summary was written again from the scenes. Please check it." : "There are no scenes to write a summary from. Extract knowledge first.");
    } finally {
      setWork(null);
    }
  };

  /** Before translating, the researcher chooses what matters for each block. Returns false if the user stopped it. */
  const prepare = async (): Promise<boolean> => {
    const s = setupRef.current;
    if (!researcher || blockTexts.length === 0 || known === 0) return true;
    stopWork.current = false;
    setWorkNote(null);
    try {
      for (let i = 0; i < blockTexts.length; i++) {
        setWork({ what: "choose", at: i + 1, of: blockTexts.length });
        const r = await api.invoke("research.block", {
          backend: s.backend,
          modelId: researcher.name,
          contextLimit: researcher.contextLimit,
          maxOutputTokens: researcher.maxOutputTokens,
          sourceLanguage: s.sourceLanguage,
          targetLanguage: s.targetLanguage,
          passage: blockTexts[i]!,
        });
        if (stopWork.current || (r.ok && r.value.canceled)) return false;
        if (!r.ok) {
          setWorkNote(`Could not choose the background for every block: ${r.error.message} The remaining blocks use name matching as a backup.`);
          return true;
        }
      }
      return true;
    } finally {
      setWork(null);
    }
  };

  const run = async (rerun: string[] = []) => {
    if (busy || work || (rerun.length === 0 && !canRun)) return;
    let labels = rerun;
    if (labels.length === 0 && !needsRun) {
      // Nothing is missing, but the user asked: translate everything again rather than refusing.
      if (!window.confirm("Everything is already translated with the current settings. Translate it all again?")) return;
      labels = setupRef.current.models.map((m) => labelOf(m, setupRef.current));
    }
    setMode(null);
    if (!(await prepare())) return;
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
        knowledge={{
          open: columns.mode === "panes" && columns.showKnowledge,
          count: known,
          suggested: snap?.knowledge.suggested ?? 0,
          onToggle: () => {
            if (columns.mode !== "panes") {
              columns.setMode("panes");
              columns.setShowKnowledge(true);
            } else columns.setShowKnowledge(!columns.showKnowledge);
          },
        }}
        researcher={{ models: setup.models.map((m) => m.name), value: researcher?.name ?? null, onChange: (name) => setSetup((x) => ({ ...x, researcher: name })) }}
        onExtract={() => void extract()}
        canExtract={!!sideRequest && blockTexts.length > 0}
        extractHint={!researcher ? "Add a model first" : blockTexts.length === 0 ? "Add some text first" : busy ? "Wait for the translation to finish" : "A model reads the text and suggests entries for the knowledge base"}
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
          layoutControl={{ mode: columns.mode, linked: columns.linked, onMode: columns.setMode, onLinked: columns.setLinked, showKnowledge: columns.showKnowledge, onShowKnowledge: columns.setShowKnowledge, onReset: columns.reset }}
          discovered={discovered}
          viewingLatest={viewingLatest}
          onRunAgain={(label) => void run([label])}
          provider={provider}
          onSettings={() => setTab("server")}
          docs={{
            onSelect: (id) => {
              if (snap && id === snap.activeDocumentId) return;
              void flushText().then(() => send("document.select", { documentId: id }));
            },
            onCreate: () => void flushText().then(() => send("document.create", {})),
            onRename: (id, title) => void send("document.rename", { documentId: id, title }),
            onDelete: (id) => {
              const d = snap?.documents.find((x) => x.id === id);
              if (d && window.confirm(`Delete "${d.title}" and everything translated from it? This cannot be undone.`)) void send("document.delete", { documentId: id });
            },
          }}
        />

        <main className="center">
          {work && (
            <div className="strip">
              <span>
                {work.what === "summarize" ? "Writing the summary…" : `${work.what === "extract" ? "Reading for knowledge" : "Choosing the background"}, block ${work.at} of ${work.of}…`}
              </span>
              <button
                className="small"
                onClick={() => {
                  stopWork.current = true;
                  void api.invoke("notes.cancel");
                }}
              >
                Stop
              </button>
            </div>
          )}
          {workNote && (
            <div className="strip">
              <span>{workNote}</span>
              <span className="row">
                {workDetails.length > 0 && (
                  <button className="small" aria-expanded={showDetails} onClick={() => setShowDetails((d) => !d)}>
                    {showDetails ? "Hide details" : "Details"}
                  </button>
                )}
                <button className="small" onClick={() => (setWorkNote(null), setWorkDetails([]))}>
                  Dismiss
                </button>
              </span>
            </div>
          )}
          {workNote && showDetails && workDetails.length > 0 && (
            <ul className="strip-details">
              {workDetails.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
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
            columns.mode === "panes" ? (
              <Panes
                snap={snap}
                text={setup.text}
                onText={onText}
                title={snap.documents.find((d) => d.id === snap.activeDocumentId)?.title ?? "Source"}
                previewBlocks={split.preview?.blocks ?? null}
                editorKey={`${snap.epoch}:${snap.activeDocumentId}`}
                mode={effectiveMode}
                onMode={setMode}
                runs={visibleRuns}
                send={send}
                edited={edited && viewingLatest}
                readOnlyOld={!viewingLatest}
                tree={columns.tree}
                onTree={columns.setTree}
                onHide={(label) => setHidden((h) => new Set(h).add(label))}
                linked={columns.linked}
                showKnowledge={columns.showKnowledge}
                onCloseKnowledge={() => columns.setShowKnowledge(false)}
                knowledgeRev={snap.knowledge.rev}
                knowledgeCounts={snap.knowledge}
                onRewriteSummary={researcher && !work && !busy ? (id) => void rewriteSummary(id) : undefined}
              />
            ) : (
            <Grid
              snap={snap}
              text={setup.text}
              onText={onText}
              title={snap.documents.find((d) => d.id === snap.activeDocumentId)?.title ?? "Source"}
              previewBlocks={split.preview?.blocks ?? null}
              editorKey={`${snap.epoch}:${snap.activeDocumentId}`}
              mode={effectiveMode}
              onMode={setMode}
              runs={visibleRuns}
              layout={columns.layout}
              onLayout={columns.setLayout}
              onHide={(label) => setHidden((h) => new Set(h).add(label))}
              send={send}
              edited={edited && viewingLatest}
              readOnlyOld={!viewingLatest}
            />
            )
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
