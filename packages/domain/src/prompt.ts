import { contextAllowance, modelBudget } from "./budget.js";
import { DEFAULTS } from "./defaults.js";
import { GLOSSARY_LABEL, NOTES_LABEL, WORD_NOTES_LABEL } from "./labels.js";
import { glossaryLines, wordNoteLines, relevantEntries, targetVariants } from "./glossary.js";
import { backupMaterial, fitMaterial, knowledgeReserve, type BlockMaterial } from "./knowledge.js";
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
      glossary: run.glossary.map((g) => (g.note ? [g.source, g.target, g.note] : [g.source, g.target])),
      ...(run.notes?.trim() ? { notes: run.notes.trim() } : {}),
    }),
  );
}

const SOURCE_LABEL = "SOURCE_BLOCK:";

const SUMMARY_LABEL = "STORY SO FAR (a summary of the whole chapter; reference only, do not translate):";
const SCENE_LABEL = "SCENE (what is happening around this block; reference only, do not translate):";

const CONTEXT_LABEL = "CONTEXT (reference only, do not translate):";
const UNAVAILABLE = "(not available)";

/**
 * The request for one block, as plain labelled text. It deliberately does not look like a data structure,
 * because some models write structured input back out instead of translating it. The text to translate is last,
 * so the natural continuation is its translation.
 */
export function renderUserMessage(glossary: { source: string; target: string; note?: string; aliases?: string[] | undefined }[], context: RequestContext, sourceText: string, notes: readonly string[] = [], extras: { summary?: string | undefined; scene?: string | undefined } = {}): string {
  const parts: string[] = [];
  if (extras.summary) parts.push(`${SUMMARY_LABEL}\n${extras.summary}`);
  if (extras.scene) parts.push(`${SCENE_LABEL}\n${extras.scene}`);
  if (notes.length > 0) parts.push(`${NOTES_LABEL}\n${notes.map((n) => `- ${n}`).join("\n")}`);
  const lines = glossaryLines(glossary);
  if (lines.length > 0) parts.push(`${GLOSSARY_LABEL}\n${lines.join("\n")}`);
  const wordNotes = wordNoteLines(glossary);
  if (wordNotes.length > 0) parts.push(`${WORD_NOTES_LABEL}\n${wordNotes.join("\n")}`);
  if (context.translationStatus === "available" || context.translationStatus === "unavailable") {
    const before = context.source !== null ? `Previous source:\n${context.source}` : "";
    const after = `Previous translation:\n${context.translation ?? UNAVAILABLE}`;
    parts.push(`${CONTEXT_LABEL}\n${[before, after].filter(Boolean).join("\n")}`);
  }
  parts.push(`${SOURCE_LABEL}\n${sourceText}`);
  return parts.join("\n\n");
}

export interface ParsedUserMessage {
  glossary: { source: string; target: string; aliases?: string[] }[];
  /** Absent when the message had no context section. */
  context: { source: string | null; translation: string | null } | null;
  sourceBlock: string;
}

/** Reads a request made by `renderUserMessage` back into its parts. Used by tests and the practice translator. */
export function parseUserMessage(content: string): ParsedUserMessage | null {
  const at = content.lastIndexOf(`${SOURCE_LABEL}\n`);
  if (at < 0) return null;
  const sourceBlock = content.slice(at + SOURCE_LABEL.length + 1);
  const head = content.slice(0, at).replace(/\n\n$/, ""); // exactly the separator, so the translation keeps its own line breaks
  const ctxAt = head.indexOf(CONTEXT_LABEL);
  const glossAt = head.indexOf(GLOSSARY_LABEL);
  const glossary: ParsedUserMessage["glossary"] = [];
  if (glossAt >= 0) {
    const wordAt = head.indexOf(WORD_NOTES_LABEL);
    const end = [ctxAt, wordAt].filter((x) => x > glossAt).sort((a, b) => a - b)[0] ?? head.length;
    for (const line of head.slice(glossAt + GLOSSARY_LABEL.length, end).split("\n")) {
      const m = /^- (.+?) => (.+?)(?: \(or .*\))?(?: — .*)?$/.exec(line.trim());
      if (m) {
        const [source = m[1]!, ...aliases] = m[1]!.split(" / ");
        glossary.push({ source, target: m[2]!, ...(aliases.length > 0 ? { aliases } : {}) });
      }
    }
  }
  let context: ParsedUserMessage["context"] = null;
  if (ctxAt >= 0) {
    const body = head.slice(ctxAt + CONTEXT_LABEL.length).replace(/^\n/, "");
    const t = body.indexOf("Previous translation:\n");
    const srcPart = t >= 0 ? body.slice(0, t) : body;
    const source = srcPart.startsWith("Previous source:\n") ? srcPart.slice("Previous source:\n".length).replace(/\n$/, "") : null;
    const translation = t >= 0 ? body.slice(t + "Previous translation:\n".length) : null;
    context = { source, translation: translation === UNAVAILABLE ? null : translation };
  }
  return { glossary, context, sourceBlock };
}

