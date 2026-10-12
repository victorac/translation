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

  it("with and without the glossary can be compared; the no-glossary column says so and is not checked", async () => {
    const s = new WorkspaceService({ speedMs: 0 });
    s.start(input({ glossary: GLOSSARY, models: [model("alpha"), model("alpha", { useGlossary: false })] }));
    await s.whenIdle();
    const [withG, without] = s.snapshot().runs;
    expect(without!.label).toBe("alpha · no glossary");
    const text = (r: typeof withG, i: number) => Object.values(r!.blocks)[i]!.text ?? "";
    expect(text(withG, 0)).toContain("paragraph");
    expect(text(without, 0)).toContain("段落");
    expect(Object.values(without!.blocks).every((c) => c.state === "succeeded")).toBe(true);
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
    const state = s.exportState();
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
