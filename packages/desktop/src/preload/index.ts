import { contextBridge, ipcRenderer } from "electron";

/**
 * The only door between the window and the app's background process.
 * The window can send the commands listed here and receive "something changed" pings; nothing else.
 * (The list is repeated rather than imported so this file stays small and self-contained.)
 */
const COMMANDS = new Set([
  "workspace.snapshot",
  "workspace.reset",
  "job.start",
  "job.cancel",
  "block.retry",
  "block.acceptCandidate",
  "block.keepCurrent",
  "block.acceptReview",
  "block.edit",
  "run.retryUnfinished",
  "run.retranslateDownstream",
  "run.resolveWaiting",
  "demo.loadModel",
  "project.save",
  "project.open",
  "project.new",
  "project.restoreRecovery",
  "project.discardRecovery",
  "project.dismissProblem",
  "export.preview",
  "export.write",
  "source.preview",
  "provider.get",
  "provider.save",
  "provider.test",
]);

let counter = 0;

contextBridge.exposeInMainWorld("ltw", {
  invoke(command: string, payload?: unknown) {
    const requestId = `r${++counter}`;
    if (!COMMANDS.has(command)) {
      return Promise.resolve({ requestId, ok: false, error: { code: "unknown_command", message: "Unknown command." } });
    }
    return ipcRenderer.invoke("ltw:invoke", requestId, command, payload);
  },
  onEvent(callback: (event: unknown) => void) {
    const listener = (_: unknown, event: unknown) => callback(event);
    ipcRenderer.on("ltw:event", listener);
    return () => {
      ipcRenderer.removeListener("ltw:event", listener);
    };
  },
});
