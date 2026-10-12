import { DEFAULTS } from "./defaults.js";
import type { SourceRevision } from "./revision.js";

/** What the budget needs to know about one model run (spec 04, "Chunking and budgets" item 4). */
export interface ModelBudgetInput {
  label: string;
  contextLimit: number;
  outputReserve: number;
  /** Estimated tokens of the rendered system prompt. */
  systemTokens: number;
  /** Estimated tokens of the serialized glossary for this run. */
  glossaryTokens: number;
}

export interface ModelBudget {
  label: string;
  safetyMargin: number;
  /** system + glossary + overhead + outputReserve + safetyMargin */
  fixedTokens: number;
  /** contextLimit - fixedTokens; what is left for context and the wrapped block. */
  room: number;
  /** Tokens set aside for optional context when choosing the shared block size. */
  contextReserve: number;
  /** Largest block this model can take while keeping its context reserve. */
  sourceBudget: number;
  /** False when the fixed prompt/glossary/output reserve alone cannot fit. */
  fits: boolean;
}

export const safetyMargin = (contextLimit: number): number =>
  Math.max(DEFAULTS.safetyMarginMinTokens, Math.ceil(contextLimit * DEFAULTS.safetyMarginFraction));

export function modelBudget(m: ModelBudgetInput): ModelBudget {
  const margin = safetyMargin(m.contextLimit);
  const fixedTokens = m.systemTokens + m.glossaryTokens + DEFAULTS.messageOverheadTokens + m.outputReserve + margin;
  const room = m.contextLimit - fixedTokens;
  // Optional context is the first thing to give way: at most a quarter of the room, capped at both tails.
  const contextReserve = Math.max(0, Math.min(2 * DEFAULTS.contextTailTokens, Math.floor(room / 4)));
  const sourceBudget = Math.max(0, room - contextReserve);
  return { label: m.label, safetyMargin: margin, fixedTokens, room, contextReserve, sourceBudget, fits: sourceBudget >= 1 };
}

/** Context tokens one block may carry for a model: shrinks first, down to zero, before anything else fails. */
export function contextAllowance(b: ModelBudget, blockTokens: number): number {
  return Math.max(0, Math.min(2 * DEFAULTS.contextTailTokens, b.room - blockTokens));
}

export type BudgetIssue =
  | { code: "fixed_prompt_too_large"; model: string; message: string }
  | { code: "block_exceeds_budget"; model: string; blockId: string; blockIndex: number; message: string };

export interface ChunkPlan {
  ok: boolean;
  targetTokens: number;
  maxTokens: number;
  /** Label of the model with the smallest budget, which sets the shared block size. */
  limitingModel?: string;
  budgets: ModelBudget[];
  issues: BudgetIssue[];
}

/**
 * Shared block size for all selected models. Blocks must be identical across models, so the
 * smallest source budget wins. If any model cannot fit its fixed prompt, nothing is chunked
 * for it behind the user's back: the plan reports the problem and the user fixes the config.
 */
export function planChunking(models: ModelBudgetInput[], limits: { targetTokens: number; maxTokens: number } = { targetTokens: DEFAULTS.targetBlockTokens, maxTokens: DEFAULTS.maxBlockTokens }): ChunkPlan {
  const budgets = models.map(modelBudget);
  const issues: BudgetIssue[] = budgets
    .filter((b) => !b.fits)
    .map((b) => ({
      code: "fixed_prompt_too_large" as const,
      model: b.label,
      message: `${b.label}: prompt, glossary, output reserve and safety margin need ${b.fixedTokens} of ${b.fixedTokens + b.room} tokens. Shorten the glossary, lower the output cap, or raise the confirmed context.`,
    }));
  const ok = issues.length === 0;
  const fitting = budgets.filter((b) => b.fits);
  const smallest = fitting.reduce<ModelBudget | undefined>((a, b) => (a && a.sourceBudget <= b.sourceBudget ? a : b), undefined);
  const maxTokens = Math.max(1, Math.min(limits.maxTokens, smallest?.sourceBudget ?? limits.maxTokens));
  const targetTokens = Math.min(limits.targetTokens, maxTokens);
  return { ok, targetTokens, maxTokens, ...(smallest ? { limitingModel: smallest.label } : {}), budgets, issues };
}

/** Checks an existing snapshot against models, e.g. a smaller model added after the revision was made. */
export function preflightRevision(rev: SourceRevision, models: ModelBudgetInput[]): BudgetIssue[] {
  const issues: BudgetIssue[] = [];
  for (const b of models.map(modelBudget)) {
    if (!b.fits) {
      issues.push({ code: "fixed_prompt_too_large", model: b.label, message: `${b.label}: fixed prompt does not fit its context.` });
      continue;
    }
    for (const blk of rev.blocks) {
      if (blk.estimatedTokens > b.room) {
        issues.push({
          code: "block_exceeds_budget",
          model: b.label,
          blockId: blk.id,
          blockIndex: blk.index,
          message: `${b.label}: block ${blk.index + 1} (~${blk.estimatedTokens} tokens) exceeds the ${b.room} tokens available. Re-chunk into a new revision, raise the confirmed context, or shorten the glossary.`,
        });
      }
    }
  }
  return issues;
}
