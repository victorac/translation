import { describe, expect, it } from "vitest";
import type { DemoOptions, ModelSetting, StartJobInput } from "@ltw/domain";
import { WorkspaceService, UserError } from "./service.js";
import { createHandler } from "./handlers.js";

const demo: DemoOptions = { speed: "fast", smallBlocks: true, failBlockOnce: null, firstModelUnloaded: false };
const TEXT = "これは最初の段落です。とても短いです。\n\nこれは二番目の段落です。もう少し長い文章にします。\n\n三番目の段落もあります。これで終わりです。";
const model = (name: string, over: Partial<ModelSetting> = {}): ModelSetting => ({ name, contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2, promptId: "standard", useGlossary: true, ...over });
const input = (over: Partial<StartJobInput> = {}): StartJobInput => ({
  text: TEXT,
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  backend: "practice",
  models: [model("alpha")],
  glossary: [],
  prompts: [],
  blockSize: "normal",
  rerun: [],
  demo,
  ...over,
});
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("timed out");
};

describe("WorkspaceService", () => {
  it("starts empty", () => {
    expect(new WorkspaceService().snapshot()).toMatchObject({ revision: null, runs: [], job: null, busy: false });
  });

  it("translates pasted text with the practice translator and shows every block done", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha"), model("beta")] }));
    await s.whenIdle();
    const snap = s.snapshot();
    expect(snap.busy).toBe(false);
    expect(snap.job?.state).toBe("completed");
    expect(snap.revision!.blocks.length).toBeGreaterThan(1);
    expect(snap.runs.map((r) => r.label)).toEqual(["alpha", "beta"]);
    for (const run of snap.runs) {
      for (const b of snap.revision!.blocks) {
        const cell = run.blocks[b.id]!;
        expect(cell.state).toBe("succeeded");
        expect(cell.text).toBe(`[practice translation by ${run.label}] ${b.text}`);
      }
    }
  });

  it("explains problems in plain words", () => {
    const s = new WorkspaceService({ speedMs: 0 });
    const msg = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof UserError ? e.message : "other";
      }
      return "none";
    };
    expect(msg(() => s.start(input({ text: "  \n" })))).toMatch(/Paste some text/);
    expect(msg(() => s.start(input({ models: [] })))).toMatch(/at least one model/);
    expect(msg(() => s.start(input({ models: [model("a"), model("a")] })))).toMatch(/only be used once/);
    expect(msg(() => s.start(input({ text: "あ".repeat(400_000) })))).toMatch(/limit/);
  });

  it("practice failure: one block fails halfway, keeps the partial text, and retry fixes it", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ demo: { ...demo, failBlockOnce: 2 } }));
    await s.whenIdle();
    let snap = s.snapshot();
    const [b1, b2] = snap.revision!.blocks;
    const cell = snap.runs[0]!.blocks[b2!.id]!;
    expect(snap.job?.state).toBe("completed_with_issues");
    expect(cell.state).toBe("failed");
    expect(cell.draft).toContain("[practice translation");
    expect(cell.error).toMatch(/dropped the connection/);
    expect(snap.runs[0]!.blocks[b1!.id]!.state).toBe("succeeded");

    s.retryBlock(snap.runs[0]!.id, b2!.id);
    await s.whenIdle();
    snap = s.snapshot();
    expect(snap.runs[0]!.blocks[b2!.id]!.state).toBe("succeeded");
    expect(snap.busy).toBe(false);
  });

  it("practice waiting: unloaded model waits, then continues after loading and Retry", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ demo: { ...demo, firstModelUnloaded: true } }));
    await until(() => s.snapshot().waiting !== null);
    const w = s.snapshot().waiting!;
    expect(w).toMatchObject({ label: "alpha", code: "model_unavailable" });
    expect(s.snapshot().busy).toBe(true);
    s.loadDemoModel();
    s.resolveWaiting(w.runId, "retry");
    await s.whenIdle();
    expect(s.snapshot().job?.state).toBe("completed");
    expect(s.snapshot().waiting).toBeNull();
  });

  it("cancel stops the job and a new source can then be started", async () => {
    const s = new WorkspaceService({ speedMs: 20 });
    s.start(input());
    await until(() => Object.values(s.snapshot().runs[0]!.blocks).some((c) => c.state === "running"));
    expect(() => s.start(input())).toThrow(/already running/);
    s.cancel({ kind: "job" });
    await s.whenIdle();
    expect(s.snapshot().job?.state).toBe("canceled");
    expect(s.snapshot().busy).toBe(false);
    s.reset();
    expect(s.snapshot().revision).toBeNull();
  });

  it("edits a finished block and keeps it when asked to retry (candidate flow)", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input());
    await s.whenIdle();
    const runId = s.snapshot().runs[0]!.id;
    const blockId = s.snapshot().revision!.blocks[0]!.id;
    s.editBlock(runId, blockId, "My wording");
    expect(s.snapshot().runs[0]!.blocks[blockId]).toMatchObject({ text: "My wording", edited: true });
    s.retryBlock(runId, blockId);
    await s.whenIdle();
    const cell = s.snapshot().runs[0]!.blocks[blockId]!;
    expect(cell.text).toBe("My wording");
    expect(cell.candidateText).toContain("[practice translation");
    s.acceptCandidate(runId, blockId);
    expect(s.snapshot().runs[0]!.blocks[blockId]!.text).toContain("[practice translation");
  });

  it("notifies listeners as work progresses", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    let n = 0;
    s.onChange(() => n++);
    s.start(input());
    await s.whenIdle();
    expect(n).toBeGreaterThan(5);
  });
});

