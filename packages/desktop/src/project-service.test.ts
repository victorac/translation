import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CLASSES_TEXT, LEGACY_CLASSES_TEXT, type ModelSetting, type StartJobInput, type WorkspaceSnapshot } from "@ltw/domain";
import { createHandler } from "./handlers.js";
import { ProjectService, type FileDialogs } from "./project-service.js";

const made: ProjectService[] = [];
afterEach(() => {
  for (const p of made.splice(0)) p.dispose();
});

const model = (name: string): ModelSetting => ({ name, contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2, promptId: "standard", useGlossary: true });
const PARAS = ["最初の段落です。とても短い。", "二番目の段落です。もう少し長い。", "三番目の段落です。さらに続く。", "四番目の段落です。まだ続く。", "五番目の段落です。これで最後。"];
const job = (over: Partial<StartJobInput> = {}): StartJobInput => ({
  text: PARAS.join("\n\n"),
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  backend: "practice",
  models: [model("alpha"), model("beta")],
  glossary: [],
  prompts: [],
  blockSize: "normal",
  rerun: [],
  demo: { speed: "fast", smallBlocks: true, failBlockOnce: null, firstModelUnloaded: false },
  ...over,
});

function env(opts: { speedMs?: number; recoveryPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ltw-proj-"));
  const answers: { save?: string | undefined; open?: string | undefined; export?: string | undefined } = {};
  const dialogs: FileDialogs = {
    chooseSavePath: async () => answers.save,
    chooseOpenPath: async () => answers.open,
    chooseExportPath: async () => answers.export,
  };
  const recoveryPath = opts.recoveryPath ?? join(dir, "recovery", "unsaved.ltw.json");
  const make = (over: { recoveryPath?: string; speedMs?: number } = {}) => {
    const p = new ProjectService({
      dialogs,
      recoveryPath: over.recoveryPath ?? recoveryPath,
      workspace: { speedMs: over.speedMs ?? opts.speedMs ?? 0 },
      autosaveMs: 10,
      draftAutosaveMs: 30,
    });
    made.push(p);
    return p;
  };
  return { dir, answers, recoveryPath, make };
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("timed out");
};
const runWholeJob = async (p: ProjectService, input = job()) => {
  p.workspace.start(input);
  await p.workspace.whenIdle();
};
const cellsOf = (s: WorkspaceSnapshot) => s.runs.flatMap((r) => Object.values(r.blocks));

describe("saving and reopening", () => {
  it("saves a finished translation and reopens it exactly as it was", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a);
    const before = a.workspace.snapshot();
    answers.save = join(dir, "My novel");
    await a.save(false);
    expect(existsSync(join(dir, "My novel.ltw.json"))).toBe(true);
    expect(a.view()).toMatchObject({ title: "My novel", dirty: false, path: join(dir, "My novel.ltw.json") });

    const b = make({ recoveryPath: join(dir, "other-recovery.json") });
    answers.open = join(dir, "My novel.ltw.json");
    await b.open(false);
    const after = b.workspace.snapshot();
    expect(after.revision).toEqual(before.revision);
    expect(after.runs).toEqual(before.runs);
    expect(after.backend).toBe("practice");
    expect(b.view()).toMatchObject({ title: "My novel", dirty: false });
  });

  it("keeps edits, retried versions and attempt history", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const snap = a.workspace.snapshot();
    const runId = snap.runs[0]!.id;
    const blockId = snap.revision!.blocks[0]!.id;
    a.workspace.editBlock(runId, blockId, "My “own” wording 👍🏽");
    a.workspace.retryBlock(runId, blockId);
    await a.workspace.whenIdle();
    answers.save = join(dir, "p.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r2.json") });
    answers.open = join(dir, "p.ltw.json");
    await b.open(false);
    const cell = b.workspace.snapshot().runs[0]!.blocks[blockId]!;
    expect(cell).toMatchObject({ text: "My “own” wording 👍🏽", edited: true, attempts: 2 });
    expect(cell.candidateText).toContain("[practice translation");
  });

  it("adds the extension, reuses the path on the next save, and keeps the previous version as .bak", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    answers.save = join(dir, "book");
    await a.save(false);
    const path = join(dir, "book.ltw.json");
    const first = readFileSync(path, "utf8");
    expect(existsSync(`${path}.bak`)).toBe(false);

    const snap = a.workspace.snapshot();
    a.workspace.editBlock(snap.runs[0]!.id, snap.revision!.blocks[0]!.id, "changed");
    expect(a.view().dirty).toBe(true);
    answers.save = undefined; // a dialog now would cancel: the second save must not need one
    await a.save(false);
    expect(a.view().dirty).toBe(false);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(first);
    expect(readFileSync(path, "utf8")).not.toBe(first);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("Save As to a new place changes the project's path; cancelling the dialog changes nothing", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    answers.save = undefined;
    await a.save(true);
    expect(a.view().path).toBeNull();
    expect(a.view().dirty).toBe(true);
    answers.save = join(dir, "x.ltw.json");
    await a.save(true);
    answers.save = join(dir, "y.ltw.json");
    await a.save(true);
    expect(a.view().path).toBe(join(dir, "y.ltw.json"));
    expect(existsSync(join(dir, "x.ltw.json"))).toBe(true);
  });

  it("refuses to save when there is nothing to save", async () => {
    const { make } = env();
    await expect(make().save(false)).rejects.toMatchObject({ code: "nothing_to_save" });
  });

  it("tracks unsaved changes", async () => {
    const { dir, answers, make } = env();
    const a = make();
    expect(a.view().dirty).toBe(false);
    await runWholeJob(a, job({ models: [model("alpha")] }));
    expect(a.view().dirty).toBe(true);
    answers.save = join(dir, "d.ltw.json");
    await a.save(false);
    expect(a.view().dirty).toBe(false);
    const snap = a.workspace.snapshot();
    a.workspace.editBlock(snap.runs[0]!.id, snap.revision!.blocks[0]!.id, "x");
    expect(a.view().dirty).toBe(true);
  });

  it("a failed save leaves the previous file intact, keeps the work open, and says how to recover", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    answers.save = join(dir, "good.ltw.json");
    await a.save(false);
    const good = readFileSync(join(dir, "good.ltw.json"), "utf8");

    writeFileSync(join(dir, "not-a-folder"), "x");
    const snap = a.workspace.snapshot();
    a.workspace.editBlock(snap.runs[0]!.id, snap.revision!.blocks[0]!.id, "edited after");
    answers.save = join(dir, "not-a-folder", "nope.ltw.json");
    await expect(a.save(true)).rejects.toMatchObject({ code: "save_failed", message: expect.stringContaining("Save As") });
    expect(a.view()).toMatchObject({ dirty: true, path: join(dir, "good.ltw.json") });
    expect(readFileSync(join(dir, "good.ltw.json"), "utf8")).toBe(good);
    expect(a.workspace.snapshot().revision).not.toBeNull();
  });

  it("a project saved while translating reopens with that work marked interrupted, ready to resume", async () => {
    const { dir, answers, make } = env({ speedMs: 15 });
    const a = make();
    a.workspace.start(job());
    await until(() => cellsOf(a.workspace.snapshot()).some((c) => c.state === "succeeded") && cellsOf(a.workspace.snapshot()).some((c) => c.state === "running"));
    answers.save = join(dir, "mid.ltw.json");
    await a.save(false);
    a.workspace.cancel({ kind: "job" });
    await a.workspace.whenIdle();

    const b = make({ recoveryPath: join(dir, "r3.json"), speedMs: 0 });
    answers.open = join(dir, "mid.ltw.json");
    await b.open(false);
    const snap = b.workspace.snapshot();
    expect(snap.busy).toBe(false);
    expect(snap.runs[0]!.state).toBe("interrupted");
    expect(cellsOf(snap).some((c) => c.state === "running" || c.state === "waiting")).toBe(false);
    const doneBefore = cellsOf(snap).filter((c) => c.state === "succeeded").length;
    expect(doneBefore).toBeGreaterThan(0);
    for (const r of snap.runs) b.workspace.retryUnfinished(r.id);
    await b.workspace.whenIdle();
    expect(cellsOf(b.workspace.snapshot()).every((c) => c.state === "succeeded")).toBe(true);
  });
});

