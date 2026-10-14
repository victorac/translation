import {
  buildExport,
  buildProjectFile,
  MAX_PROJECT_BYTES,
  newId as defaultNewId,
  parseProject,
  PROJECT_EXTENSION,
  serializeProject,
  settleLoadedRun,
  type ExportInput,
  type ExportPreview,
  type ExportWriteResult,
  type ProjectFile,
  type ProjectView,
} from "@ltw/domain";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { UserError } from "./errors.js";
import type { ProviderService } from "./provider-service.js";
import { WorkspaceService, type ChangeKind, type ServiceOptions } from "./service.js";

/** The two native file dialogs. The real app shows system dialogs; tests and dev mode answer directly. */
export interface FileDialogs {
  chooseSavePath(defaultName: string): Promise<string | undefined>;
  chooseOpenPath(): Promise<string | undefined>;
  /** `extension` includes the dot, for example ".csv". */
  chooseExportPath(defaultName: string, extension: string): Promise<string | undefined>;
}

export interface ProjectServiceOptions {
  dialogs: FileDialogs;
  /** Where the automatic recovery copy is kept. */
  recoveryPath: string;
  provider?: ProviderService;
  workspace?: Pick<ServiceOptions, "speedMs">;
  now?: () => Date;
  newId?: () => string;
  /** Delay before saving a recovery copy after a change (default 500 ms). */
  autosaveMs?: number;
  /** Longest wait before the recovery copy is refreshed while text is streaming (default 2000 ms). */
  draftAutosaveMs?: number;
}

interface Meta {
  id: string | null;
  createdAt: string | null;
  path: string | null;
  lastSavedAt: string | null;
}

interface PendingRecovery {
  file: ProjectFile;
  path: string | null;
}