describe("createHandler", () => {
  it("validates input and never throws", async () => {
    const h = createHandler(new WorkspaceService({ speedMs: 0 }));
    expect(await h("1", "nope", undefined)).toMatchObject({ ok: false, error: { code: "unknown_command" } });
    expect(await h("2", "__proto__", undefined)).toMatchObject({ ok: false, error: { code: "unknown_command" } });
    expect(await h("3", "job.start", { text: 5 })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await h("4", "job.cancel", { kind: "run" })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await h("5", "block.edit", { runId: "x", blockId: "y", text: "t" })).toMatchObject({ ok: false, error: { code: "no_workspace" } });
    expect(await h("5b", "provider.get", undefined)).toMatchObject({ ok: false, error: { code: "no_provider" } });
    expect(await h("5c", "job.start", input({ models: [model("a", { contextLimit: 100 })] }))).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await h("6", "workspace.snapshot", undefined)).toMatchObject({ requestId: "6", ok: true });
    expect((await h("7", "job.start", input())).ok).toBe(true);
  });
});

describe("glossary and prompt styles", () => {
  const GLOSSARY = [{ source: "段落", target: "paragraph" }];
  const style = { id: "mine", name: "My style", description: "", template: "Translate {sourceLanguage} to {targetLanguage} briskly.", appendFraming: true };

  it("the practice translator follows the glossary it is sent, so nothing is flagged", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ glossary: GLOSSARY }));
    await s.whenIdle();
    const snap = s.snapshot();
    const cells = Object.values(snap.runs[0]!.blocks);
    expect(cells.every((c) => c.state === "succeeded")).toBe(true);
    expect(cells.some((c) => c.text?.includes("paragraph"))).toBe(true);
    expect(cells.some((c) => c.text?.includes("段落"))).toBe(false);
  });

  it("the same model with different styles becomes separate, clearly named columns", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha"), model("alpha", { promptId: "literary" }), model("alpha", { promptId: "mine" })], prompts: [style] }));
    await s.whenIdle();
    const runs = s.snapshot().runs;
    expect(runs.map((r) => r.label)).toEqual(["alpha", "alpha · Natural, literary", "alpha · My style"]);
    expect(runs.map((r) => r.promptName)).toEqual(["Standard", "Natural, literary", "My style"]);
    expect(s.snapshot().job?.state).toBe("completed");
  });

  it("always sends the glossary to every model, and notes reach the request and mark results out of date when changed", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ glossary: GLOSSARY, models: [model("alpha")] }));
    await s.whenIdle();
    const run = s.snapshot().runs[0]!;
    expect(run.label).toBe("alpha");
    expect(Object.values(run.blocks)[0]!.text).toContain("paragraph");
    expect(run.outdated).toBe(0);
    s.syncSettings({ ...input({ glossary: GLOSSARY, models: [model("alpha")] }), notes: "Hanako is a girl who speaks politely." });
    expect(s.snapshot().runs[0]!.outdated).toBeGreaterThan(0);
  });

  it("explains unusable styles, prompts and glossary rows in plain words", () => {
    const s = new WorkspaceService({ speedMs: 0 });
    const msg = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof UserError ? `${e.code}: ${e.message}` : "other";
      }
      return "none";
    };
    expect(msg(() => s.start(input({ models: [model("a", { promptId: "ghost" })] })))).toMatch(/^unknown_prompt:.*no longer exists/);
    expect(msg(() => s.start(input({ prompts: [{ ...style, template: "  " }], models: [model("a", { promptId: "mine" })] })))).toMatch(/^bad_prompt:.*no instructions/);
    expect(msg(() => s.start(input({ glossary: [{ source: "魔王", target: "" }] })))).toMatch(/^bad_glossary:.*no translation/);
    expect(msg(() => s.start(input({ models: [model("a"), model("a")] })))).toMatch(/^duplicate_models/);
  });

  it("a saved prompt style travels with the run", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha", { promptId: "mine" })], prompts: [style], glossary: GLOSSARY }));
    await s.whenIdle();
    const state = s.exportViewed();
    expect(state.runs[0]!.prompt).toEqual({ id: "mine", name: "My style", template: style.template, appendFraming: true });
    expect(state.runs[0]!.glossary).toEqual(GLOSSARY);
  });
});