describe("recovery after the app closes unexpectedly (AC-10)", () => {
  it("offers the unsaved work next time, interrupts the attempt in progress, and resumes without redoing finished blocks", async () => {
    const { dir, recoveryPath, make } = env({ speedMs: 15 });
    const a = make();
    a.workspace.start(job({ models: [model("alpha")] }));
    await until(() => {
      const c = cellsOf(a.workspace.snapshot());
      return c.filter((x) => x.state === "succeeded").length >= 2 && c.some((x) => x.state === "running");
    });
    // The app is killed here: whatever is on disk at this moment is all that survives.
    const crashCopy = join(dir, "crash-copy.ltw.json");
    await until(() => existsSync(recoveryPath));
    copyFileSync(recoveryPath, crashCopy);
    a.workspace.cancel({ kind: "job" });
    await a.workspace.whenIdle();

    const b = make({ recoveryPath: crashCopy, speedMs: 0 });
    expect(b.view().recovery).toMatchObject({ blocks: expect.any(Number), models: 1 });
    expect(b.workspace.snapshot().revision).toBeNull();
    b.restoreRecovery();

    const snap = b.workspace.snapshot();
    expect(snap.runs[0]!.state).toBe("interrupted");
    const succeededIds = Object.entries(snap.runs[0]!.blocks).filter(([, c]) => c.state === "succeeded");
    expect(succeededIds.length).toBeGreaterThanOrEqual(1);
    expect(Object.values(snap.runs[0]!.blocks).some((c) => c.state === "running")).toBe(false);
    expect(b.view()).toMatchObject({ dirty: true, recovery: null });

    b.workspace.retryUnfinished(snap.runs[0]!.id);
    await b.workspace.whenIdle();
    const final = b.workspace.snapshot().runs[0]!;
    expect(Object.values(final.blocks).every((c) => c.state === "succeeded")).toBe(true);
    for (const [id] of succeededIds) expect(final.blocks[id]!.attempts).toBe(1); // finished blocks were not regenerated
  });

  it("keeps a recovery copy while work is unsaved and removes it after Save", async () => {
    const { dir, answers, recoveryPath, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    expect(existsSync(recoveryPath)).toBe(true);
    answers.save = join(dir, "s.ltw.json");
    await a.save(false);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("does not offer a recovery copy that is older than the saved file", async () => {
    const { dir, answers, recoveryPath, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    answers.save = join(dir, "later.ltw.json");
    await a.save(false);
    const snap = a.workspace.snapshot();
    a.workspace.editBlock(snap.runs[0]!.id, snap.revision!.blocks[0]!.id, "unsaved edit");
    await until(() => existsSync(recoveryPath));
    const stale = join(dir, "stale.ltw.json");
    copyFileSync(recoveryPath, stale);
    await new Promise((r) => setTimeout(r, 30));
    await a.save(false); // saved after the copy was made
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, "later.ltw.json"), future, future);
    const b = make({ recoveryPath: stale });
    expect(b.view().recovery).toBeNull();
    expect(existsSync(stale)).toBe(false);
  });

  it("blocks Open and New until recovered work is restored or discarded, and Discard removes the copy", async () => {
    const { dir, answers, recoveryPath, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const b = make({ recoveryPath });
    expect(b.view().recovery).not.toBeNull();
    answers.open = join(dir, "whatever.ltw.json");
    await expect(b.open(false)).rejects.toMatchObject({ code: "recovery_pending" });
    expect(() => b.newProject()).toThrow(/recovered work/);
    b.discardRecovery();
    expect(b.view().recovery).toBeNull();
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("sets aside an unreadable recovery copy instead of deleting it", () => {
    const { recoveryPath, make } = env();
    mkdirSync(join(recoveryPath, ".."), { recursive: true });
    writeFileSync(recoveryPath, "{ broken");
    const p = make();
    expect(p.view().recovery).toBeNull();
    expect(existsSync(`${recoveryPath}.damaged`)).toBe(true);
  });

  it("stops translating when progress cannot be saved, and says so", async () => {
    const { dir, make } = env();
    writeFileSync(join(dir, "blocker"), "x");
    const a = make({ recoveryPath: join(dir, "blocker", "recovery.json") }); // cannot be created
    a.workspace.start(job({ models: [model("alpha")] }));
    await a.workspace.whenIdle();
    const snap = a.workspace.snapshot();
    expect(snap.job?.state).toBe("interrupted");
    expect(snap.job?.stopReason).toMatch(/Could not save progress/);
    expect(a.view().notice).toMatch(/Progress could not be kept safe/);
    expect(cellsOf(snap).filter((c) => c.state === "succeeded").length).toBe(1);
  });
});

describe("files that cannot be opened safely", () => {
  const twoSaves = async () => {
    const e = env();
    const a = e.make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    e.answers.save = join(e.dir, "p.ltw.json");
    await a.save(false);
    const snap = a.workspace.snapshot();
    a.workspace.editBlock(snap.runs[0]!.id, snap.revision!.blocks[0]!.id, "second version");
    await a.save(false);
    return { ...e, path: join(e.dir, "p.ltw.json"), a };
  };

  it("refuses a file whose text was changed outside the app, and offers the previous saved copy", async () => {
    const { dir, answers, make, path } = await twoSaves();
    const tampered = readFileSync(path, "utf8").replaceAll("最初", "最後");
    writeFileSync(path, tampered);
    const b = make({ recoveryPath: join(dir, "rb.json") });
    answers.open = path;
    await b.open(false);
    expect(b.workspace.snapshot().revision).toBeNull();
    expect(b.view().openProblem).toMatchObject({ canOpenBackup: true, message: expect.stringMatching(/damaged|changed outside/) });

    await b.open(true);
    const view = b.view();
    expect(b.workspace.snapshot().revision).not.toBeNull();
    expect(view).toMatchObject({ path: null, dirty: true, title: "Untitled", openProblem: null });
    expect(view.notice).toMatch(/previous saved copy/);
    expect(readFileSync(path, "utf8")).toBe(tampered); // the damaged file was not touched
  });

  it("saving the recovered copy elsewhere never overwrites the good backup", async () => {
    const { dir, answers, make, path } = await twoSaves();
    const goodBackup = readFileSync(`${path}.bak`, "utf8");
    writeFileSync(path, "garbage");
    const b = make({ recoveryPath: join(dir, "rc.json") });
    answers.open = path;
    await b.open(false);
    await b.open(true);
    answers.save = join(dir, "recovered.ltw.json");
    await b.save(false);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(goodBackup);
    expect(b.view()).toMatchObject({ dirty: false, title: "recovered" });
  });

  it("explains a damaged file with no backup, and files that are not projects or are too new", async () => {
    const { dir, answers, make } = env();
    const b = make();
    const tryOpen = async (content: string) => {
      const p = join(dir, `f${Math.random()}.ltw.json`);
      writeFileSync(p, content);
      answers.open = p;
      await b.open(false);
      return b.view().openProblem;
    };
    expect(await tryOpen("not json")).toMatchObject({ canOpenBackup: false, message: expect.stringContaining("not readable") });
    expect(await tryOpen('{"a":1}')).toMatchObject({ message: expect.stringContaining("not a Local Translation Workbench project") });
    expect(await tryOpen('{"format":"ltw-project","schemaVersion":9}')).toMatchObject({ message: expect.stringContaining("newer version") });
    answers.open = join(dir, "missing.ltw.json");
    await b.open(false);
    expect(b.view().openProblem?.message).toMatch(/could not be read/);
    b.dismissProblem();
    expect(b.view().openProblem).toBeNull();
    expect(b.workspace.snapshot().revision).toBeNull();
  });

  it("a failed open leaves the current workspace alone", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const before = a.workspace.snapshot().runs;
    answers.save = join(dir, "ok.ltw.json");
    await a.save(false);
    const bad = join(dir, "bad.ltw.json");
    writeFileSync(bad, "nope");
    answers.open = bad;
    await a.open(false);
    expect(a.workspace.snapshot().runs).toEqual(before);
    expect(a.view().openProblem).not.toBeNull();
  });
});

describe("other rules", () => {
  it("cannot open or start a new project while a translation is running", async () => {
    const { dir, answers, make } = env({ speedMs: 20 });
    const a = make();
    a.workspace.start(job());
    answers.open = join(dir, "x.ltw.json");
    await expect(a.open(false)).rejects.toMatchObject({ code: "busy" });
    expect(() => a.newProject()).toThrow(/Cancel/);
    a.workspace.cancel({ kind: "job" });
    await a.workspace.whenIdle();
  });

  it("New project empties the workspace and removes the recovery copy", async () => {
    const { recoveryPath, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    expect(existsSync(recoveryPath)).toBe(true);
    a.newProject();
    expect(a.workspace.snapshot().revision).toBeNull();
    expect(a.view()).toMatchObject({ title: "Untitled", dirty: false, path: null });
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("the window's commands work through the handler and the project info reaches the snapshot", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const h = createHandler(a.workspace, undefined, a);
    expect((await h("1", "job.start", job({ models: [model("alpha")] }))).ok).toBe(true);
    await a.workspace.whenIdle();
    answers.save = join(dir, "via-handler.ltw.json");
    const saved = await h("2", "project.save", { saveAs: false });
    expect(saved).toMatchObject({ ok: true, value: { project: { title: "via-handler", dirty: false } } });
    expect(await h("3", "project.save", { saveAs: "yes" })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await h("4", "project.new", undefined)).toMatchObject({ ok: true, value: { revision: null, project: { title: "Untitled" } } });
    answers.open = join(dir, "via-handler.ltw.json");
    expect(await h("5", "project.open", { useBackup: false })).toMatchObject({ ok: true, value: { project: { title: "via-handler" } } });
    expect(await createHandler(a.workspace)("6", "project.new", undefined)).toMatchObject({ ok: false, error: { code: "no_project" } });
  });
});

describe("exporting", () => {
  const exp = (runIds: string[], over: Partial<import("@ltw/domain").ExportInput> = {}): import("@ltw/domain").ExportInput => ({
    format: "text",
    runIds,
    textVersion: "current",
    allowPartial: false,
    formulaSafe: true,
    ...over,
  });

  it("writes a plain-text file, adds the extension, and the file is exactly what the preview promised", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const runId = a.workspace.snapshot().runs[0]!.id;
    const preview = a.exportPreview(exp([runId]));
    expect(preview).toMatchObject({ complete: true, extension: ".txt", problem: null });
    answers.export = join(dir, "chapter-one");
    const r = await a.exportFile(exp([runId]));
    const path = join(dir, "chapter-one.txt");
    expect(r).toEqual({ path, bytes: preview.bytes });
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("[practice translation by alpha]")).toBe(true);
    expect(Buffer.byteLength(text)).toBe(preview.bytes);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("writes a comparison CSV with a byte-order mark so Excel reads Japanese correctly", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a);
    const ids = a.workspace.snapshot().runs.map((r) => r.id);
    answers.export = join(dir, "compare.csv");
    await a.exportFile(exp(ids, { format: "csv" }));
    const bytes = readFileSync(join(dir, "compare.csv"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text).toContain("alpha status");
    expect(text).toContain("beta status");
    expect(text).toContain("最初の段落");
  });

  it("refuses an incomplete export until it is explicitly allowed, then marks the gaps", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")], demo: { speed: "fast", smallBlocks: true, failBlockOnce: 2, firstModelUnloaded: false } }));
    const runId = a.workspace.snapshot().runs[0]!.id;
    const preview = a.exportPreview(exp([runId]));
    expect(preview.complete).toBe(false);
    expect(preview.gaps).toEqual([expect.objectContaining({ blockNumber: 2, status: "Failed" })]);
    answers.export = join(dir, "partial.txt");
    await expect(a.exportFile(exp([runId]))).rejects.toMatchObject({ code: "partial_not_allowed", message: expect.stringContaining("Export partial") });
    expect(existsSync(join(dir, "partial.txt"))).toBe(false);
    await a.exportFile(exp([runId], { allowPartial: true }));
    expect(readFileSync(join(dir, "partial.txt"), "utf8")).toContain("[Block 2 missing: Failed]");
  });

  it("cancelling the save dialog writes nothing", async () => {
    const { answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    answers.export = undefined;
    expect(await a.exportFile(exp([a.workspace.snapshot().runs[0]!.id]))).toEqual({ path: null, bytes: 0 });
  });

  it("reports an unwritable location in plain words and keeps everything intact", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    writeFileSync(join(dir, "afile"), "x");
    answers.export = join(dir, "afile", "out.txt");
    await expect(a.exportFile(exp([a.workspace.snapshot().runs[0]!.id]))).rejects.toMatchObject({ code: "export_failed", message: expect.stringContaining("another folder") });
  });

  it("never changes the project and never starts any translation", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const before = a.workspace.snapshot();
    const dirtyBefore = a.view().dirty;
    answers.export = join(dir, "x.md");
    await a.exportFile(exp(before.runs.map((r) => r.id), { format: "markdown" }));
    a.exportPreview(exp(before.runs.map((r) => r.id), { format: "csv" }));
    const after = a.workspace.snapshot();
    expect(after.runs).toEqual(before.runs);
    expect(after.busy).toBe(false);
    expect(after.job).toEqual(before.job);
    expect(a.view().dirty).toBe(dirtyBefore);
  });

  it("explains when there is nothing to export or the choice is invalid", async () => {
    const { make } = env();
    expect(() => make().exportPreview(exp(["x"]))).toThrow(/nothing to export/i);
    const a = make();
    await runWholeJob(a);
    const ids = a.workspace.snapshot().runs.map((r) => r.id);
    await expect(a.exportFile(exp(ids))).rejects.toMatchObject({ code: "export_problem", message: expect.stringContaining("one model at a time") });
  });

  it("works through the window's commands", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const h = createHandler(a.workspace, undefined, a);
    await h("1", "job.start", job({ models: [model("alpha")] }));
    await a.workspace.whenIdle();
    const runId = a.workspace.snapshot().runs[0]!.id;
    const body = { format: "markdown", runIds: [runId], textVersion: "current", allowPartial: false, formulaSafe: true };
    expect(await h("2", "export.preview", body)).toMatchObject({ ok: true, value: { complete: true, extension: ".md" } });
    answers.export = join(dir, "via.md");
    expect(await h("3", "export.write", body)).toMatchObject({ ok: true, value: { path: join(dir, "via.md") } });
    expect(await h("4", "export.write", { ...body, format: "pdf" })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await createHandler(a.workspace)("5", "export.write", body)).toMatchObject({ ok: false, error: { code: "no_project" } });
  });
});

describe("versions in saved projects", () => {
  it("saves every version and reopens them all, with the newest in view", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const firstId = a.workspace.snapshot().revision!.id;
    a.workspace.start(job({ models: [model("alpha")], text: job().text + "\n\n追加の段落です。" }));
    await a.workspace.whenIdle();
    answers.save = join(dir, "two.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "two.ltw.json");
    await b.open(false);
    const snap = b.workspace.snapshot();
    expect(snap.versions.map((v) => v.number)).toEqual([1, 2]);
    expect(snap.viewingId).toBe(snap.latestId);
    expect(snap.revision!.text).toContain("追加の段落");
    expect(b.workspace.viewVersion(firstId).revision!.text).not.toContain("追加の段落");
    expect(b.workspace.snapshot().runs[0]!.blocks).toEqual(a.workspace.viewVersion(firstId).runs[0]!.blocks);
  });

  it("keeps removed models in the file", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha"), model("beta")] }));
    a.workspace.archiveRun(a.workspace.snapshot().runs[1]!.id);
    answers.save = join(dir, "arch.ltw.json");
    await a.save(false);
    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "arch.ltw.json");
    await b.open(false);
    const snap = b.workspace.snapshot();
    expect(snap.runs.map((r) => r.label)).toEqual(["alpha"]);
    expect(snap.archived.map((r) => r.label)).toEqual(["beta"]);
    b.workspace.restoreArchivedRun(snap.archived[0]!.runId);
    expect(Object.values(b.workspace.snapshot().runs[1]!.blocks).every((c) => c.text !== null)).toBe(true);
  });

  it("opens a project saved by the first release, and editing its text adds a second version", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const v = a.workspace.exportVersions()[0]!;
    const old = { format: "ltw-project", schemaVersion: 1, project: { id: "p", title: "Old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: 1 }, backend: v.backend, source: v.source, runs: v.runs };
    writeFileSync(join(dir, "old.ltw.json"), JSON.stringify(old));
    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "old.ltw.json");
    await b.open(false);
    const snap = b.workspace.snapshot();
    expect(b.view().openProblem).toBeNull();
    expect(snap.versions).toHaveLength(1);
    expect(snap.runs[0]!.label).toBe("alpha");
    b.workspace.start(job({ models: [model("alpha")], text: "全く別の本文です。" }));
    await b.workspace.whenIdle();
    expect(b.workspace.snapshot().versions).toHaveLength(2);
  });

  it("exports the version being viewed", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")], text: "古い本文です。" }));
    const oldId = a.workspace.snapshot().revision!.id;
    a.workspace.start(job({ models: [model("alpha")], text: "新しい本文です。" }));
    await a.workspace.whenIdle();
    const exportOf = async (name: string) => {
      answers.export = join(dir, name);
      const runId = a.workspace.snapshot().runs[0]!.id;
      await a.exportFile({ format: "text", runIds: [runId], textVersion: "current", allowPartial: false, formulaSafe: true });
      return readFileSync(join(dir, name), "utf8");
    };
    expect(await exportOf("new.txt")).toContain("新しい本文");
    a.workspace.viewVersion(oldId);
    expect(await exportOf("old.txt")).toContain("古い本文");
  });
});


