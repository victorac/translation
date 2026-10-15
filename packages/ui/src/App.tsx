import { useEffect, useRef, useState } from "react";
import { Button, Callout, Flex, Text } from "@radix-ui/themes";
import { ExportDialog } from "./ExportDialog";
import { Rail } from "./Rail";
import { SettingsDrawer, type SettingsTab } from "./SettingsDrawer";
import { Toolbar, type Activity } from "./Toolbar";
import { KnowledgeDrawer } from "./KnowledgeDrawer";
import { Workspace } from "./Workspace";
import { api } from "./api";
import { loadSetup, saveSetup, settingsOf, withSettings, type SetupState } from "./setup";
import { useProvider } from "./useProvider";
import { useWorkspace } from "./useWorkspace";

/** A message above the work, with the buttons that answer it. */
function Banner({ color, children, actions }: { color: "amber" | "red" | "blue"; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Callout.Root color={color} size="1" role="alert" mx="3" my="1">
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Callout.Text>{children}</Callout.Text>
        <Flex gap="2">{actions}</Flex>
      </Flex>
    </Callout.Root>
  );
}

/** One screen: the left panel, the workspace (source, what was read, translation), and the settings beside it when open. */
export function App() {
  const { snapshot: snap, error, clearError, send } = useWorkspace();
  const provider = useProvider();
  const [setup, setSetup] = useState<SetupState>(loadSetup);
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const [exporting, setExporting] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [kb, setKb] = useState<{ open: boolean; request: { id: string; n: number } | null }>({ open: false, request: null });

  const setupRef = useRef(setup);
  setupRef.current = setup;
  useEffect(() => saveSetup(setup), [setup]);

  // Tell the background process the choices that belong to the project (languages, models, styles), so it keeps them in the file.
  const syncKey = JSON.stringify(settingsOf(setup));
  useEffect(() => {
    const timer = setTimeout(() => void api.invoke("settings.sync", settingsOf(setupRef.current)), 250);
    return () => clearTimeout(timer);
  }, [syncKey]);

  // ---- keep the editor and the choices in step with the project ----
  // The text belongs to the open document, and the models and styles to the project. They are taken from the project when it is
  // opened or started and when another document is opened, never while typing.
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

  // ---- shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void send("project.save", { saveAs: e.shiftKey });
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
  const known = (snap?.knowledge.terms ?? 0) + (snap?.knowledge.notes ?? 0);
  // Embedding models cannot translate; leave them out of the suggestions (they can still be typed in).
  const discovered = provider.test?.ok ? provider.test.models.filter((id) => !/embed/i.test(id)) : [];

  return (
    <div className="app">
      <Toolbar
        snap={snap}
        send={send}
        onSettings={() => setTab((t) => (t ? null : "server"))}
        onExport={() => setExporting(true)}
        confirmDiscard={confirmDiscard}
        activity={activity}
        knowledge={{ open: kb.open, count: known, suggested: snap?.knowledge.suggested ?? 0, onToggle: () => setKb((k) => ({ open: !k.open, request: null })) }}
      />

      {project?.recovery && (
        <Banner
          color="amber"
          actions={
            <>
              <Button size="1" onClick={() => void send("project.restoreRecovery")}>
                Restore
              </Button>
              <Button size="1" variant="soft" color="gray" onClick={() => window.confirm("Discard the recovered work? This cannot be undone.") && void send("project.discardRecovery")}>
                Discard
              </Button>
            </>
          }
        >
          Unsaved work from last time ({project.recovery.paragraphs} paragraphs, {project.recovery.documents} {project.recovery.documents === 1 ? "document" : "documents"}).
        </Banner>
      )}
      {project?.openProblem && (
        <Banner
          color="red"
          actions={
            <>
              {project.openProblem.canOpenBackup && (
                <Button size="1" onClick={() => void send("project.open", { useBackup: true })}>
                  Open previous copy
                </Button>
              )}
              <Button size="1" variant="soft" color="gray" onClick={() => void send("project.dismissProblem")}>
                Dismiss
              </Button>
            </>
          }
        >
          {project.openProblem.message}
        </Banner>
      )}
      {project?.notice && !project.openProblem && (
        <Banner
          color="blue"
          actions={
            <Button size="1" variant="soft" color="gray" onClick={() => void send("project.dismissProblem")}>
              Dismiss
            </Button>
          }
        >
          {project.notice}
        </Banner>
      )}
      {error && (
        <Banner
          color="red"
          actions={
            <Button size="1" variant="soft" color="gray" onClick={clearError}>
              Dismiss
            </Button>
          }
        >
          {error}
        </Banner>
      )}

      <div className="body">
        <Rail
          snap={snap}
          setup={setup}
          onSetup={setSetup}
          discovered={discovered}
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
          {snap ? (
            <Workspace
              setup={setup}
              documentId={snap.activeDocumentId}
              text={setup.text}
              onText={onText}
              editorKey={`${snap.epoch}:${snap.activeDocumentId}`}
              knowledgeRev={snap.knowledge.rev}
              onKb={setKb}
              onActivity={setActivity}
            />
          ) : (
            <Text as="p" size="2" color="gray" m="4">
              Loading…
            </Text>
          )}
        </main>

        {tab && <SettingsDrawer tab={tab} onTab={setTab} onClose={() => setTab(null)} setup={setup} onSetup={setSetup} provider={provider} />}
      </div>

      <KnowledgeDrawer open={kb.open} request={kb.request} rev={snap?.knowledge.rev ?? 0} counts={snap?.knowledge ?? { terms: 0, notes: 0, suggested: 0 }} onClose={() => setKb({ open: false, request: null })} />

      {exporting && <ExportDialog title={project?.title ?? "translation"} onClose={() => setExporting(false)} />}
    </div>
  );
}
