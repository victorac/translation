import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelSetting, StartJobInput, WorkspaceSnapshot } from "@ltw/domain";
import { createHandler } from "./handlers.js";
import { ProjectService, type FileDialogs } from "./project-service.js";

const made: ProjectService[] = [];
afterEach(() => {
  for (const p of made.splice(0)) p.dispose();
});

const model = (name: string): ModelSetting => ({ name, contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2 });
const PARAS = ["最初の段落です。とても短い。", "二番目の段落です。もう少し長い。", "三番目の段落です。さらに続く。", "四番目の段落です。まだ続く。", "五番目の段落です。これで最後。"];
const job = (over: Partial<StartJobInput> = {}): StartJobInput => ({
  text: PARAS.join("\n\n"),
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  backend: "practice",
  models: [model("alpha"), model("beta")],
  demo: { speed: "fast", smallBlocks: true, failBlockOnce: null, firstModelUnloaded: false },
  ...over,
});

function env(opts: { speedMs?: number; recoveryPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ltw-proj-"));
  const answers: { save?: string | undefined; open?: string | undefined } = {};
  const dialogs: FileDialogs = {
    chooseSavePath: async () => answers.save,
    chooseOpenPath: async () => answers.open,
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
    const tampered = readFileSync(path, "utf8").replace("最初", "最後");
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