describe("changed settings and saved projects", () => {
  it("syncing settings does not mark the project as having unsaved changes", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    answers.save = join(dir, "s.ltw.json");
    await a.save(false);
    expect(a.view().dirty).toBe(false);
    const j = job({ models: [model("alpha")] });
    a.workspace.syncSettings({ sourceLanguage: j.sourceLanguage, targetLanguage: j.targetLanguage, models: j.models, prompts: [], blockSize: "normal", glossary: [{ source: "段落", target: "paragraph" }] });
    expect(a.view().dirty).toBe(false);
  });

  it("a reopened project knows which blocks used older settings once the settings are known", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const j = job({ models: [model("alpha")] });
    await runWholeJob(a, j);
    answers.save = join(dir, "o.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "o.ltw.json");
    await b.open(false);
    expect(b.workspace.snapshot().runs[0]!.outdated).toBe(0);
    const synced = b.workspace.syncSettings({ sourceLanguage: j.sourceLanguage, targetLanguage: j.targetLanguage, models: j.models, prompts: [], blockSize: "normal", glossary: [{ source: "段落", target: "paragraph" }] });
    expect(synced.runs[0]!.outdated).toBeGreaterThan(0);
    b.workspace.start({ ...j, glossary: [{ source: "段落", target: "paragraph" }] });
    await b.workspace.whenIdle();
    const after = b.workspace.snapshot();
    expect(after.runs[0]!.outdated).toBe(0);
    expect(Object.values(after.runs[0]!.blocks).some((c) => c.text?.includes("paragraph"))).toBe(true);
  });
});

