import { contextAllowance, modelBudget } from "./budget.js";
import { DEFAULTS } from "./defaults.js";
import { relevantEntries } from "./glossary.js";
import { renderPrompt, STANDARD_PROMPT } from "./prompts.js";
import { sha256Hex } from "./platform.js";
import { blockText, type SourceRevision } from "./revision.js";
import { runBudgetInput, usableText, type BlockOutput, type ModelRun } from "./state.js";
import { estimateTokens } from "./tokens.js";

/**
 * Reference material sent along with a block so names and tone stay consistent.
 * `translationStatus` says why `translation` may be empty:
 *  - none: this is the first block, so there is nothing before it
 *  - available: the previous block has an accepted translation
 *  - unavailable: the previous block failed, was canceled, is stale or needs review
 *  - omitted: the model's context window left no room for context
 */
export interface RequestContext {
  source: string | null;
  translation: string | null;
  translationStatus: "none" | "available" | "unavailable" | "omitted";
}

const tail = (text: string, tokens: number): string => Array.from(text).slice(-tokens).join("");

/**
 * What context the block at `blockIndex` would receive right now. This is a pure function of the
 * source, the previous block's accepted text and the room available, so the same inputs always give
 * the same context hash. Staleness checks depend on that.
 */
export function computeContext(
  revision: SourceRevision,
  blockIndex: number,
  previousOutput: BlockOutput | undefined,
  allowanceTokens: number,
): RequestContext {
  if (blockIndex === 0) return { source: null, translation: null, translationStatus: "none" };
  const each = Math.min(DEFAULTS.contextTailTokens, Math.floor(allowanceTokens / 2));
  if (each < 1) return { source: null, translation: null, translationStatus: "omitted" };
  const prevBlock = revision.blocks[blockIndex - 1]!;
  const prevTranslation = usableText(previousOutput);
  return {
    source: tail(blockText(revision, prevBlock), each),
    translation: prevTranslation === null ? null : tail(prevTranslation, each),
    translationStatus: prevTranslation === null ? "unavailable" : "available",
  };
}

export interface BuiltPrompt {
  messages: { role: "system" | "user"; content: string }[];
  sourceHash: string;
  contextHash: string;
  configHash: string;
  context: RequestContext;
  /** False when the block cannot fit this model even with no context at all. */
  fits: boolean;
  /** Human-readable reason when `fits` is false. */
  problem?: string;
}

/** Everything that decides how a block is translated, hashed so an attempt records what it used. */
export function configHash(run: ModelRun): string {
  return sha256Hex(
    JSON.stringify({
      modelId: run.modelId,
      temperature: run.config.temperature,
      maxOutputTokens: run.config.maxOutputTokens,
      contextLimit: run.config.contextLimit,
      promptVersion: run.promptVersion,
      prompt: run.prompt ? sha256Hex(`${run.prompt.appendFraming}\n${run.prompt.template}`) : "standard-v1",
      glossary: run.glossary.map((g) => [g.source, g.target]),
    }),
  );
}

/** The system message a model run sends: its translation style with the languages filled in. */
export function systemPromptFor(run: Pick<ModelRun, "prompt">, sourceLanguage: string, targetLanguage: string): string {
  return renderPrompt(run.prompt ?? STANDARD_PROMPT, sourceLanguage, targetLanguage);
}

export function buildPrompt(revision: SourceRevision, blockIndex: number, run: ModelRun, previousOutput: BlockOutput | undefined): BuiltPrompt {
  const block = revision.blocks[blockIndex]!;
  const system = systemPromptFor(run, revision.sourceLanguage, revision.targetLanguage);
  // Budget for the whole glossary (an upper bound); each request only carries the entries it needs.
  const fullGlossary = run.glossary.map((g) => ({ source: g.source, target: g.target, ...(g.note ? { note: g.note } : {}) }));
  const budget = modelBudget(runBudgetInput(run, estimateTokens(system), estimateTokens(JSON.stringify(fullGlossary))));

  const base = { configHash: configHash(run), sourceHash: block.textHash };
  if (!budget.fits || block.estimatedTokens > budget.room) {
    const empty: RequestContext = { source: null, translation: null, translationStatus: "omitted" };
    return {
      messages: [],
      ...base,
      contextHash: sha256Hex(JSON.stringify(empty)),
      context: empty,
      fits: false,
      problem: !budget.fits
        ? `The prompt, glossary and output limit leave no room in a ${run.config.contextLimit}-token context. Shorten the glossary, lower the output limit, or raise the context limit.`
        : `This block (about ${block.estimatedTokens} tokens) does not fit in the ${budget.room} tokens left in a ${run.config.contextLimit}-token context. Rechunk into smaller blocks or raise the context limit.`,
    };
  }

  const context = computeContext(revision, blockIndex, previousOutput, contextAllowance(budget, block.estimatedTokens));
  const text = blockText(revision, block);
  const glossary = relevantEntries(run.glossary, text).map((g) => ({ source: g.source, target: g.target, ...(g.note ? { note: g.note } : {}) }));
  const user = JSON.stringify({
    glossary,
    context: { source: context.source, translation: context.translation, translation_status: context.translationStatus },
    source_block: text,
  });
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...base,
    contextHash: sha256Hex(JSON.stringify(context)),
    context,
    fits: true,
  };
}

/**
 * What a block's translation depends on among the user's settings: the model, temperature, style, and
 * only the glossary entries whose term appears in this block's own text.
 * Comparing this with the value stored on the attempt says whether the settings changed in a way that
 * matters for this block. Reply and context limits are left out because they do not change the wording.
 */
export function blockSettingsHash(revision: SourceRevision, blockIndex: number, run: Pick<ModelRun, "modelId" | "config" | "prompt" | "glossary">): string {
  const text = blockText(revision, revision.blocks[blockIndex]!);
  const glossary = relevantEntries(run.glossary, text).map((g) => [g.source, g.target]);
  return sha256Hex(
    JSON.stringify({
      m: run.modelId,
      t: run.config.temperature,
      p: run.prompt ? sha256Hex(`${run.prompt.appendFraming}\n${run.prompt.template}`) : "standard-v1",
      g: glossary,
    }),
  );
}

/** Shortcut used by the coordinator to compare "context now" with "context the attempt used". */
export const contextHashFor = (revision: SourceRevision, blockIndex: number, run: ModelRun, previousOutput: BlockOutput | undefined): string =>
  buildPrompt(revision, blockIndex, run, previousOutput).contextHash;

