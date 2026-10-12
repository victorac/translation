import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHandler } from "../handlers.js";
import { createThrottle } from "../notifier.js";
import { WorkspaceService } from "../service.js";

const service = new WorkspaceService();
const handle = createHandler(service);
const devUrl = process.env["ELECTRON_RENDERER_URL"];
let mainWindow: BrowserWindow | null = null;
let seq = 0;

const notifyWindow = createThrottle(() => {
  mainWindow?.webContents.send("ltw:event", { eventVersion: 1, seq: ++seq, type: "changed" });
});
service.onChange(notifyWindow);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "Local Translation Workbench",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = win;

  // The window may only show this app's own page: no navigation away, no pop-up windows.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!devUrl || !url.startsWith(devUrl)) event.preventDefault();
  });

  win.on("close", (event) => {
    if (!service.snapshot().busy) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Keep working", "Cancel translation and quit"],
      defaultId: 0,
      cancelId: 0,
      title: "A translation is still running",
      message: "A translation is still running.",
      detail: "Quitting now cancels it. Finished blocks are not saved yet in this early version.",
    });
    if (choice === 0) event.preventDefault();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Automated check used by `pnpm smoke`: confirms the secure setup works, prints the result, and quits.
  if (process.env["LTW_SMOKE_TEST"] === "1") {
    win.webContents.once("did-finish-load", async () => {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const snap = await window.ltw.invoke('workspace.snapshot');
        const bad = await window.ltw.invoke('not.a.command');
        return {
          preloadBridge: typeof window.ltw?.invoke === 'function',
          snapshotOk: snap.ok === true,
          unknownCommandRefused: bad.ok === false,
          pageHasNoNode: typeof require === 'undefined' && typeof process === 'undefined',
          pageRendered: (document.getElementById('root')?.children.length ?? 0) > 0,
          title: document.title,
        };
      })()`);
      console.log("SMOKE:" + JSON.stringify(result));
      const shot = process.env["LTW_SMOKE_SHOT"];
      if (shot) writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
  }

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  // No camera, microphone, notifications or anything else the page might ask for.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  ipcMain.handle("ltw:invoke", (event, requestId: unknown, command: unknown, payload: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { requestId: String(requestId), ok: false, error: { code: "forbidden", message: "Request refused." } };
    }
    return handle(requestId, command, payload);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