describe("previewing how the text will be split", () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `${i + 1}番目の段落です。${"これは少し長い文章です。".repeat(8)}`).join("\n\n");

  it("shows exactly the blocks a real run would use", async () => {
    const cases = [
      input({ text: LONG, blockSize: "small" }),
      input({ text: LONG, blockSize: "normal" }),
      input({ text: LONG, blockSize: "large" }),
      input({ text: LONG, models: [model("tiny", { contextLimit: 2048, maxOutputTokens: 256 })] }),
      input({ text: TEXT, demo: { ...demo, smallBlocks: false } }),
    ];
    for (const c of cases) {
      const preview = new WorkspaceService({ speedMs: 0 }).previewSplit({ ...c, demo: c.demo.smallBlocks ? c.demo : { ...c.demo, smallBlocks: false } });
      const s = new WorkspaceService({ speedMs: 0 });
      s.start({ ...c, demo: c.demo.smallBlocks ? c.demo : { ...c.demo, smallBlocks: false } });
      await s.whenIdle();
      const real = s.snapshot().revision!.blocks;
      expect(preview.blocks.map((b) => b.text)).toEqual(real.map((b) => b.text));
      expect(preview.blocks.map((b) => b.estimatedTokens)).toEqual(real.map((b) => b.estimatedTokens));
      expect(preview.ok).toBe(true);
    }
  });

  it("bigger sizes make fewer blocks, and a small model's limits can make blocks smaller than asked", () => {
    const n = (over: Partial<StartJobInput>) => new WorkspaceService().previewSplit(input({ text: LONG, demo: { ...demo, smallBlocks: false }, ...over })).blocks.length;
    expect(n({ blockSize: "small" })).toBeGreaterThan(n({ blockSize: "normal" }));
    expect(n({ blockSize: "normal" })).toBeGreaterThanOrEqual(n({ blockSize: "large" }));
    const limited = new WorkspaceService().previewSplit(input({ text: LONG, blockSize: "large", demo: { ...demo, smallBlocks: false }, models: [model("small-ctx", { contextLimit: 2048, maxOutputTokens: 256 })] }));
    expect(limited.limitingModel).toBe("small-ctx");
    expect(limited.maxTokens).toBeLessThan(1800);
    expect(limited.models[0]).toMatchObject({ label: "small-ctx", contextLimit: 2048, fits: true });
  });

  it("works before any model is chosen, and says so", () => {
    const p = new WorkspaceService().previewSplit(input({ text: LONG, models: [], demo: { ...demo, smallBlocks: false } }));
    expect(p.ok).toBe(true);
    expect(p.blocks.length).toBeGreaterThan(0);
    expect(p.notes[0]).toMatch(/No model is chosen yet/);
    expect(p.limitingModel).toBeNull();
  });

  it("explains when there is nothing to show or the text is too big", () => {
    const s = new WorkspaceService();
    expect(s.previewSplit(input({ text: " \n " }))).toMatchObject({ ok: false, problem: expect.stringMatching(/Paste some text/), blocks: [] });
    const huge = s.previewSplit(input({ text: "あ".repeat(400_000) }));
    expect(huge).toMatchObject({ ok: false, problem: expect.stringMatching(/1 MiB/) });
    const many = s.previewSplit(input({ text: "あ".repeat(300_000), demo: { ...demo, smallBlocks: true } }));
    expect(many).toMatchObject({ ok: false, problem: expect.stringMatching(/limit is 2000/) });
  });

  it("reports models that cannot fit, and still shows the blocks", () => {
    const p = new WorkspaceService().previewSplit(input({ text: TEXT, models: [model("tiny", { contextLimit: 2048, maxOutputTokens: 1900 })], demo: { ...demo, smallBlocks: false } }));
    expect(p.ok).toBe(false);
    expect(p.issues[0]).toMatch(/tiny/);
    expect(p.models[0]!.fits).toBe(false);
    expect(p.blocks.length).toBeGreaterThan(0);
  });

  it("points out awkward cuts and divider lines in plain words", () => {
    const p = new WorkspaceService().previewSplit(input({ text: "あ".repeat(2000) + "\n\n***\n\n終わり。", blockSize: "small", demo: { ...demo, smallBlocks: false } }));
    expect(p.notes.join(" ")).toMatch(/cut in the middle of text/);
    expect(p.notes.join(" ")).toMatch(/divider line/);
    expect(p.blocks.some((b) => b.boundaryKind === "hard")).toBe(true);
  });

  it("normalizes line endings the same way a run does, and never changes anything", () => {
    const s = new WorkspaceService();
    const p = s.previewSplit(input({ text: "一行目。\r\n\r\n二行目。" }));
    expect(p.blocks.map((b) => b.text).join("")).toBe("一行目。\n\n二行目。");
    expect(s.snapshot().revision).toBeNull();
  });

  it("works through the window's command and rejects malformed requests", async () => {
    const h = createHandler(new WorkspaceService());
    const ok = await h("1", "source.preview", input({ text: TEXT }));
    expect(ok).toMatchObject({ ok: true, value: { blocks: expect.any(Array) } });
    expect(await h("2", "source.preview", { ...input(), blockSize: "huge" })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
  });
});