/** The system message a model run sends: its translation style with the languages filled in. */
export function systemPromptFor(run: Pick<ModelRun, "prompt">, sourceLanguage: string, targetLanguage: string): string {
  return renderPrompt(run.prompt ?? STANDARD_PROMPT, sourceLanguage, targetLanguage);
}

export function buildPrompt(
  revision: SourceRevision,
  blockIndex: number,
  run: ModelRun,
  previousOutput: BlockOutput | undefined,
  /** The background chosen for this block. Without it, a keyword match over the project's terms is used as a backup. */
  material?: BlockMaterial,
): BuiltPrompt {
  const block = revision.blocks[blockIndex]!;
  const system = systemPromptFor(run, revision.sourceLanguage, revision.targetLanguage);
  // Set aside room for knowledge (terms, hints, notes). Each request carries only what applies to its own block.
  const budget = modelBudget(runBudgetInput(run, estimateTokens(system), knowledgeReserve(run.glossary, run.notes ?? "", run.config.contextLimit, run.knowledge === true)));

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
  const reserve = knowledgeReserve(run.glossary, run.notes ?? "", run.config.contextLimit, run.knowledge === true);
  const kb = fitMaterial(material ?? backupMaterial(run.glossary, run.notes ?? "", text), reserve);
  const glossary = kb.glossary.map((g) => ({ source: g.source, target: g.target, ...(g.note ? { note: g.note } : {}), ...(g.aliases ? { aliases: g.aliases } : {}) }));
  const user = renderUserMessage(glossary, context, text, kb.notes, { summary: kb.summary, scene: kb.scene });
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
export function blockSettingsHash(revision: SourceRevision, blockIndex: number, run: Pick<ModelRun, "modelId" | "config" | "prompt" | "glossary" | "notes">, material?: BlockMaterial): string {
  const text = blockText(revision, revision.blocks[blockIndex]!);
  const chosen = material ?? backupMaterial(run.glossary, run.notes ?? "", text);
  const glossary = chosen.glossary.map((g) => [g.source, g.target, ...(g.note ? [g.note] : []), ...(g.aliases && g.aliases.length > 0 ? [g.aliases.join("/")] : [])]);
  const notes = chosen.notes;
  return sha256Hex(
    JSON.stringify({
      m: run.modelId,
      t: run.config.temperature,
      p: run.prompt ? sha256Hex(`${run.prompt.appendFraming}\n${run.prompt.template}`) : "standard-v1",
      g: glossary,
      ...(notes.length > 0 ? { n: notes } : {}),
      ...(chosen.scene ? { sc: chosen.scene } : {}),
      ...(chosen.summary ? { su: chosen.summary } : {}),
    }),
  );
}

/** Shortcut used by the coordinator to compare "context now" with "context the attempt used". */
export const contextHashFor = (revision: SourceRevision, blockIndex: number, run: ModelRun, previousOutput: BlockOutput | undefined): string =>
  buildPrompt(revision, blockIndex, run, previousOutput).contextHash;

