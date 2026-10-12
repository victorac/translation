import { describe, expect, it } from "vitest";
import { contextAllowance, modelBudget, planChunking, preflightRevision, safetyMargin, type ModelBudgetInput } from "./budget.js";
import { createRevision } from "./revision.js";

const model = (over: Partial<ModelBudgetInput> = {}): ModelBudgetInput => ({
  label: "m",
  contextLimit: 4096,
  outputReserve: 1536,
  systemTokens: 100,
  glossaryTokens: 0,
  ...over,
});

describe("budgets", () => {
  it("uses max(256, 10%) as safety margin", () => {
    expect(safetyMargin(2048)).toBe(256);
    expect(safetyMargin(4096)).toBe(410);
    expect(safetyMargin(32768)).toBe(3277);
  });

  it("computes the default 4096-context budget", () => {
    const b = modelBudget(model());
    expect(b).toMatchObject({ safetyMargin: 410, fixedTokens: 2110, room: 1986, contextReserve: 496, sourceBudget: 1490, fits: true });
  });

  it("plans the standard 600/900 blocks when every model has room", () => {
    const p = planChunking([model({ label: "a" }), model({ label: "b", contextLimit: 8192 })]);
    expect(p).toMatchObject({ ok: true, targetTokens: 600, maxTokens: 900 });
  });

  it("lets the smallest model set the shared block size", () => {
    const p = planChunking([model({ label: "big", contextLimit: 8192 }), model({ label: "small", contextLimit: 2048 })]);
    expect(p.ok).toBe(true);
    expect(p.limitingModel).toBe("small");
    expect(p.maxTokens).toBe(69);
    expect(p.targetTokens).toBe(69);
  });

  it("fails preflight when the fixed prompt alone cannot fit, and says how to fix it", () => {
    const p = planChunking([model({ label: "tiny", contextLimit: 2048, outputReserve: 1800 })]);
    expect(p.ok).toBe(false);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({ code: "fixed_prompt_too_large", model: "tiny" });
    expect(p.issues[0]!.message).toMatch(/glossary|output cap|context/i);
  });

  it("a long glossary eats block budget, then fails", () => {
    expect(modelBudget(model({ glossaryTokens: 1000 })).sourceBudget).toBeLessThan(modelBudget(model()).sourceBudget);
    expect(modelBudget(model({ glossaryTokens: 3000 })).fits).toBe(false);
  });

  it("shrinks optional context before anything else", () => {
    const b = modelBudget(model());
    expect(contextAllowance(b, 600)).toBe(512);
    expect(contextAllowance(b, 1700)).toBe(286);
    expect(contextAllowance(b, 5000)).toBe(0);
  });

  it("preflights an existing snapshot against a newly added smaller model", () => {
    const rev = createRevision({ text: "あ".repeat(800), sourceLanguage: "ja", targetLanguage: "en" });
    expect(preflightRevision(rev, [model()])).toEqual([]);
    const issues = preflightRevision(rev, [model({ label: "small", contextLimit: 2048 })]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({ code: "block_exceeds_budget", model: "small", blockIndex: 0 });
  });
});