describe("versions of the text and what Run does", () => {
  const PARAS2 = TEXT + "\n\n四番目の段落です。追加された部分です。";

  const done = async (s: WorkspaceService) => {
    await s.whenIdle();
    return s.snapshot();
  };
  const attemptsOf = (snap: ReturnType<WorkspaceService["snapshot"]>, label: string) => Object.values(snap.runs.find((r) => r.label === label)!.blocks).map((c) => c.attempts);

  it("Run on text that is already fully translated says there is nothing to do", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input());
    await done(s);
    expect(() => s.start(input())).toThrow(/Everything is already translated/);
    expect(s.snapshot().versions).toHaveLength(1);
  });

  it("editing the text and running again makes a new version and keeps the old results", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha"), model("beta")] }));
    const first = await done(s);
    const firstId = first.revision!.id;

    s.start(input({ text: PARAS2, models: [model("alpha"), model("beta")] }));
    const second = await done(s);
    expect(second.versions.map((v) => v.number)).toEqual([1, 2]);
    expect(second.latestId).toBe(second.viewingId);
    expect(second.revision!.id).not.toBe(firstId);
    expect(second.revision!.text).toBe(PARAS2);
    expect(second.runs.map((r) => r.label)).toEqual(["alpha", "beta"]);
    expect(second.job?.state).toBe("completed");

    const old = s.viewVersion(firstId);
    expect(old.viewingId).toBe(firstId);
    expect(old.revision!.text).toBe(TEXT);
    expect(old.runs.map((r) => r.label)).toEqual(["alpha", "beta"]);
    expect(Object.values(old.runs[0]!.blocks).every((c) => c.state === "succeeded" && c.text !== null)).toBe(true);
    expect(old.runs.every((r) => r.versionId === firstId)).toBe(true);
    expect(s.viewVersion(second.revision!.id).revision!.text).toBe(PARAS2);
  });

  it("the new version points back at the one it came from, and results never mix", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input());
    await done(s);
    s.start(input({ text: PARAS2 }));
    await done(s);
    const state = s.exportVersions();
    expect(state[1]!.source.parentId).toBe(state[0]!.source.id);
    const ids = (v: (typeof state)[number]) => new Set(v.source.blocks.map((b) => b.id));
    for (const run of state[1]!.runs) for (const k of Object.keys(run.outputs)) expect(ids(state[0]!).has(k)).toBe(false);
  });

  it("with the same text, adding a model runs only the new one", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha")] }));
    await done(s);
    s.start(input({ models: [model("alpha"), model("beta")] }));
    const snap = await done(s);
    expect(snap.versions).toHaveLength(1);
    expect(snap.runs.map((r) => r.label)).toEqual(["alpha", "beta"]);
    expect(attemptsOf(snap, "alpha").every((n) => n === 1)).toBe(true); // alpha was not run again
    expect(attemptsOf(snap, "beta").every((n) => n === 1)).toBe(true);
    expect(Object.values(snap.runs[1]!.blocks).every((c) => c.state === "succeeded")).toBe(true);
  });

  it("with the same text, Run finishes unfinished blocks and leaves finished ones alone", async () => {
    const s = new WorkspaceService({ speedMs: 20 });
    s.start(input({ text: PARAS2 }));
    for (let i = 0; i < 400 && !Object.values(s.snapshot().runs[0]?.blocks ?? {}).some((c) => c.state === "succeeded"); i++) await new Promise((r) => setTimeout(r, 5));
    s.cancel({ kind: "job" });
    await s.whenIdle();
    const mid = s.snapshot();
    const finished = Object.entries(mid.runs[0]!.blocks).filter(([, c]) => c.state === "succeeded").map(([id]) => id);
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.length).toBeLessThan(Object.keys(mid.runs[0]!.blocks).length);
    s.start(input({ text: PARAS2 }));
    const snap = await done(s);
    expect(snap.versions).toHaveLength(1);
    expect(Object.values(snap.runs[0]!.blocks).every((c) => c.state === "succeeded")).toBe(true);
    for (const id of finished) expect(snap.runs[0]!.blocks[id]!.attempts).toBe(1);
  });

  it("a model named in rerun is translated again from the start, in place; the earlier text stays in the history", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha")] }));
    const first = await done(s);
    const runId = first.runs[0]!.id;
    s.start(input({ models: [model("alpha")], rerun: ["alpha"] }));
    const snap = await done(s);
    expect(snap.runs).toHaveLength(1);
    expect(snap.runs[0]!.id).toBe(runId);
    expect(snap.archived).toEqual([]);
    expect(attemptsOf(snap, "alpha").every((n) => n === 2)).toBe(true);
    const outputs = Object.values(s.exportViewed().runs[0]!.outputs);
    expect(outputs.every((o) => o.versions.length === 2)).toBe(true); // the first translation is kept as history
  });

  it("a removed model can be brought back", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha")] }));
    const first = await done(s);
    const runId = first.runs[0]!.id;
    const removed = s.archiveRun(runId);
    expect(removed.runs).toEqual([]);
    expect(removed.archived).toEqual([{ runId, label: "alpha" }]);
    const back = s.restoreArchivedRun(runId);
    expect(back.runs.map((r) => r.id)).toEqual([runId]);
    expect(Object.values(back.runs[0]!.blocks).every((c) => c.text !== null)).toBe(true);
  });

  it("removing a model hides it, keeps its results in the saved data, and cancels its queued work", async () => {
    const s = new WorkspaceService({ speedMs: 20 });
    s.start(input({ text: PARAS2, models: [model("alpha"), model("beta")] }));
    for (let i = 0; i < 400 && !s.snapshot().runs.some((r) => Object.values(r.blocks).some((c) => c.state === "running")); i++) await new Promise((r) => setTimeout(r, 5));
    const beta = s.snapshot().runs[1]!;
    const snap = s.archiveRun(beta.id);
    expect(snap.runs.map((r) => r.label)).toEqual(["alpha"]);
    expect(snap.archived.map((a) => a.label)).toEqual(["beta"]);
    await s.whenIdle();
    const stored = s.exportVersions()[0]!.runs;
    expect(stored.map((r) => [r.label, r.archived])).toEqual([["alpha", false], ["beta", true]]);
    expect(Object.values(stored[1]!.outputs).every((o) => o.state !== "running")).toBe(true);
  });

  it("cannot start while something is running, and unknown versions or runs are refused plainly", async () => {
    const s = new WorkspaceService({ speedMs: 20 });
    s.start(input());
    expect(() => s.start(input({ text: "別の本文。" }))).toThrow(/already running/);
    expect(() => s.viewVersion("nope")).toThrow(/does not exist/);
    expect(() => s.archiveRun("nope")).toThrow(/does not exist/);
    s.cancel({ kind: "job" });
    await s.whenIdle();
  });

  it("the window's commands cover versions and removing models", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    const h = createHandler(s);
    await h("1", "job.start", input());
    await s.whenIdle();
    await h("2", "job.start", input({ text: PARAS2 }));
    await s.whenIdle();
    const snap = s.snapshot();
    const first = snap.versions[0]!.id;
    expect(await h("3", "version.view", { versionId: first })).toMatchObject({ ok: true, value: { viewingId: first } });
    expect(await h("4", "version.view", { versionId: 5 })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    const runId = s.snapshot().runs[0]!.id;
    expect(await h("5", "run.archive", { runId })).toMatchObject({ ok: true, value: { runs: [] } });
    expect(await h("6", "run.restore", { runId })).toMatchObject({ ok: true, value: { runs: [expect.objectContaining({ id: runId })] } });
    expect(await h("7", "run.archive", { runId: "ghost" })).toMatchObject({ ok: false, error: { code: "unknown_run" } });
  });
});


