import { describe, expect, it } from "vitest";
import { buildExport, safeFileName, type ExportOptions } from "./export.js";
import { createRevision } from "./revision.js";
import type { BlockOutput, ModelRun } from "./state.js";

const SOURCE = "「やっぱり」\n彼女は笑った。\n\n二つ目の段落。\n\n三つ目、\"引用\"と,カンマ。";
const revision = createRevision({ text: SOURCE, sourceLanguage: "Japanese", targetLanguage: "English", targetTokens: 14, maxTokens: 16 });

const done = (i: number, text: string, extra: Partial<BlockOutput> = {}): BlockOutput => {
  const b = revision.blocks[i]!;
  return {
    blockId: b.id,
    state: "succeeded",
    attempts: [{ id: `a${i}`, ordinal: 1, configHash: "c", sourceHash: b.textHash, contextHash: "x", state: "succeeded" }],
    versions: [{ id: `v${i}`, blockId: b.id, attemptId: `a${i}`, kind: "generated", text, createdAt: "t" }],
    currentVersionId: `v${i}`,
    ...extra,
  };
};
const none = (i: number, state: BlockOutput["state"] = "pending"): BlockOutput => ({ blockId: revision.blocks[i]!.id, state, attempts: [], versions: [] });

const run = (id: string, label: string, outputs: BlockOutput[]): ModelRun => ({
  id,
  revisionId: revision.id,
  providerRefId: "p",
  modelId: label,
  label,
  config: { temperature: 0.2, maxOutputTokens: 1536, contextLimit: 4096 },
  promptVersion: "v1",
  glossary: [],
  state: "completed",
  archived: false,
  outputs: Object.fromEntries(outputs.map((o) => [o.blockId, o])),
});

const N = revision.blocks.length;
const full = (id: string, label: string, prefix = "") => run(id, label, revision.blocks.map((_, i) => done(i, `${prefix}Translation ${i + 1}.`)));
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ format: "text", runIds: ["r1"], textVersion: "current", allowPartial: false, title: "My Novel", now: new Date("2026-10-12T10:00:00Z"), ...o });

