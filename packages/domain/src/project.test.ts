import { describe, expect, it } from "vitest";
import { buildProjectFile, parseProject, serializeProject, settleLoadedRun, type ProjectFile } from "./project.js";
import { createRevision } from "./revision.js";
import type { BlockOutput, ModelRun } from "./state.js";

const revision = createRevision({ text: "一つ目。\n\n二つ目。\n\n三つ目。", sourceLanguage: "Japanese", targetLanguage: "English", targetTokens: 5, maxTokens: 6 });

const doneOutput = (blockIndex: number, text: string): BlockOutput => {
  const b = revision.blocks[blockIndex]!;
  return {
    blockId: b.id,
    state: "succeeded",
    attempts: [{ id: `a${blockIndex}`, ordinal: 1, configHash: "c", sourceHash: b.textHash, contextHash: "x", state: "succeeded", rawOutput: text, finishReason: "stop" }],
    versions: [{ id: `v${blockIndex}`, blockId: b.id, attemptId: `a${blockIndex}`, kind: "generated", text, createdAt: "2026-01-01T00:00:00Z" }],
    currentVersionId: `v${blockIndex}`,
  };
};
const pendingOutput = (blockIndex: number): BlockOutput => ({ blockId: revision.blocks[blockIndex]!.id, state: "pending", attempts: [], versions: [] });

const makeRun = (): ModelRun => ({
  id: "run1",
  revisionId: revision.id,
  providerRefId: "main",
  modelId: "qwen",
  label: "qwen",
  config: { temperature: 0.2, maxOutputTokens: 1536, contextLimit: 4096 },
  promptVersion: "v1",
  glossary: [{ source: "魔王", target: "Demon King" }],
  state: "completed_with_issues",
  archived: false,
  outputs: Object.fromEntries([doneOutput(0, "One."), doneOutput(1, "Two."), pendingOutput(2)].map((o) => [o.blockId, o])),
});

const makeFile = (): ProjectFile =>
  structuredClone(
    buildProjectFile({
      id: "p1",
      title: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      version: 3,
      providerLabel: "http://localhost:1234/v1",
      versions: [{ source: revision, backend: "provider", runs: [makeRun()] }],
    }),
  );

const load = (f: ProjectFile) => parseProject(serializeProject(f));
const errorOf = (f: unknown) => {
  const r = parseProject(typeof f === "string" ? f : JSON.stringify(f));
  return r.ok ? null : r.error;
};