describe("changed settings: Run and Retry use the current glossary", () => {
  const syncOf = (i: StartJobInput) => ({ sourceLanguage: i.sourceLanguage, targetLanguage: i.targetLanguage, models: i.models, glossary: i.glossary, prompts: i.prompts, blockSize: i.blockSize });
  const SECOND = [{ source: "二番目", target: "second" }];
  const finish = async (s: WorkspaceService) => {
    await s.whenIdle();
    return s.snapshot();
  };
  const idsWhere = (snap: ReturnType<WorkspaceService["snapshot"]>, pred: (text: string) => boolean) => snap.revision!.blocks.filter((b) => pred(b.text)).map((b) => b.id);

  const translated = async (over: Partial<StartJobInput> = {}) => {
    const s = new WorkspaceService({ speedMs: 0 });
    const i = input(over);
    s.start(i);
    return { s, i, snap: await finish(s) };
  };

  it("adding a term marks only the blocks that contain it as out of date, without running anything", async () => {
    const { s, i, snap } = await translated();
    expect(snap.runs[0]!.outdated).toBe(0);
    const after = s.syncSettings({ ...syncOf(i), glossary: SECOND });
    const marked = Object.entries(after.runs[0]!.blocks).filter(([, c]) => c.outdated).map(([id]) => id);
    expect(marked).toEqual(idsWhere(snap, (t) => t.includes("二番目")));
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.length).toBeLessThan(snap.revision!.blocks.length);
    expect(after.runs[0]!.outdated).toBe(marked.length);
    expect(after.busy).toBe(false);
  });

  it("Run then translates exactly those blocks again, in the same model run, with the new term", async () => {
    const { s, i, snap } = await translated();
    const runId = snap.runs[0]!.id;
    const affected = idsWhere(snap, (t) => t.includes("二番目"));
    const next = input({ glossary: SECOND });
    s.syncSettings(syncOf(next));
    s.start(next);
    const after = await finish(s);
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]!.id).toBe(runId);
    expect(after.archived).toEqual([]);
    const blocks = snap.revision!.blocks;
    blocks.forEach((b, idx) => {
      const cell = after.runs[0]!.blocks[b.id]!;
      expect(cell.attempts).toBe(affected.includes(b.id) ? 2 : 1);
      expect(cell.outdated).toBe(false);
      // the block right after a changed one was translated with the old text as context, so it is flagged as such
      const followsChanged = idx > 0 && affected.includes(blocks[idx - 1]!.id);
      expect(cell.state).toBe(followsChanged && !affected.includes(b.id) ? "stale" : "succeeded");
      if (affected.includes(b.id)) expect(cell.text).toContain("second");
    });
    expect(after.runs[0]!.outdated).toBe(0);
    void i;
  });

  it("Retry on a block uses the current glossary even without pressing Run", async () => {
    const { s, i, snap } = await translated();
    const run = snap.runs[0]!;
    const blockId = idsWhere(snap, (t) => t.includes("二番目"))[0]!;
    expect(run.blocks[blockId]!.text).not.toContain("second");
    s.syncSettings({ ...syncOf(i), glossary: SECOND });
    s.retryBlock(run.id, blockId);
    const after = await finish(s);
    const cell = after.runs[0]!.blocks[blockId]!;
    expect(cell.candidateText ?? cell.text).toContain("second");
    expect(cell.outdated).toBe(false);
  });

  it("text you edited is kept: the new translation is offered as a candidate", async () => {
    const { s, i, snap } = await translated();
    const run = snap.runs[0]!;
    const blockId = idsWhere(snap, (t) => t.includes("二番目"))[0]!;
    s.editBlock(run.id, blockId, "My own wording");
    const next = input({ glossary: SECOND });
    s.syncSettings(syncOf(next));
    expect(s.snapshot().runs[0]!.blocks[blockId]!.outdated).toBe(true); // the edit does not hide that the model's text is old
    s.start(next);
    const after = await finish(s);
    const cell = after.runs[0]!.blocks[blockId]!;
    expect(cell.text).toBe("My own wording");
    expect(cell.candidateText).toContain("second");
    void i;
  });

  it("when everything is up to date Run says so, and rerun translates every block again anyway", async () => {
    const { s, i, snap } = await translated();
    expect(() => s.start(i)).toThrow(/already translated with the current settings/);
    s.start({ ...i, rerun: [snap.runs[0]!.label] });
    const after = await finish(s);
    expect(Object.values(after.runs[0]!.blocks).every((c) => c.attempts === 2 && c.state === "succeeded")).toBe(true);
  });

  it("only changes that affect the wording count: temperature does, context and reply limits do not", async () => {
    const { s, i } = await translated();
    const changed = (m: Partial<ModelSetting>) => s.syncSettings({ ...syncOf(i), models: [{ ...i.models[0]!, ...m }] }).runs[0]!.outdated;
    expect(changed({ contextLimit: 8192, maxOutputTokens: 512 })).toBe(0);
    expect(changed({ temperature: 0.9 })).toBeGreaterThan(0);
    expect(changed({ temperature: 0.2 })).toBe(0);
  });

  it("a half-finished glossary row is ignored until it is complete, and the last good settings stay", async () => {
    const { s, i } = await translated();
    s.syncSettings({ ...syncOf(i), glossary: SECOND });
    const kept = s.syncSettings({ ...syncOf(i), glossary: [...SECOND, { source: "魔王", target: "" }] });
    expect(kept.runs[0]!.outdated).toBeGreaterThan(0);
    expect(s.syncSettings({ ...syncOf(i), models: [] }).runs[0]!.outdated).toBeGreaterThan(0);
  });

  it("a new style or turning the glossary off for a model is a different model run, so nothing is flagged", async () => {
    const { s, i } = await translated({ glossary: SECOND });
    const after = s.syncSettings({ ...syncOf(i), models: [{ ...i.models[0]!, promptId: "literary" }] });
    expect(after.runs[0]!.outdated).toBe(0);
  });

  it("sync only changes how things are shown, so it does not count as something to save", async () => {
    const { s, i } = await translated();
    const kinds: string[] = [];
    s.onChange((k) => kinds.push(k));
    s.syncSettings({ ...syncOf(i), glossary: SECOND });
    expect(kinds).toEqual(["view"]);
  });

  it("works through the window's command", async () => {
    const { s, i } = await translated();
    const h = createHandler(s);
    const r = await h("1", "settings.sync", { ...syncOf(i), glossary: SECOND });
    expect(r).toMatchObject({ ok: true, value: { runs: [expect.objectContaining({ outdated: expect.any(Number) })] } });
    expect(await h("2", "settings.sync", { models: "x" })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
  });
});