/** A small independent RFC 4180 reader, to check the CSV really reads back. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"', i++);
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\r" && text[i + 1] === "\n") (row.push(field), rows.push(row), (row = []), (field = ""), i++);
    else field += c;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  return rows;
}

describe("plain text", () => {
  it("joins the blocks in source order and keeps the source's paragraph breaks", () => {
    const { content, preview } = buildExport(revision, [full("r1", "m")], opts());
    expect(preview.complete).toBe(true);
    const texts = revision.blocks.map((_, i) => `Translation ${i + 1}.`);
    expect(content).toBe(texts.map((t, i) => (i < N - 1 ? t + (/\n+$/.exec(revision.exactText.slice(revision.blocks[i]!.startOffset, revision.blocks[i]!.endOffset))?.[0] ?? "\n") : t)).join(""));
    expect(content!.endsWith("\n")).toBe(false);
    expect(content!.includes("\r")).toBe(false);
  });

  it("does not double a newline the translation already ends with", () => {
    const r = run("r1", "m", revision.blocks.map((_, i) => done(i, `T${i}.\n\n`)));
    expect(buildExport(revision, [r], opts()).content).toBe(revision.blocks.map((_, i) => `T${i}.\n\n`).join(""));
  });

  it("holds one model only, with a plain explanation", () => {
    const { preview, content } = buildExport(revision, [full("r1", "a"), full("r2", "b")], opts({ runIds: ["r1", "r2"] }));
    expect(content).toBeNull();
    expect(preview.problem).toMatch(/one model at a time/);
  });

  it("names the file after the project and model, safely", () => {
    expect(buildExport(revision, [full("r1", "qwen/qwen3.5-9b")], opts({ title: 'a:b*"c"' })).preview.fileName).toBe("a-b-c - qwen-qwen3.5-9b.txt");
    expect(safeFileName("  ..bad/name?.  ")).toBe("bad-name");
    expect(safeFileName("???")).toBe("translation");
    expect(safeFileName("")).toBe("translation");
    expect(safeFileName("x".repeat(200))).toHaveLength(80);
  });
});

describe("missing, failed and stale blocks", () => {
  const partial = (): ModelRun => run("r1", "m", [done(0, "One."), none(1, "failed"), none(2)].slice(0, N));

  it("lists gaps in the preview and refuses to write unless a partial export is allowed", () => {
    const r = partial();
    const { preview, content } = buildExport(revision, [r], opts());
    expect(content).toBeNull();
    expect(preview.complete).toBe(false);
    expect(preview.gaps.map((g) => [g.blockNumber, g.status])).toEqual([[2, "Failed"], [3, "Not translated yet"]].slice(0, N - 1));
    expect(preview.models[0]).toMatchObject({ included: 1, missing: N - 1 });
  });

  it("with Export partial, marks every gap in place, in order", () => {
    const { content, preview } = buildExport(revision, [partial()], opts({ allowPartial: true }));
    expect(content).toContain("One.");
    expect(content).toContain("[Block 2 missing: Failed]");
    expect(content!.indexOf("One.")).toBeLessThan(content!.indexOf("[Block 2 missing"));
    expect(preview.complete).toBe(false);
  });

  it("includes out-of-date and needs-review text but flags it", () => {
    const outs = revision.blocks.map((_, i) => done(i, `T${i + 1}`));
    outs[1] = done(1, "Stale one", { state: "stale", staleReason: "context_changed" });
    outs[2] = done(2, "Cut off", { state: "needs_review" });
    const { preview, content } = buildExport(revision, [run("r1", "m", outs)], opts());
    expect(content).toContain("Stale one");
    expect(content).toContain("Cut off");
    expect(preview.gaps).toEqual([]);
    expect(preview.warnings.map((w) => [w.blockNumber, w.status])).toEqual([[2, "Out of date"], [3, "Needs review"]]);
    expect(preview.models[0]).toMatchObject({ outOfDate: 1, needsReview: 1 });
  });

  it("a failed retry keeps exporting the earlier result", () => {
    const outs = revision.blocks.map((_, i) => done(i, `T${i + 1}`));
    outs[0] = done(0, "Earlier result", { state: "failed" });
    const { preview, content } = buildExport(revision, [run("r1", "m", outs)], opts());
    expect(content).toContain("Earlier result");
    expect(preview.complete).toBe(true);
  });

  it("notes a newer version that was never chosen, and exports the current one", () => {
    const outs = revision.blocks.map((_, i) => done(i, `T${i + 1}`));
    outs[0]!.versions.push({ id: "vc", blockId: outs[0]!.blockId, attemptId: "a0", kind: "generated", text: "Candidate", createdAt: "t" });
    outs[0]!.candidate = { attemptId: "a0", versionId: "vc" };
    const { preview, content } = buildExport(revision, [run("r1", "m", outs)], opts());
    expect(content).toContain("T1");
    expect(content).not.toContain("Candidate");
    expect(preview.warnings[0]).toMatchObject({ blockNumber: 1, status: expect.stringContaining("newer version") });
  });
});

describe("your edits versus the model's text", () => {
  const withEdit = () => {
    const outs = revision.blocks.map((_, i) => done(i, `Model ${i + 1}`));
    outs[0]!.versions.push({ id: "vm", blockId: outs[0]!.blockId, kind: "manual", text: "My wording", createdAt: "t", baseVersionId: "v0" });
    outs[0]!.currentVersionId = "vm";
    return run("r1", "m", outs);
  };

  it("exports your edit by default and the model's own text on request; the preview says how many differ", () => {
    const cur = buildExport(revision, [withEdit()], opts());
    const orig = buildExport(revision, [withEdit()], opts({ textVersion: "original" }));
    expect(cur.content!.startsWith("My wording")).toBe(true);
    expect(orig.content!.startsWith("Model 1")).toBe(true);
    expect(cur.preview.models[0]!.edited).toBe(1);
    expect(cur.content).not.toBe(orig.content);
  });

  it("follows a chain of edits back to the original", () => {
    const r = withEdit();
    const o = r.outputs[revision.blocks[0]!.id]!;
    o.versions.push({ id: "vm2", blockId: o.blockId, kind: "manual", text: "Even better", createdAt: "t", baseVersionId: "vm" });
    o.currentVersionId = "vm2";
    expect(buildExport(revision, [r], opts({ textVersion: "original" })).content!.startsWith("Model 1")).toBe(true);
    expect(buildExport(revision, [r], opts()).content!.startsWith("Even better")).toBe(true);
  });

  it("marks edited blocks in the CSV status", () => {
    const { content } = buildExport(revision, [withEdit()], opts({ format: "csv" }));
    expect(parseCsv(content!.slice(1))[1]![3]).toBe("Done (edited by you)");
  });
});

describe("markdown", () => {
  it("has a title, the languages and one labelled section per model", () => {
    const { content } = buildExport(revision, [full("r1", "alpha"), full("r2", "beta", "B: ")], opts({ format: "markdown", runIds: ["r1", "r2"] }));
    expect(content).toMatch(/^# My Novel\n\n\*Japanese → English · exported 2026-10-12\*\n/);
    expect(content!.indexOf("## alpha")).toBeLessThan(content!.indexOf("## beta"));
    expect(content).toContain("B: Translation 1.");
    expect(content!.endsWith("\n")).toBe(true);
  });

  it("marks gaps in italics and allows a single model too", () => {
    const part = run("r1", "alpha", [done(0, "One."), none(1)].slice(0, N));
    const { content, preview } = buildExport(revision, [part], opts({ format: "markdown", allowPartial: true }));
    expect(content).toContain("*[Block 2 missing: Not translated yet]*");
    expect(preview.fileName).toBe("My Novel.md");
  });
});

describe("comparison CSV (AC-14)", () => {
  it("is RFC 4180: CRLF lines, quoted fields with doubled quotes, newlines and commas inside quotes, byte-order mark", () => {
    const outs = revision.blocks.map((_, i) => done(i, i === 2 ? 'He said "no", then left.\nSecond line.' : `T${i + 1}`));
    const { content, preview } = buildExport(revision, [run("r1", "alpha", outs)], opts({ format: "csv" }));
    expect(content!.startsWith("﻿")).toBe(true);
    expect(content!.endsWith("\r\n")).toBe(true);
    const rows = parseCsv(content!.slice(1));
    expect(rows[0]).toEqual(["Block", "Source (Japanese)", "alpha", "alpha status"]);
    expect(rows).toHaveLength(N + 1);
    expect(rows[3]![2]).toBe('He said "no", then left.\nSecond line.');
    expect(rows[3]![1]).toBe(revision.exactText.slice(revision.blocks[2]!.startOffset, revision.blocks[2]!.endOffset));
    expect(rows.every((r) => r.length === 4)).toBe(true);
    expect(preview.fileName).toBe("My Novel - comparison.csv");
  });

  it("keeps source order, Unicode and one pair of columns per model, with status text for missing blocks", () => {
    const a = full("r1", "alpha");
    const b = run("r2", "beta", [done(0, "B1 👍🏽"), none(1, "failed"), none(2, "canceled")].slice(0, N));
    const { content } = buildExport(revision, [a, b], opts({ format: "csv", runIds: ["r1", "r2"], allowPartial: true }));
    const rows = parseCsv(content!.slice(1));
    expect(rows[0]).toEqual(["Block", "Source (Japanese)", "alpha", "alpha status", "beta", "beta status"]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(revision.blocks.map((_, i) => String(i + 1)));
    expect(rows[1]![4]).toBe("B1 👍🏽");
    expect(rows[2]!.slice(4)).toEqual(["", "Failed"]);
    expect(rows[1]![1]).toContain("やっぱり");
    expect(rows[1]![3]).toBe("Done");
  });

  it("refuses a CSV with gaps unless a partial export is allowed", () => {
    const b = run("r2", "beta", [done(0, "B1")]);
    expect(buildExport(revision, [b], opts({ format: "csv", runIds: ["r2"] })).content).toBeNull();
    expect(buildExport(revision, [b], opts({ format: "csv", runIds: ["r2"], allowPartial: true })).content).not.toBeNull();
  });

  it("protects against spreadsheet formulas by default, and can be turned off", () => {
    const outs = revision.blocks.map((_, i) => done(i, i === 0 ? "=SUM(A1:A9)" : i === 1 ? "- a dash line" : "fine"));
    const safe = parseCsv(buildExport(revision, [run("r1", "m", outs)], opts({ format: "csv" })).content!.slice(1));
    expect(safe[1]![2]).toBe("'=SUM(A1:A9)");
    expect(safe[2]![2]).toBe("'- a dash line");
    expect(safe[3]![2]).toBe("fine");
    const raw = parseCsv(buildExport(revision, [run("r1", "m", outs)], opts({ format: "csv", formulaSafe: false })).content!.slice(1));
    expect(raw[1]![2]).toBe("=SUM(A1:A9)");
  });
});

describe("general rules", () => {
  it("asks for at least one known model", () => {
    expect(buildExport(revision, [full("r1", "m")], opts({ runIds: [] })).preview.problem).toMatch(/at least one model/);
    expect(buildExport(revision, [full("r1", "m")], opts({ runIds: ["ghost"] })).preview.problem).toMatch(/not part of this project/);
  });

  it("never changes the results it reads", () => {
    const runs = [full("r1", "alpha"), run("r2", "beta", [done(0, "x")])];
    const before = structuredClone(runs);
    for (const format of ["text", "markdown", "csv"] as const) buildExport(revision, runs, opts({ format, runIds: ["r1"], allowPartial: true }));
    buildExport(revision, runs, opts({ format: "csv", runIds: ["r1", "r2"], allowPartial: true }));
    expect(runs).toEqual(before);
  });

  it("gives a preview with an excerpt and the exact size in bytes", () => {
    const { preview, content } = buildExport(revision, [full("r1", "m")], opts());
    expect(preview.excerpt).toBe(content!.slice(0, 600));
    expect(preview.bytes).toBe(new TextEncoder().encode(content!).length);
    const blocked = buildExport(revision, [run("r1", "m", [done(0, "x")])], opts()).preview;
    expect(blocked).toMatchObject({ excerpt: "", bytes: 0 });
  });
});