/** Writes a file so that a crash can never leave it half-written: temporary file, flush to disk, then rename. */
export function writeFileDurably(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

const stripExtension = (name: string): string => (name.endsWith(PROJECT_EXTENSION) ? name.slice(0, -PROJECT_EXTENSION.length) : name.replace(/\.[^.]*$/, ""));

/**
 * The open project: its file on disk, unsaved-changes tracking, and the automatic recovery copy.
 *
 * Two files matter:
 *  - the project file the user chose, only written by Save (the previous version is kept next to it as `.bak`);
 *  - the recovery copy in the app's data folder, refreshed automatically while work is unsaved, so an
 *    unexpected close loses almost nothing. It is removed after a successful Save.
 */
export class ProjectService {
  readonly workspace: WorkspaceService;
  private meta: Meta = { id: null, createdAt: null, path: null, lastSavedAt: null };
  private changes = 0;
  private savedChanges = 0;
  private pending: PendingRecovery | null = null;
  private openProblem: { message: string; backupOf: string | null } | null = null;
  private notice: string | null = null;
  private autosaveError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDue = 0;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: ProjectServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultNewId;
    this.workspace = new WorkspaceService({
      ...(options.workspace ?? {}),
      ...(options.provider ? { provider: options.provider } : {}),
      checkpoint: () => this.writeRecovery(),
      projectView: () => this.view(),
    });
    this.workspace.onChange((kind) => this.onWorkspaceChange(kind));
    this.loadRecovery();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isDirty(): boolean {
    return this.workspace.hasContent && this.changes !== this.savedChanges;
  }

  view(): ProjectView {
    const p = this.pending;
    return {
      title: this.meta.path ? stripExtension(basename(this.meta.path)) : "Untitled",
      path: this.meta.path,
      dirty: this.isDirty(),
      lastSavedAt: this.meta.lastSavedAt,
      recovery: p ? this.recoveryView(p.file) : null,
      openProblem: this.openProblem ? { message: this.openProblem.message, canOpenBackup: this.openProblem.backupOf !== null } : null,
      notice: this.autosaveError ?? this.notice,
    };
  }

  private recoveryView(file: ProjectFile): NonNullable<ProjectView["recovery"]> {
    const doc = file.documents.find((d) => d.id === file.activeDocumentId) ?? file.documents[0]!;
    const latest = doc.versions.at(-1);
    return {
      updatedAt: file.project.updatedAt,
      blocks: latest?.source.blocks.length ?? 0,
      models: latest?.runs.filter((r) => !r.archived).length ?? 0,
      documents: file.documents.length,
    };
  }

  // ---- commands ----

  /** Save, or Save As when `saveAs` is set or the project has no file yet. Cancelling the dialog does nothing. */
  async save(saveAs: boolean): Promise<void> {
    if (!this.workspace.hasContent) throw new UserError("nothing_to_save", "There is nothing to save yet.");
    let path = this.meta.path;
    if (saveAs || !path) {
      const chosen = await this.options.dialogs.chooseSavePath(`${this.view().title}${PROJECT_EXTENSION}`);
      if (!chosen) return;
      path = chosen.endsWith(PROJECT_EXTENSION) ? chosen : `${chosen}${PROJECT_EXTENSION}`;
    }
    const file = this.buildFile();
    const snapshotChanges = this.changes;
    try {
      this.writeWithBackup(path, serializeProject(file));
    } catch (e) {
      throw new UserError(
        "save_failed",
        `Could not save to ${path}: ${e instanceof Error ? e.message : "unknown error"}. Your work is still open here. Try Save As to choose another place.`,
      );
    }
    this.meta.path = path;
    this.meta.lastSavedAt = file.project.updatedAt;
    this.savedChanges = snapshotChanges;
    this.autosaveError = null;
    this.openProblem = null;
    if (this.changes === this.savedChanges) this.removeRecovery();
    this.emit();
  }

  /** Open a project file chosen in a dialog, or the previous saved copy of one that failed to open. */
  async open(useBackup: boolean): Promise<void> {
    this.requireIdle();
    let path: string | undefined;
    let fromBackup = false;
    if (useBackup) {
      const failed = this.openProblem?.backupOf;
      if (!failed) throw new UserError("no_backup", "There is no previous saved copy to open.");
      path = `${failed}.bak`;
      fromBackup = true;
    } else {
      path = await this.options.dialogs.chooseOpenPath();
      if (!path) return;
    }

    let text: string;
    try {
      if (statSync(path).size > MAX_PROJECT_BYTES) {
        this.fail(`This file is larger than ${MAX_PROJECT_BYTES / (1024 * 1024)} MiB, so it was not opened.`, null);
        return;
      }
      text = readFileSync(path, "utf8");
    } catch (e) {
      this.fail(`The file could not be read: ${e instanceof Error ? e.message : "unknown error"}.`, null);
      return;
    }
    const parsed = parseProject(text);
    if (!parsed.ok) {
      const backup = !fromBackup && existsSync(`${path}.bak`) ? path : null;
      this.fail(parsed.error.message + (backup ? " A previous saved copy of this project exists and can be opened instead." : ""), backup);
      return;
    }
    this.load(parsed.file, fromBackup ? null : path);
    if (fromBackup) {
      // The recovered copy is "Untitled" and unsaved: saving it must not overwrite the damaged file's backup.
      this.savedChanges = this.changes - 1;
      this.notice = "Opened the previous saved copy. Use Save As to keep it.";
    }
    this.emit();
  }

  /** Start with an empty workspace. The caller has already asked about unsaved changes. */
  newProject(): void {
    this.requireIdle();
    this.workspace.reset();
    this.meta = { id: null, createdAt: null, path: null, lastSavedAt: null };
    this.changes = 0;
    this.savedChanges = 0;
    this.notice = null;
    this.openProblem = null;
    this.autosaveError = null;
    this.cancelTimer();
    this.removeRecovery();
    this.emit();
  }

  /** What an export would contain, without writing anything. Never starts any translation. */
  exportPreview(input: ExportInput): ExportPreview {
    return this.runExport(input).preview;
  }

  /** Writes the export file where the user chooses. Cancelling the dialog does nothing. */
  async exportFile(input: ExportInput): Promise<ExportWriteResult> {
    const { preview, content } = this.runExport(input);
    if (preview.problem) throw new UserError("export_problem", preview.problem);
    if (content === null) {
      throw new UserError("partial_not_allowed", 'Some blocks have no translation yet. Tick "Export partial" to include them, marked as missing.');
    }
    const chosen = await this.options.dialogs.chooseExportPath(preview.fileName, preview.extension);
    if (!chosen) return { path: null, bytes: 0 };
    const path = chosen.toLowerCase().endsWith(preview.extension) ? chosen : `${chosen}${preview.extension}`;
    try {
      writeFileDurably(path, content);
    } catch (e) {
      throw new UserError("export_failed", `Could not write ${path}: ${e instanceof Error ? e.message : "unknown error"}. Try another folder.`);
    }
    return { path, bytes: preview.bytes };
  }

  private runExport(input: ExportInput) {
    if (!this.workspace.hasRevision) throw new UserError("nothing_to_export", "There is nothing to export yet. Run the open document first.");
    const state = this.workspace.exportViewed();
    return buildExport(state.revision, state.runs, {
      format: input.format,
      runIds: input.runIds,
      textVersion: input.textVersion,
      allowPartial: input.allowPartial,
      formulaSafe: input.formulaSafe,
      title: this.view().title,
      now: this.now(),
    });
  }

  restoreRecovery(): void {
    const p = this.pending;
    if (!p) throw new UserError("no_recovery", "There is no recovered work to restore.");
    this.requireNotBusy();
    this.load(p.file, p.path);
    this.savedChanges = this.changes - 1; // differs from whatever is on disk
    this.pending = null;
    this.notice = "Recovered unsaved work from last time. Save it to keep it.";
    this.emit();
  }

  discardRecovery(): void {
    this.pending = null;
    this.removeRecovery();
    this.emit();
  }

  dismissProblem(): void {
    this.openProblem = null;
    this.notice = null;
    this.emit();
  }

  /** Used when the user chooses "Discard" while closing the app. */
  discardRecoveryFile(): void {
    this.removeRecovery();
  }

  // ---- internals ----

  private requireNotBusy(): void {
    if (this.workspace.snapshot().busy) throw new UserError("busy", "Cancel the running translation first.");
  }

  /** Opening or starting something new must not silently bury recovered work. */
  private requireIdle(): void {
    this.requireNotBusy();
    if (this.pending) throw new UserError("recovery_pending", "There is recovered work from last time. Restore it or discard it first.");
  }

  private fail(message: string, backupOf: string | null): void {
    this.openProblem = { message, backupOf };
    this.emit();
  }

  private load(file: ProjectFile, path: string | null): void {
    this.workspace.restore({
      activeDocumentId: file.activeDocumentId,
      ...(file.settings ? { settings: file.settings } : {}),
      ...(file.knowledge ? { knowledge: file.knowledge } : {}),
      ...(file.guided ? { guided: file.guided } : {}),
      documents: file.documents.map((d) => ({ ...d, versions: d.versions.map((v) => ({ ...v, runs: v.runs.map((r) => settleLoadedRun(r)) })) })),
    });
    this.meta = { id: file.project.id, createdAt: file.project.createdAt, path, lastSavedAt: file.project.updatedAt };
    this.changes = 1;
    this.savedChanges = 1;
    this.openProblem = null;
    this.autosaveError = null;
    this.cancelTimer();
    this.notice = null;
    const used = file.providerLabel;
    const current = this.options.provider?.view().baseUrl;
    const runs = file.documents.flatMap((d) => d.versions.flatMap((v) => v.runs));
    if (runs.some((r) => r.providerRefId === "main") && used && current && used !== current) {
      this.notice = `This project was made with the server at ${used}. Retries will use your current server at ${current}.`;
    }
    if (runs.length > 0 && runs.every((r) => r.providerRefId === "practice")) this.notice = "This project used the practice translator.";
  }

  private buildFile(): ProjectFile {
    const state = this.workspace.exportProject();
    const now = this.now().toISOString();
    this.meta.id ??= this.newId();
    this.meta.createdAt ??= now;
    const usesServer = state.documents.some((d) => d.versions.some((v) => v.runs.some((r) => r.providerRefId === "main")));
    return buildProjectFile({
      id: this.meta.id,
      title: this.view().title,
      createdAt: this.meta.createdAt,
      updatedAt: now,
      version: this.changes,
      ...(usesServer && this.options.provider ? { providerLabel: this.options.provider.view().baseUrl } : {}),
      settings: state.settings,
      knowledge: state.knowledge,
      guided: state.guided,
      activeDocumentId: state.activeDocumentId,
      documents: state.documents,
    });
  }

  /** The previous version stays beside the new one as `<name>.bak`. */
  private writeWithBackup(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (existsSync(path)) copyFileSync(path, `${path}.bak`);
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  private onWorkspaceChange(kind: ChangeKind): void {
    if (!this.workspace.hasContent) {
      this.emit();
      return;
    }
    if (kind === "state") this.changes++; // "view" changes only how things are shown, not what is saved
    this.scheduleAutosave(kind);
    this.emit();
  }

  private scheduleAutosave(kind: ChangeKind): void {
    if (!this.isDirty()) return;
    const delay = kind === "delta" ? (this.options.draftAutosaveMs ?? 2000) : (this.options.autosaveMs ?? 500);
    const due = Date.now() + delay;
    if (this.timer && this.timerDue <= due) return;
    this.cancelTimer();
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writeRecovery().catch(() => {
        /* surfaced through the notice */
      });
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Refreshes the recovery copy. Called on a timer while work is unsaved, and after every finished
   * translation request (where a failure stops the job, because progress could not be kept safe).
   */
  private async writeRecovery(): Promise<void> {
    if (!this.workspace.hasContent) return;
    this.cancelTimer();
    try {
      const file = this.buildFile();
      const withMeta = { ...file, recovery: { path: this.meta.path, savedAtMs: Date.now() } };
      writeFileDurably(this.options.recoveryPath, JSON.stringify(withMeta));
      if (this.autosaveError) {
        this.autosaveError = null;
        this.emit();
      }
    } catch (e) {
      this.autosaveError = `Progress could not be kept safe: ${e instanceof Error ? e.message : "unknown error"}. Use Save As to choose another place.`;
      this.emit();
      throw e;
    }
  }

  private removeRecovery(): void {
    try {
      rmSync(this.options.recoveryPath, { force: true });
    } catch {
      /* nothing to do */
    }
  }

  /** At startup: is there unsaved work from a session that ended without saving? */
  private loadRecovery(): void {
    const path = this.options.recoveryPath;
    if (!existsSync(path)) return;
    try {
      const text = readFileSync(path, "utf8");
      const meta = (JSON.parse(text) as { recovery?: { path?: unknown; savedAtMs?: unknown } }).recovery;
      const parsed = parseProject(text);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const savedPath = typeof meta?.path === "string" ? meta.path : null;
      const savedAt = typeof meta?.savedAtMs === "number" ? meta.savedAtMs : 0;
      // If the saved file was written after this copy, the copy is out of date: the user saved afterwards.
      if (savedPath && existsSync(savedPath) && statSync(savedPath).mtimeMs > savedAt) {
        this.removeRecovery();
        return;
      }
      this.pending = { file: parsed.file, path: savedPath };
    } catch {
      // An unreadable recovery copy is set aside, not deleted.
      try {
        renameSync(path, `${path}.damaged`);
      } catch {
        /* ignore */
      }
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