describe("documents in saved projects", () => {
  const settings = (j = job({ models: [model("alpha")] })) => ({
    sourceLanguage: j.sourceLanguage,
    targetLanguage: j.targetLanguage,
    blockSize: j.blockSize,
    models: j.models,
    glossary: [{ source: "段落", target: "paragraph" }],
    notes: "",
    prompts: [],
  });

  it("saves every document with its text, results and the project's shared settings, and reopens them", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const j = job({ models: [model("alpha")] });
    a.workspace.syncSettings(settings(j));
    await runWholeJob(a, j);
    const first = a.workspace.snapshot().activeDocumentId;
    a.workspace.createDocument("Chapter 2");
    a.workspace.setDraft(a.workspace.snapshot().activeDocumentId, "まだ実行していない章。");
    a.workspace.createDocument("Chapter 3");
    a.workspace.start({ ...j, text: "第三章の本文です。" });
    await a.workspace.whenIdle();
    a.workspace.selectDocument(first);
    answers.save = join(dir, "book.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "book.ltw.json");
    await b.open(false);
    const snap = b.workspace.snapshot();
    expect(snap.documents.map((d) => [d.title, d.blocks > 0, d.hasText])).toEqual([["Document 1", true, true], ["Chapter 2", false, true], ["Chapter 3", true, true]]);
    expect(snap.activeDocumentId).toBe(first);
    // A glossary kept in the settings (the way older projects did) moves into the project's knowledge when opened.
    expect(snap.settings).toEqual({ ...settings(j), glossary: [] });
    expect(b.workspace.knowledgeList({}).entries).toMatchObject([{ kind: "term", source: "段落", target: "paragraph" }]);
    expect(b.workspace.selectDocument(snap.documents[1]!.id).draftText).toBe("まだ実行していない章。");
    expect(b.workspace.selectDocument(snap.documents[2]!.id).revision!.text).toBe("第三章の本文です。");
    expect(b.view().dirty).toBe(false);
  });

  it("text typed but never run counts as work: it can be saved, makes the project unsaved, and survives a crash", async () => {
    const { dir, recoveryPath, answers, make } = env();
    const a = make();
    expect(a.view().dirty).toBe(false);
    a.workspace.setDraft(a.workspace.snapshot().activeDocumentId, "長い文章を書いている途中。");
    expect(a.view().dirty).toBe(true);
    await until(() => existsSync(recoveryPath));
    const crashCopy = join(dir, "crash.ltw.json");
    copyFileSync(recoveryPath, crashCopy);

    const b = make({ recoveryPath: crashCopy });
    expect(b.view().recovery).toMatchObject({ blocks: 0, models: 0, documents: 1 });
    b.restoreRecovery();
    expect(b.workspace.snapshot().draftText).toBe("長い文章を書いている途中。");

    answers.save = join(dir, "draft.ltw.json");
    await a.save(false); // saving is allowed with only a draft
    expect(existsSync(join(dir, "draft.ltw.json"))).toBe(true);
  });

  it("switching documents is not a change to save, but adding, renaming and typing are", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    answers.save = join(dir, "d.ltw.json");
    await a.save(false);
    const first = a.workspace.snapshot().activeDocumentId;
    expect(a.view().dirty).toBe(false);
    a.workspace.createDocument();
    expect(a.view().dirty).toBe(true);
    await a.save(false);
    a.workspace.selectDocument(first);
    expect(a.view().dirty).toBe(false);
    a.workspace.renameDocument(first, "Prologue");
    expect(a.view().dirty).toBe(true);
    await a.save(false);
    a.workspace.setDraft(first, "変更。");
    expect(a.view().dirty).toBe(true);
  });

  it("opens a project saved before documents existed as one document holding its text", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    const versions = a.workspace.exportVersions();
    const old = { format: "ltw-project", schemaVersion: 2, project: { id: "p", title: "Old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: 1 }, versions };
    writeFileSync(join(dir, "v2.ltw.json"), JSON.stringify(old));
    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "v2.ltw.json");
    await b.open(false);
    const snap = b.workspace.snapshot();
    expect(b.view().openProblem).toBeNull();
    expect(snap.documents).toHaveLength(1);
    expect(snap.draftText).toBe(versions[0]!.source.exactText);
    expect(snap.runs[0]!.label).toBe("alpha");
    expect(snap.settings).toBeNull(); // the window keeps its own choices
  });

  it("exports the open document, and says so when it has nothing to export yet", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await runWholeJob(a, job({ models: [model("alpha")] }));
    a.workspace.createDocument();
    const input = { format: "text" as const, runIds: [], textVersion: "current" as const, allowPartial: false, formulaSafe: true };
    expect(() => a.exportPreview(input)).toThrow(/Run the open document first/);
    answers.export = join(dir, "x.txt");
    a.workspace.selectDocument(a.workspace.snapshot().documents[0]!.id);
    const runId = a.workspace.snapshot().runs[0]!.id;
    await expect(a.exportFile({ ...input, runIds: [runId] })).resolves.toMatchObject({ path: join(dir, "x.txt") });
  });

  it("a new project starts with one empty document and forgets the old settings", async () => {
    const { make } = env();
    const a = make();
    const j = job({ models: [model("alpha")] });
    a.workspace.syncSettings(settings(j));
    await runWholeJob(a, j);
    a.workspace.createDocument();
    a.newProject();
    const snap = a.workspace.snapshot();
    expect(snap.documents).toHaveLength(1);
    expect(snap.settings).toBeNull();
    expect(a.view().dirty).toBe(false);
  });
});