describe("text that is the request written back", () => {
  it("shows up as needing review with a plain note, so it can be found and retried", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input());
    await s.whenIdle();
    const snap = s.snapshot();
    const runId = snap.runs[0]!.id;
    const blockId = snap.revision!.blocks[0]!.id;
    s.editBlock(runId, blockId, '{"glossary":[{"source":"太郎","target":"Taro"}],"context":{"source":"って');
    const cell = s.snapshot().runs[0]!.blocks[blockId]!;
    expect(cell.state).toBe("needs_review");
    expect(cell.reviewNotes).toEqual([expect.stringContaining("request written back")]);
    // blocks further away are untouched (the one right after is marked out of date, because its context changed)
    const last = snap.revision!.blocks.at(-1)!;
    expect(snap.revision!.blocks.length).toBeGreaterThan(2);
    expect(s.snapshot().runs[0]!.blocks[last.id]!.state).toBe("succeeded");
  });
});

describe("documents in a project", () => {
  const CH2 = "第二章の本文です。\n\n新しい登場人物が現れた。";
  const idle = async (s: WorkspaceService) => {
    await s.whenIdle();
    return s.snapshot();
  };

  it("starts with one empty document", () => {
    const snap = new WorkspaceService().snapshot();
    expect(snap.documents).toEqual([expect.objectContaining({ title: "Document 1", blocks: 0, hasText: false })]);
    expect(snap.activeDocumentId).toBe(snap.documents[0]!.id);
    expect(snap.draftText).toBe("");
    expect(snap.revision).toBeNull();
  });

  it("a new document is empty and active; the first document keeps its results", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha")] }));
    const first = await idle(s);
    const firstDoc = first.activeDocumentId;

    const created = s.createDocument();
    expect(created.documents.map((d) => d.title)).toEqual(["Document 1", "Document 2"]);
    expect(created.activeDocumentId).not.toBe(firstDoc);
    expect(created.revision).toBeNull();
    expect(created.runs).toEqual([]);
    expect(created.draftText).toBe("");

    const back = s.selectDocument(firstDoc);
    expect(back.revision!.text).toBe(TEXT);
    expect(Object.values(back.runs[0]!.blocks).every((c) => c.state === "succeeded")).toBe(true);
    expect(back.draftText).toBe(TEXT);
  });

  it("documents are independent: each has its own versions and runs, and the models are shared", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha")] }));
    const one = await idle(s);
    s.createDocument("Chapter 2");
    s.start(input({ text: CH2, models: [model("alpha")] }));
    const two = await idle(s);

    expect(two.documents.map((d) => d.title)).toEqual(["Document 1", "Chapter 2"]);
    expect(two.versions).toHaveLength(1);
    expect(two.revision!.text).toBe(CH2);
    expect(two.runs[0]!.id).not.toBe(one.runs[0]!.id);
    expect(two.runs[0]!.label).toBe("alpha");
    // editing the second document creates its second version without touching the first document
    s.start(input({ text: CH2 + "\n\n追加。", models: [model("alpha")] }));
    expect((await idle(s)).versions).toHaveLength(2);
    expect(s.selectDocument(one.activeDocumentId).versions).toHaveLength(1);
  });

  it("the left rail's list shows each document's progress", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ models: [model("alpha"), model("beta")] }));
    await idle(s);
    s.createDocument("Draft only");
    s.setDraft(s.snapshot().activeDocumentId, "まだ実行していない。");
    const docs = s.snapshot().documents;
    expect(docs[0]).toMatchObject({ title: "Document 1", models: 2, hasText: true });
    expect(docs[0]!.total).toBe(docs[0]!.blocks * 2);
    expect(docs[0]!.done).toBe(docs[0]!.total);
    expect(docs[1]).toMatchObject({ title: "Draft only", blocks: 0, models: 0, done: 0, total: 0, hasText: true });
  });

  it("text typed into a document is kept with it, even before it has been run", () => {
    const s = new WorkspaceService();
    const first = s.snapshot().activeDocumentId;
    s.setDraft(first, "最初の草稿。");
    const second = s.createDocument().activeDocumentId;
    s.setDraft(second, "別の草稿。");
    expect(s.snapshot().draftText).toBe("別の草稿。");
    expect(s.selectDocument(first).draftText).toBe("最初の草稿。");
    expect(s.hasContent).toBe(true);
    expect(() => s.setDraft("nope", "x")).toThrow(/does not exist/);
  });

  it("running stores the text exactly as it was typed", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    const raw = "一行目。\r\n\r\n二行目。";
    s.start(input({ text: raw, models: [model("alpha")] }));
    await idle(s);
    expect(s.snapshot().draftText).toBe(raw);
    expect(s.snapshot().revision!.text).toBe("一行目。\n\n二行目。");
  });

  it("rename and delete: names are required, the open document moves to its neighbour, the last one is emptied", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    const a = s.snapshot().activeDocumentId;
    const b = s.createDocument().activeDocumentId;
    s.createDocument();
    expect(s.renameDocument(b, "  The party  ").documents[1]!.title).toBe("The party");
    expect(() => s.renameDocument(b, "   ")).toThrow(/needs a name/);

    const afterDelete = s.deleteDocument(b);
    expect(afterDelete.documents.map((d) => d.title)).toEqual(["Document 1", "Document 3"]);
    expect(afterDelete.activeDocumentId).toBe(afterDelete.documents[1]!.id); // it was not the open one, so nothing moved
    s.selectDocument(a);
    s.start(input({ models: [model("alpha")] }));
    await idle(s);
    const emptied = s.deleteDocument(a);
    expect(emptied.documents.map((d) => d.title)).toEqual(["Document 3"]);
    const last = s.deleteDocument(emptied.documents[0]!.id);
    expect(last.documents).toHaveLength(1);
    expect(last.documents[0]).toMatchObject({ title: "Document 1", hasText: false });
    expect(last.revision).toBeNull();
  });

  it("work is global while a document can be switched freely: switching never stops it, and a second job waits", async () => {
    const s = new WorkspaceService({ speedMs: 15 });
    s.start(input({ models: [model("alpha")] }));
    const firstDoc = s.snapshot().activeDocumentId;
    const second = s.createDocument().activeDocumentId;
    expect(s.snapshot().busy).toBe(true); // still translating the first document
    expect(() => s.start(input({ text: "別の文章。", models: [model("alpha")] }))).toThrow(/already running/);
    expect(() => s.deleteDocument(second)).toThrow(/Cancel the running/);
    s.selectDocument(firstDoc);
    await idle(s);
    expect(s.snapshot().job?.state).toBe("completed");
  });

  it("a model waiting in another document is still reported", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ demo: { ...demo, firstModelUnloaded: true } }));
    for (let i = 0; i < 300 && !s.snapshot().waiting; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.snapshot().waiting).not.toBeNull();
    s.createDocument();
    expect(s.snapshot().waiting).toMatchObject({ code: "model_unavailable" });
    s.cancel({ kind: "job" });
    await s.whenIdle();
  });

  it("the project's settings are remembered, and only a real change counts as something to save", () => {
    const s = new WorkspaceService();
    const i = input({ glossary: [{ source: "魔王", target: "Demon King" }], models: [model("alpha")] });
    const sync = (over: Record<string, unknown> = {}) => s.syncSettings({ sourceLanguage: i.sourceLanguage, targetLanguage: i.targetLanguage, models: i.models, glossary: i.glossary, prompts: i.prompts, blockSize: i.blockSize, ...over } as never);
    const kinds: string[] = [];
    s.onChange((k) => kinds.push(k));
    expect(s.snapshot().settings).toBeNull();
    sync();
    expect(s.snapshot().settings).toMatchObject({ blockSize: "normal", glossary: [{ source: "魔王", target: "Demon King" }], models: [expect.objectContaining({ name: "alpha" })] });
    sync(); // the same again
    sync({ blockSize: "large" });
    expect(kinds).toEqual(["view", "view", "state"]);
    sync({ glossary: [{ source: "魔王", target: "" }] }); // half-typed: ignored
    expect(s.snapshot().settings!.glossary).toEqual([{ source: "魔王", target: "Demon King" }]);
    expect(s.snapshot().settings!.blockSize).toBe("large");
  });

  it("the epoch changes when a project is started over or restored, not when documents are switched or text is typed", () => {
    const s = new WorkspaceService();
    const e0 = s.snapshot().epoch;
    s.setDraft(s.snapshot().activeDocumentId, "x");
    const other = s.createDocument().activeDocumentId;
    s.selectDocument(s.snapshot().documents[0]!.id);
    expect(s.snapshot().epoch).toBe(e0);
    void other;
    s.reset();
    expect(s.snapshot().epoch).toBeGreaterThan(e0);
    expect(s.snapshot().documents).toHaveLength(1);
    expect(s.snapshot().draftText).toBe("");
  });

  it("the window's commands cover documents", async () => {
    const s = new WorkspaceService();
    const h = createHandler(s);
    const id = s.snapshot().activeDocumentId;
    expect(await h("1", "document.setText", { documentId: id, text: "草稿" })).toMatchObject({ ok: true, value: { draftText: "草稿" } });
    const created = await h("2", "document.create", { title: "Chapter 2" });
    expect(created).toMatchObject({ ok: true, value: { documents: [expect.anything(), expect.objectContaining({ title: "Chapter 2" })] } });
    expect(await h("3", "document.select", { documentId: id })).toMatchObject({ ok: true, value: { activeDocumentId: id } });
    expect(await h("4", "document.rename", { documentId: id, title: "Prologue" })).toMatchObject({ ok: true });
    expect(await h("5", "document.select", { documentId: "ghost" })).toMatchObject({ ok: false, error: { code: "unknown_document" } });
    expect(await h("6", "document.setText", { documentId: id })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await h("7", "document.delete", { documentId: id })).toMatchObject({ ok: true });
  });
});