describe("project file", () => {
  it("round-trips exactly, including Unicode, edits and glossary", () => {
    const f = makeFile();
    f.versions[0]!.runs[0]!.outputs[revision.blocks[0]!.id]!.versions.push({
      id: "vm",
      blockId: revision.blocks[0]!.id,
      kind: "manual",
      text: "My “edit” 👍🏽\nline two",
      createdAt: "2026-01-03T00:00:00Z",
      baseVersionId: "v0",
    });
    f.versions[0]!.runs[0]!.outputs[revision.blocks[0]!.id]!.currentVersionId = "vm";
    const r = load(f);
    expect(r.ok).toBe(true);
    expect(r.ok && r.file).toEqual(f);
  });

  it("contains no secrets or paths, only the documented fields", () => {
    const text = serializeProject(makeFile());
    expect(text).not.toMatch(/apiKey|api_key|password|credential|Bearer/i);
    expect(JSON.parse(text)).toMatchObject({ format: "ltw-project", schemaVersion: 2 });
  });

  it("rejects things that are not projects, with plain messages", () => {
    expect(errorOf("not json {")).toMatchObject({ code: "not_json" });
    expect(errorOf({ hello: "world" })).toMatchObject({ code: "not_project" });
    expect(errorOf("[]")).toMatchObject({ code: "not_project" });
    expect(errorOf("null")).toMatchObject({ code: "not_project" });
    const newer = { ...makeFile(), schemaVersion: 3 };
    expect(errorOf(newer)).toMatchObject({ code: "newer_schema", message: expect.stringContaining("newer version") });
  });

  it("rejects wrong shapes with details", () => {
    const f = makeFile() as unknown as Record<string, unknown>;
    delete (f["versions"] as { source?: unknown }[])[0]!.source;
    const e = errorOf(f)!;
    expect(e.code).toBe("invalid");
    expect(e.details.join(" ")).toContain("source");
    expect(errorOf({ ...makeFile(), versions: [{ ...makeFile().versions[0]!, backend: "cloud" }] })?.code).toBe("invalid");
    const badState = makeFile();
    (badState.versions[0]!.runs[0]!.outputs[revision.blocks[0]!.id] as { state: string }).state = "done!";
    expect(errorOf(badState)?.code).toBe("invalid");
  });

  describe("detects damage and edits made outside the app", () => {
    const corrupt = (mutate: (f: ProjectFile) => void) => {
      const f = makeFile();
      mutate(f);
      return errorOf(f);
    };
    const out = (f: ProjectFile, i = 0) => f.versions[0]!.runs[0]!.outputs[revision.blocks[i]!.id]!;

    it("source text no longer matches its hash", () => {
      expect(corrupt((f) => (f.versions[0]!.source.exactText = f.versions[0]!.source.exactText.replace("二", "2")))).toMatchObject({ code: "corrupt" });
    });
    it("a block's text no longer matches its hash", () => {
      expect(corrupt((f) => (f.versions[0]!.source.blocks[1]!.textHash = "0".repeat(64)))?.details.join(" ")).toMatch(/hash/);
    });
    it("a result slot is missing, extra, or points at another block", () => {
      expect(corrupt((f) => delete f.versions[0]!.runs[0]!.outputs[revision.blocks[2]!.id])?.message).toMatch(/one result slot per source block/);
      expect(corrupt((f) => (f.versions[0]!.runs[0]!.outputs["ghost"] = { ...pendingOutput(0), blockId: "ghost" }))?.code).toBe("corrupt");
      expect(corrupt((f) => (out(f).blockId = "other"))?.code).toBe("corrupt");
    });
    it("references to missing versions or attempts", () => {
      expect(corrupt((f) => (out(f).currentVersionId = "nope"))?.message).toMatch(/current text is missing/);
      expect(corrupt((f) => (out(f).versions[0]!.attemptId = "nope"))?.message).toMatch(/missing attempt/);
      expect(corrupt((f) => (out(f).candidate = { attemptId: "a0", versionId: "nope" }))?.message).toMatch(/pending new version/);
    });
    it("duplicate ids and out-of-order attempts", () => {
      expect(corrupt((f) => out(f).versions.push({ ...out(f).versions[0]! }))?.details.join(" ")).toMatch(/duplicate version/);
      expect(corrupt((f) => (out(f).attempts[0]!.ordinal = 5))?.details.join(" ")).toMatch(/out of order/);
    });
    it("a result made for different source text", () => {
      expect(corrupt((f) => (out(f).attempts[0]!.sourceHash = "different"))?.message).toMatch(/different source text/);
    });
    it("a model that belongs to another source version", () => {
      expect(corrupt((f) => (f.versions[0]!.runs[0]!.revisionId = "other"))?.message).toMatch(/different source version/);
    });
    it("reports the first problem in the message and keeps a list for diagnostics", () => {
      const e = corrupt((f) => {
        f.versions[0]!.source.blocks[0]!.textHash = "x";
        out(f).currentVersionId = "nope";
      })!;
      expect(e.details.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("settleLoadedRun", () => {
  it("turns in-progress work into interrupted and keeps partial text", () => {
    const run = makeRun();
    const out = run.outputs[revision.blocks[2]!.id]!;
    out.state = "running";
    out.attempts.push({ id: "a2", ordinal: 1, configHash: "c", sourceHash: revision.blocks[2]!.textHash, contextHash: "x", state: "running", draft: "partial" });
    run.state = "running";
    const settled = settleLoadedRun(run);
    const o = settled.outputs[revision.blocks[2]!.id]!;
    expect(o.state).toBe("pending");
    expect(o.attempts[0]).toMatchObject({ state: "interrupted", draft: "partial" });
    expect(settled.state).toBe("interrupted");
    expect(settled.outputs[revision.blocks[0]!.id]!.state).toBe("succeeded");
    expect(run.outputs[revision.blocks[2]!.id]!.state).toBe("running"); // original untouched
  });

  it("a retry that was running keeps the earlier result as current", () => {
    const run = makeRun();
    const out = run.outputs[revision.blocks[0]!.id]!;
    out.state = "running";
    out.attempts.push({ id: "a0b", ordinal: 2, configHash: "c", sourceHash: revision.blocks[0]!.textHash, contextHash: "x", state: "running", draft: "new" });
    const o = settleLoadedRun(run).outputs[revision.blocks[0]!.id]!;
    expect(o.state).toBe("succeeded");
    expect(o.currentVersionId).toBe("v0");
    expect(o.attempts[1]!.state).toBe("interrupted");
  });

  it("waiting blocks go back to pending, finished and failed ones are untouched", () => {
    const run = makeRun();
    run.outputs[revision.blocks[2]!.id]!.state = "waiting";
    run.outputs[revision.blocks[1]!.id]!.state = "failed";
    run.state = "waiting";
    const s = settleLoadedRun(run);
    expect(s.outputs[revision.blocks[2]!.id]!.state).toBe("pending");
    expect(s.outputs[revision.blocks[1]!.id]!.state).toBe("failed");
    expect(s.state).toBe("interrupted");
  });

  it("a finished run stays finished", () => {
    const run = makeRun();
    run.outputs[revision.blocks[2]!.id] = doneOutput(2, "Three.");
    run.state = "completed";
    expect(settleLoadedRun(run).state).toBe("completed");
  });
});

describe("versions and files from the first release", () => {
  const v1Text = () => {
    const f = makeFile();
    const v = f.versions[0]!;
    const { versions: _versions, ...rest } = f as unknown as Record<string, unknown>;
    return JSON.stringify({ ...rest, schemaVersion: 1, backend: v.backend, source: v.source, runs: v.runs });
  };

  it("opens a file saved by the first release and turns it into one version", () => {
    const r = parseProject(v1Text());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.schemaVersion).toBe(2);
    expect(r.file.versions).toHaveLength(1);
    expect(r.file.versions[0]!.runs[0]!.label).toBe("qwen");
    expect(r.file.versions[0]!.source.exactText).toBe(revision.exactText);
  });

  it("still checks an old file thoroughly", () => {
    const f = JSON.parse(v1Text());
    f.source.exactText = f.source.exactText.replace("二", "2");
    expect(parseProject(JSON.stringify(f))).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(parseProject(JSON.stringify({ ...f, source: undefined }))).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("holds several versions of the text, each with its own results", () => {
    const second = createRevision({ text: "新しい本文です。", sourceLanguage: "Japanese", targetLanguage: "English", parentId: revision.id });
    const f = makeFile();
    f.versions.push({
      source: second,
      backend: "practice",
      runs: [{ ...makeRun(), id: "run2", revisionId: second.id, outputs: Object.fromEntries(second.blocks.map((b) => [b.id, { blockId: b.id, state: "pending" as const, attempts: [], versions: [] }])) }],
    });
    const r = load(f);
    expect(r.ok).toBe(true);
    expect(r.ok && r.file.versions.map((v) => v.source.id)).toEqual([revision.id, second.id]);
  });

  it("rejects ids that are shared between versions", () => {
    const f = makeFile();
    f.versions.push(structuredClone(f.versions[0]!));
    const e = errorOf(f)!;
    expect(e.code).toBe("corrupt");
    expect(e.details.join(" ")).toMatch(/used more than once/);
  });

  it("requires at least one version", () => {
    expect(errorOf({ ...makeFile(), versions: [] })?.code).toBe("invalid");
  });
});
