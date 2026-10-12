import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHandler } from "../handlers.js";
import { createThrottle } from "../notifier.js";
import { ProjectService } from "../project-service.js";
import { ProviderService } from "../provider-service.js";
import { EncryptedFileCredentialStore, FileSettingsStore } from "../storage.js";

// Created once the app is ready, because the settings folder and secure storage are not available before that.
let projects!: ProjectService;
let handle!: ReturnType<typeof createHandler>;
const devUrl = process.env["ELECTRON_RENDERER_URL"];
let mainWindow: BrowserWindow | null = null;
let seq = 0;

const notifyWindow = createThrottle(() => {
  mainWindow?.webContents.send("ltw:event", { eventVersion: 1, seq: ++seq, type: "changed" });
});

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

  let closing = false;
  win.on("close", (event) => {
    if (closing) return;
    const busy = projects.workspace.snapshot().busy;
    if (!busy && !projects.isDirty()) return;
    event.preventDefault();
    void (async () => {
      const unsaved = projects.isDirty();
      const r = await dialog.showMessageBox(win, {
        type: "question",
        buttons: unsaved ? ["Save", "Discard", "Cancel"] : ["Quit", "Keep working"],
        defaultId: 0,
        cancelId: unsaved ? 2 : 1,
        title: busy ? "A translation is still running" : "Unsaved changes",
        message: busy ? "A translation is still running." : "This project has unsaved changes.",
        detail: busy
          ? unsaved
            ? "Quitting cancels it. Save first to keep the finished blocks."
            : "Quitting cancels it."
          : "Save them, or discard them and quit.",
      });
      if (unsaved) {
        if (r.response === 2) return;
        if (r.response === 0) {
          try {
            if (busy) projects.workspace.cancel({ kind: "job" });
            await projects.save(false);
          } catch (e) {
            dialog.showErrorBox("Could not save", e instanceof Error ? e.message : "Unknown error");
            return;
          }
          if (projects.isDirty()) return; // the save dialog was cancelled
        } else {
          projects.discardRecoveryFile();
        }
      } else if (r.response === 1) {
        return;
      }
      closing = true;
      projects.dispose();
      win.close();
    })();
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
        const prov = await window.ltw.invoke('provider.get');
        return {
          preloadBridge: typeof window.ltw?.invoke === 'function',
          snapshotOk: snap.ok === true && snap.value.project.title === 'Untitled' && snap.value.project.dirty === false,
          unknownCommandRefused: bad.ok === false,
          providerSettingsOk: prov.ok === true && prov.value.baseUrl === 'http://localhost:1234/v1' && prov.value.hasApiKey === false,
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
  const dataDir = app.getPath("userData");
  const provider = new ProviderService(
    new FileSettingsStore(join(dataDir, "settings.json")),
    // API keys are encrypted with a key kept in the operating system's keychain.
    new EncryptedFileCredentialStore(join(dataDir, "credentials.json"), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (data) => safeStorage.decryptString(data),
    }),
  );
  projects = new ProjectService({
    provider,
    recoveryPath: join(dataDir, "recovery", "unsaved-project.ltw.json"),
    dialogs: {
      async chooseSavePath(defaultName) {
        const r = await dialog.showSaveDialog(mainWindow!, {
          title: "Save project",
          defaultPath: join(app.getPath("documents"), defaultName),
          filters: [{ name: "Translation project", extensions: ["json"] }],
        });
        return r.canceled ? undefined : r.filePath;
      },
      async chooseOpenPath() {
        const r = await dialog.showOpenDialog(mainWindow!, {
          title: "Open project",
          defaultPath: app.getPath("documents"),
          properties: ["openFile"],
          filters: [{ name: "Translation project", extensions: ["json"] }],
        });
        return r.canceled ? undefined : r.filePaths[0];
      },
    },
  });
  handle = createHandler(projects.workspace, provider, projects);
  projects.onChange(notifyWindow);

  // No camera, microphone, notifications or anything else the page might ask for.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  ipcMain.handle("ltw:invoke", async (event, requestId: unknown, command: unknown, payload: unknown) => {
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