describe("names, hints and notes in saved projects", () => {
  it("saves the knowledge with the project, reopens it, and brings an older project's glossary over once", async () => {
    const { dir, answers, make } = env();
    const a = make();
    a.workspace.knowledgeSave({ kind: "term", source: "魔王", target: "Demon King", hint: "villain", text: "", about: null, category: "term" as const, aliases: [] });
    a.workspace.knowledgeSave({ kind: "note", source: "", target: "", hint: "", text: "He speaks formally.", about: null, category: "term" as const, aliases: [] });
    await a.workspace.researchBlock({ backend: "practice", modelId: "x", contextLimit: 4096, maxOutputTokens: 512, sourceLanguage: "Japanese", targetLanguage: "English", passage: "魔王が来た。" });
    expect(Object.keys(a.workspace.exportProject().knowledge.research)).toHaveLength(1);
    answers.save = join(dir, "kb.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "kb.ltw.json");
    await b.open(false);
    expect(b.workspace.knowledgeList({}).entries).toMatchObject([{ source: "魔王", hint: "villain" }, { text: "He speaks formally." }]);
    expect(b.workspace.snapshot().knowledge).toMatchObject({ terms: 1, notes: 1 });
    expect(b.workspace.exportProject().knowledge.research).toEqual(a.workspace.exportProject().knowledge.research);

    // An older project kept them in its settings.
    const old = JSON.parse(readFileSync(join(dir, "kb.ltw.json"), "utf8"));
    delete old.knowledge;
    old.settings = { sourceLanguage: "Japanese", targetLanguage: "English", blockSize: "normal", models: [], glossary: [{ source: "勇者", target: "Hero" }], notes: "Keep honorifics.", prompts: [] };
    writeFileSync(join(dir, "old.ltw.json"), JSON.stringify(old));
    const c = make({ recoveryPath: join(dir, "r2.json") });
    answers.open = join(dir, "old.ltw.json");
    await c.open(false);
    expect(c.workspace.knowledgeList({}).entries).toMatchObject([{ kind: "term", source: "勇者" }, { kind: "note", text: "Keep honorifics." }]);
    expect(c.workspace.snapshot().settings?.glossary).toEqual([]);
  });
});

describe("topics in saved projects", () => {
  it("saves topics with their attributes and links, and the classes, and reopens them", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const school = a.workspace.knowledgeCreate("place", "学園").id;
    const hanako = a.workspace.knowledgeCreate("character", "花子").id;
    a.workspace.knowledgeSetFile(hanako, a.workspace.knowledgeFile(hanako).text.replace("english: 花子", "english: Hanako").replace("gender:", "gender: female").replace("lives in:", "lives in: [[学園]]"));
    a.workspace.knowledgeSetFile("classes", "# item\nowner: link(character)\n");
    answers.save = join(dir, "topics.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "topics.ltw.json");
    await b.open(false);
    expect(b.workspace.knowledgeFiles().classes.map((c) => c.name)).toEqual(["item"]);
    expect(b.workspace.knowledgeList({ kind: "term" }).entries.find((e) => e.id === hanako)).toMatchObject({ target: "Hanako", attrs: { gender: ["female"], "lives in": ["学園"] } });
    expect(b.workspace.knowledgeFile(school).backlinks).toEqual([{ id: hanako, title: "花子" }]);
  });
});

describe("older classes text", () => {
  it("is replaced by the explained default when a project still has the old default", async () => {
    const { dir, answers, make } = env();
    const a = make();
    a.workspace.knowledgeCreate("character", "花子");
    answers.save = join(dir, "old-classes.ltw.json");
    await a.save(false);
    const file = JSON.parse(readFileSync(join(dir, "old-classes.ltw.json"), "utf8"));
    file.knowledge.classes = LEGACY_CLASSES_TEXT;
    writeFileSync(join(dir, "old-classes.ltw.json"), JSON.stringify(file));
    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "old-classes.ltw.json");
    await b.open(false);
    expect(b.workspace.knowledgeFile("classes").text).toBe(DEFAULT_CLASSES_TEXT);
  });
});

