import {
  allPrompts,
  glossaryFor,
  interpretPassage,
  lastLines,
  notesFor,
  renderUserMessage,
  STANDARD_PROMPT,
  type GuidedState,
  type GuidedModelInput,
  type GuidedStartInput,
  type Interpretation,
  type KnownName,
  type NameKind,
  extractBlock,
  type Asker,
  type Question,
  blockText,
  blockMaterial,
  entriesFromLegacy,
  applyChecks,
  applyFile,
  checkKnowledge,
  backlinksOf,
  classLabel,
  DEFAULT_CLASSES_TEXT,
  dropLooseNotes,
  LEGACY_CLASSES_TEXT,
  fileText,
  listFiles,
  newTopic,
  parseClasses,
  resolveName,
  titleOf,
  entriesFromText,
  entriesToConsider,
  fitMaterial,
  knowledgeCap,
  knowledgeReserve,
  mergeScenes,
  mergeSummary,
  buildSummary,
  SUMMARY_DIRECT_TOKENS,
  parseKnowledge,
  parseResearchReply,
  researchBatches,
  researchSystemPrompt,
  researchUserMessage,
  sha256Hex,
  splitEntries,
  updateRecord,
  blockSettingsHash,
  BLOCK_SIZES,
  chunkSource,
  createRevision,
  currentVersion,
  DEFAULTS,
  describeSplit,
  looksLikeEcho,
  estimateTokens,
  newId,
  normalizeGlossary,
  normalizeSource,
  parseUserMessage,
  planChunking,
  preflightRevision,
  producingAttempt,
  renderPrompt,
  RevisionError,
  runLabel,
  snapshotPrompt,
  stripThinking,
  validatePrompt,
  type Backend,
  type AnalyzeInput,
  type AnalyzeResult,
  type BlockCellView,
  type BlockMaterial,
  type MergeScenesInput,
  type MergeScenesResult,
  type SummarizeInput,
  type SummarizeResult,
  type BlockOutput,
  type CancelInput,
  type DemoOptions,
  type DocumentView,
  type EntryInput,
  type EntryQuery,
  type KnowledgeEntry,
  type FileContext,
  type KnowledgeFile,
  type KnowledgeFiles,
  type KnowledgeList,
  type GlossaryEntry,
  type ModelRun,
  type ProjectDocument,
  type ProjectSettings,
  type ProjectVersion,
  type ProjectView,
  type PromptPreset,
  type ResearchInput,
  type ResearchRecord,
  type ResearchResult,
  type SourceRevision,
  type SplitPreview,
  type StartJobInput,
  type SyncSettingsInput,
  type WorkspaceSnapshot,
} from "@ltw/domain";
import {
  FakeProvider,
  OPENAI_COMPATIBLE_KIND,
  ProviderRegistry,
  providerError,
  script,
  type FakeProviderOptions,
  type ProviderConfig,
  type TranslationProvider,
} from "@ltw/providers";
import { Coordinator, type CoordinatorEvent } from "./coordinator.js";
import { findCandidateNames, readNames } from "./analyzer.js";
import { UserError } from "./errors.js";
import { KnowledgeStore } from "./knowledge-store.js";
import type { ProviderService } from "./provider-service.js";

export { UserError };

/** The most a model needs to write when reading a passage for knowledge: a few short lines. */
const ANALYSIS_REPLY_TOKENS = 700;
const SPEED_MS = { fast: 4, normal: 35, slow: 140 } as const;
/** Model runs per version of the text, not counting ones the user removed. */
const MAX_MODELS = 8;

export interface ServiceOptions {
  /** Override the practice translator's speed (tests use 0). */
  speedMs?: number;
  /** The saved connection to a real model server. Without it only the practice translator is available. */
  provider?: ProviderService;
  /** Called after every finished request, before the next is sent. If it throws, translating stops. */
  checkpoint?: () => Promise<void>;
  /** Describes the open project for the window. */
  projectView?: () => ProjectView;
}

/** `view`: only how things are shown changed (nothing to save). */
export type ChangeKind = "state" | "delta" | "view";

const NO_PROJECT: ProjectView = { title: "Untitled", path: null, dirty: false, lastSavedAt: null, recovery: null, openProblem: null, notice: null };
const DEFAULT_DEMO: DemoOptions = { speed: "normal", smallBlocks: false, failBlockOnce: null, firstModelUnloaded: false };

/** One version of the source text and the model runs made from it. */
interface Version {
  id: string;
  number: number;
  revision: SourceRevision;
  backend: Backend;
  runIds: string[];
  createdAt: string;
}

/** One text in the project, with its own versions of the text and the model runs made from them. */
interface Doc {
  id: string;
  title: string;
  createdAt: string;
  /** The text in the editor. */
  draft: string;
  versions: Version[];
  viewId: string | null;
}

const newDoc = (title: string): Doc => ({ id: newId(), title, createdAt: new Date().toISOString(), draft: "", versions: [], viewId: null });

/** The real server connection can change between runs (address, key), so each request looks up the current one. */
class CurrentProvider implements TranslationProvider {
  readonly kind = OPENAI_COMPATIBLE_KIND;
  constructor(private readonly current: () => TranslationProvider) {}
  capabilities(config: ProviderConfig) {
    return this.current().capabilities(config);
  }
  health(config: ProviderConfig, signal: AbortSignal) {
    return this.current().health(config, signal);
  }
  listModels(config: ProviderConfig, signal: AbortSignal) {
    return this.current().listModels(config, signal);
  }
  generate(config: ProviderConfig, request: Parameters<TranslationProvider["generate"]>[1], signal: AbortSignal) {
    return this.current().generate(config, request, signal);
  }
}

interface RunPlan {
  name: string;
  label: string;
  contextLimit: number;
  maxOutputTokens: number;
  temperature: number;
  style: PromptPreset;
  glossary: GlossaryEntry[];
  notes: string;
  /** The project has a knowledge base, so room is kept in requests for what it adds. */
  knowledge: boolean;
}

/**
 * The background side of the app for one open project. It holds every version of the source text,
 * the model runs made from each, and the single job runner that translates one block at a time.
 * Every window action ends up in one of these methods.
 */
export class WorkspaceService {
  private coordinator: Coordinator | null = null;
  private practice: FakeProvider | null = null;
  private practiceOptions: FakeProviderOptions = {};
  private demo: DemoOptions = DEFAULT_DEMO;
  private docs: Doc[] = [newDoc("Document 1")];
  private activeDocId = this.docs[0]!.id;
  /** Changes when a project is opened, restored or started, so the window reloads its choices. */
  private epoch = 0;
  /** The project's shared choices (models, glossary, styles, languages), or null until the window sends them. */
  private settings: ProjectSettings | null = null;
  /** The project's names, hints and notes. Every translation run draws on it. */
  private readonly knowledge = new KnowledgeStore();
  private jobIds: string[] = [];
  private waitingInfo = new Map<string, { code: string; message: string }>();
  private firstModel = "";
  /** The settings the user has chosen right now, by model run name. Retries and Run use these. */
  private currentPlans = new Map<string, RunPlan>();
  /** Per model run: the blocks translated with settings that have since changed. */
  private outdated = new Map<string, Set<string>>();
  private listeners = new Set<(kind: ChangeKind) => void>();

  constructor(private readonly options: ServiceOptions = {}) {}

  /** The open document. */
  private get doc(): Doc {
    return this.docs.find((d) => d.id === this.activeDocId) ?? this.docs[0]!;
  }
  private get versions(): Version[] {
    return this.doc.versions;
  }
  private get viewId(): string | null {
    return this.doc.viewId;
  }
  private set viewId(id: string | null) {
    this.doc.viewId = id;
  }
  private allVersions(): Version[] {
    return this.docs.flatMap((d) => d.versions);
  }

  /** The open document has been run at least once. */
  get hasRevision(): boolean {
    return this.versions.length > 0;
  }

  /** There is something worth saving: a run, or text typed in any document. */
  get hasContent(): boolean {
    return this.docs.some((d) => d.versions.length > 0 || d.draft.trim() !== "") || this.docs.length > 1 || this.knowledge.counts().terms + this.knowledge.counts().notes > 0;
  }

  onChange(listener: (kind: ChangeKind) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when all queued work is done (for tests). */
  async whenIdle(): Promise<void> {
    await this.coordinator?.whenIdle();
  }

  // ---- running ----

  /**
   * Translates whatever is missing:
   *  - new or edited text: a new version of the text, with every chosen model run on it (older versions stay);
   *  - the same text: models that have not been run yet, and unfinished blocks of the ones that have.
   * Models named in `rerun` are replaced by fresh runs using the current settings.
   */
  start(input: StartJobInput): WorkspaceSnapshot {
    if (this.snapshot().busy) throw new UserError("busy", "A translation is already running. Cancel it first.");
    const text = normalizeSource(input.text);
    if (text.trim() === "") throw new UserError("empty", "Paste some text to translate first.");
    const plans = this.validate(input);
    this.doc.draft = input.text;
    this.currentPlans = new Map(plans.map((p) => [p.label, p]));

    if (input.backend === "provider") {
      const provider = this.options.provider;
      if (!provider) throw new UserError("no_provider", "No model server connection is set up.");
      const problem = provider.problem();
      if (problem) throw new UserError("endpoint", problem);
    }

    const coordinator = this.ensureCoordinator();
    this.demo = input.demo;
    this.applyDemo(plans[0]!.name);
    const latest = this.versions.at(-1);
    if (latest && latest.revision.exactText === text) this.addMissingRuns(coordinator, latest, plans, input);
    else this.startNewVersion(coordinator, text, plans, input);
    return this.snapshot();
  }

  private hasKnowledge(): boolean {
    const c = this.knowledge.counts();
    return c.terms + c.notes + c.scenes + c.summaries > 0;
  }

  /** What a run draws on: anything passed in with the request, plus the project's knowledge (which wins for the same word). */
  private effectiveKnowledge(glossaryInput: readonly GlossaryEntry[], notesInput: string | undefined): { glossary: GlossaryEntry[]; notes: string } {
    const stored = splitEntries(this.knowledge.all());
    const bySource = new Map<string, GlossaryEntry>();
    for (const g of glossaryInput) bySource.set(g.source.trim(), g);
    for (const g of stored.glossary) bySource.set(g.source, g);
    return { glossary: [...bySource.values()], notes: [(notesInput ?? "").trim(), stored.notes].filter(Boolean).join("\n") };
  }

  /** Checks what the user asked for and works out the runs. Throws plain-language errors. */
  private validate(input: StartJobInput): RunPlan[] {
    return this.buildPlans(input.models, input.prompts, input.glossary, input.notes);
  }

  private buildPlans(models: StartJobInput["models"], prompts: StartJobInput["prompts"], glossaryInput: StartJobInput["glossary"], notesInput: string | undefined): RunPlan[] {
    const named = models.map((m) => ({ ...m, name: m.name.trim() })).filter((m) => m.name !== "");
    if (named.length === 0) throw new UserError("no_models", "Add at least one model.");
    if (named.length > MAX_MODELS) throw new UserError("too_many_models", `At most ${MAX_MODELS} model runs per version of the text.`);

    if (prompts.length > 20) throw new UserError("too_many_prompts", "At most 20 custom prompts.");
    for (const p of prompts) {
      const problem = validatePrompt(p);
      if (problem) throw new UserError("bad_prompt", problem);
    }
    const styles = allPrompts(prompts);
    const merged = this.effectiveKnowledge(glossaryInput, notesInput);
    const glossary = normalizeGlossary(merged.glossary);
    if (glossary.problems.length > 0) throw new UserError("bad_glossary", glossary.problems[0]!);

    const plans = named.map((m) => {
      const style = styles.find((p) => p.id === m.promptId);
      if (!style) throw new UserError("unknown_prompt", `${m.name}: the chosen prompt no longer exists.`);
      if (m.maxOutputTokens >= m.contextLimit) throw new UserError("bad_limits", `${m.name}: the output limit must be smaller than the context size.`);
      return {
        name: m.name,
        label: runLabel(m, styles),
        contextLimit: m.contextLimit,
        maxOutputTokens: m.maxOutputTokens,
        temperature: m.temperature,
        style,
        glossary: glossary.entries,
        notes: merged.notes,
        knowledge: this.hasKnowledge(),
      };
    });
    if (new Set(plans.map((p) => p.label)).size !== plans.length) {
      throw new UserError("duplicate_models", "Each combination of model and prompt can only be used once.");
    }
    return plans;
  }

  /**
   * The window tells the service about the choices that decide how blocks are translated, whenever they change.
   * Retries then use them, and blocks translated under older choices are marked out of date.
   * Choices that cannot be used yet (for example a half-typed glossary row) are ignored until fixed.
   */
  syncSettings(input: SyncSettingsInput): WorkspaceSnapshot {
    let usable = true;
    try {
      const plans = this.buildPlans(input.models, input.prompts, input.glossary, input.notes);
      this.currentPlans = new Map(plans.map((p) => [p.label, p]));
    } catch {
      usable = false; // keep the last usable choices
    }
    // The choices are part of the project. Only a real change counts as something to save.
    let changed = false;
    if (usable || input.models.length === 0) {
      const next: ProjectSettings = {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        blockSize: input.blockSize,
        models: input.models,
        glossary: input.glossary,
        notes: input.notes ?? "",
        ...(input.knowledge !== undefined ? { knowledge: input.knowledge } : {}),
        prompts: input.prompts,
      };
      changed = this.settings !== null && JSON.stringify(this.settings) !== JSON.stringify(next);
      this.settings = next;
    }
    this.refreshOutdated();
    this.notify(changed ? "state" : "view");
    return this.snapshot();
  }

  private startNewVersion(coordinator: Coordinator, text: string, plans: RunPlan[], input: StartJobInput): void {
    const plan = planChunking(
      plans.map((p) => this.budgetInput(p, input)),
      this.sizeLimits(input),
    );
    if (!plan.ok) throw new UserError("budget", plan.issues[0]?.message ?? "The prompt does not fit the model.");
    let revision: SourceRevision;
    try {
      const parent = this.versions.at(-1)?.revision.id;
      revision = createRevision({
        text,
        sourceLanguage: input.sourceLanguage.trim() || "the source language",
        targetLanguage: input.targetLanguage.trim() || "the target language",
        ...(parent ? { parentId: parent } : {}),
        targetTokens: plan.targetTokens,
        maxTokens: plan.maxTokens,
      });
    } catch (e) {
      if (e instanceof RevisionError) throw new UserError(e.code, e.message);
      throw e;
    }

    coordinator.addRevision(revision);
    const version: Version = { id: revision.id, number: this.versions.length + 1, revision, backend: input.backend, runIds: [], createdAt: new Date().toISOString() };
    this.versions.push(version);
    this.viewId = version.id;
    version.runIds = plans.map((p) => this.addRun(coordinator, revision, p, input.backend));
    this.trackJob(coordinator.startJob({ revisionId: revision.id, runIds: version.runIds }).job.id);
  }

  private addMissingRuns(coordinator: Coordinator, version: Version, plans: RunPlan[], input: StartJobInput): void {
    this.refreshOutdated();
    const allBlockIds = version.revision.blocks.map((b) => b.id);
    let started = 0;
    for (const p of plans) {
      const existing = this.activeRuns(coordinator, version).find((r) => r.label === p.label);
      if (!existing) {
        const issues = preflightRevision(version.revision, [this.budgetInput(p, input)]);
        if (issues.length > 0) throw new UserError("budget", issues[0]!.message);
        if (this.activeRuns(coordinator, version).length >= MAX_MODELS) throw new UserError("too_many_models", `At most ${MAX_MODELS} model runs per version of the text.`);
        const id = this.addRun(coordinator, version.revision, p, input.backend);
        version.runIds.push(id);
        this.trackJob(coordinator.startJob({ revisionId: version.revision.id, runIds: [id] }).job.id);
        started++;
        continue;
      }
      // An existing model: bring it up to the current settings, then translate what needs it.
      this.applyCurrentSettings(coordinator, existing.id);
      const stale = this.outdated.get(existing.id) ?? new Set<string>();
      const wanted = input.rerun.includes(p.label)
        ? allBlockIds
        : allBlockIds.filter((id) => {
            const state = existing.outputs[id]?.state;
            return stale.has(id) || (state !== undefined && ["pending", "failed", "canceled", "waiting"].includes(state));
          });
      if (wanted.length === 0) continue;
      // Finished text from the model is replaced (the earlier text stays in the history); text you edited is kept
      // and the new version is offered as a candidate.
      this.trackJob(coordinator.startJob({ revisionId: version.revision.id, runIds: [existing.id], blockIds: wanted, retry: true, replaceGenerated: true }).job.id);
      started++;
    }
    this.viewId = version.id;
    if (started === 0) {
      this.notify("state");
      throw new UserError("nothing_to_do", "Everything is already translated with the current settings.");
    }
  }

  /** Makes a model run use the choices the user has made now (glossary, style, temperature, limits), if it is idle. */
  private applyCurrentSettings(coordinator: Coordinator, runId: string): void {
    const run = coordinator.peekRun(runId);
    const plan = this.currentPlans.get(run.label);
    if (!plan) return;
    coordinator.updateRunSettings(runId, {
      glossary: plan.glossary,
      notes: plan.notes,
      knowledge: plan.knowledge,
      prompt: snapshotPrompt(plan.style),
      config: { contextLimit: plan.contextLimit, maxOutputTokens: plan.maxOutputTokens, temperature: plan.temperature },
    });
  }

  // ---- which blocks are out of date ----

  /** Recomputes, for every model run, the blocks whose translation used settings that have since changed. */
  private refreshOutdated(): void {
    const c = this.coordinator;
    this.outdated.clear();
    if (!c) return;
    for (const v of this.allVersions()) for (const id of v.runIds) this.outdated.set(id, this.outdatedBlocks(c, v, id));
  }

  private outdatedBlocks(c: Coordinator, v: Version, runId: string): Set<string> {
    const run = c.peekRun(runId);
    const plan = this.currentPlans.get(run.label);
    const out = new Set<string>();
    if (!plan) return out;
    const hypothetical = { modelId: run.modelId, glossary: plan.glossary, notes: plan.notes, prompt: snapshotPrompt(plan.style), config: { ...run.config, temperature: plan.temperature } };
    v.revision.blocks.forEach((b, i) => {
      if (this.isOutdated(v.revision, i, run.outputs[b.id], hypothetical)) out.add(b.id);
    });
    return out;
  }

  private isOutdated(revision: SourceRevision, index: number, output: BlockOutput | undefined, current: Pick<ModelRun, "modelId" | "glossary" | "notes" | "prompt" | "config">): boolean {
    if (!output) return false;
    const attempt = producingAttempt(output);
    return !!attempt?.settingsHash && attempt.settingsHash !== blockSettingsHash(revision, index, current, this.materialFor(blockText(revision, revision.blocks[index]!), this.documentOfRevision(revision.id)));
  }

  /** Re-checks one block after something happened to it (an attempt finished, a new version was accepted). */
  private refreshBlock(runId: string, blockId: string): void {
    const c = this.coordinator;
    if (!c) return;
    const v = this.allVersions().find((x) => x.runIds.includes(runId));
    if (!v) return;
    const run = c.peekRun(runId);
    const plan = this.currentPlans.get(run.label);
    const set = this.outdated.get(runId) ?? new Set<string>();
    this.outdated.set(runId, set);
    const index = v.revision.blocks.findIndex((b) => b.id === blockId);
    if (!plan || index < 0) {
      set.delete(blockId);
      return;
    }
    const hypothetical = { modelId: run.modelId, glossary: plan.glossary, notes: plan.notes, prompt: snapshotPrompt(plan.style), config: { ...run.config, temperature: plan.temperature } };
    if (this.isOutdated(v.revision, index, run.outputs[blockId], hypothetical)) set.add(blockId);
    else set.delete(blockId);
  }

  private addRun(coordinator: Coordinator, revision: SourceRevision, p: RunPlan, backend: Backend): string {
    return coordinator.addRun({
      revisionId: revision.id,
      providerRefId: backend === "practice" ? "practice" : "main",
      modelId: p.name,
      label: p.label,
      config: { contextLimit: p.contextLimit, maxOutputTokens: p.maxOutputTokens, temperature: p.temperature },
      prompt: snapshotPrompt(p.style),
      glossary: p.glossary,
      notes: p.notes,
      knowledge: p.knowledge,
    }).id;
  }

  private activeRuns(coordinator: Coordinator, version: Version): ModelRun[] {
    return version.runIds.map((id) => coordinator.snapshotRun(id)).filter((r) => !r.archived);
  }

  /** What one model run needs to know to work out how large a block may be. */
  private budgetInput(p: { label: string; contextLimit: number; maxOutputTokens: number; style: { template: string; appendFraming: boolean }; glossary: GlossaryEntry[]; notes: string; knowledge: boolean }, input: Pick<StartJobInput, "sourceLanguage" | "targetLanguage">) {
    return {
      label: p.label,
      contextLimit: p.contextLimit,
      outputReserve: p.maxOutputTokens,
      systemTokens: estimateTokens(renderPrompt(p.style, input.sourceLanguage, input.targetLanguage)),
      glossaryTokens: knowledgeReserve(p.glossary, p.notes, p.contextLimit, p.knowledge),
    };
  }

  /** The block size the user asked for. The practice translator's "small blocks" option overrides it. */
  private sizeLimits(input: Pick<StartJobInput, "blockSize" | "backend" | "demo">): { targetTokens: number; maxTokens: number } {
    if (input.backend === "practice" && input.demo.smallBlocks) return { targetTokens: 40, maxTokens: 60 };
    return BLOCK_SIZES[input.blockSize] ?? BLOCK_SIZES.normal;
  }

  /**
   * Shows how the text would be split, using exactly the rules a run uses (same sizes, same model limits),
   * without starting anything. It is forgiving: with no model chosen yet it uses the default sizes.
   */
  previewSplit(input: StartJobInput): SplitPreview {
    const text = normalizeSource(input.text);
    const empty: SplitPreview = {
      ok: false,
      problem: null,
      blocks: [],
      characters: text.length,
      bytes: 0,
      targetTokens: 0,
      maxTokens: 0,
      limitingModel: null,
      models: [],
      issues: [],
      notes: [],
    };
    if (text.trim() === "") return { ...empty, problem: "Paste some text to see how it will be split." };

    const styles = allPrompts(input.prompts.filter((p) => validatePrompt(p) === null));
    const merged = this.effectiveKnowledge(input.glossary, input.notes);
    const glossary = normalizeGlossary(merged.glossary).entries;
    const plans = input.models
      .filter((m) => m.name.trim() !== "")
      .map((m) => {
        const style = styles.find((p) => p.id === m.promptId) ?? styles[0]!;
        return { ...m, label: runLabel({ ...m, promptId: style.id }, styles), style, glossary, notes: merged.notes, knowledge: this.hasKnowledge() };
      });
    const limits = this.sizeLimits(input);
    const plan = planChunking(plans.map((p) => this.budgetInput(p, input)), limits);

    const bytes = new TextEncoder().encode(text).length;
    const issues = plan.issues.map((i) => i.message);
    const base = {
      characters: text.length,
      bytes,
      targetTokens: plan.targetTokens,
      maxTokens: plan.maxTokens,
      limitingModel: plan.limitingModel ?? null,
      models: plan.budgets.map((b, i) => ({
        label: b.label,
        contextLimit: plans[i]!.contextLimit,
        outputReserve: plans[i]!.maxOutputTokens,
        fixedTokens: b.fixedTokens,
        sourceBudget: b.sourceBudget,
        contextReserve: b.contextReserve,
        fits: b.fits,
      })),
    };
    if (bytes > DEFAULTS.maxSourceBytes) {
      return { ...empty, ...base, issues, problem: `The text is ${(bytes / 1024 / 1024).toFixed(2)} MiB; the limit is 1 MiB. Split it into several projects.` };
    }
    const chunks = chunkSource(text, { targetTokens: plan.targetTokens, maxTokens: plan.maxTokens });
    if (chunks.length > DEFAULTS.maxBlocks) {
      return { ...empty, ...base, issues, problem: `The text would make ${chunks.length} blocks; the limit is ${DEFAULTS.maxBlocks}. Choose a larger block size or split the text.` };
    }
    const notes = describeSplit(chunks);
    if (plans.length === 0) notes.unshift("No model is chosen yet, so the default block size is shown. It may change once you add one.");
    return {
      ...empty,
      ...base,
      ok: issues.length === 0,
      issues,
      notes,
      blocks: chunks.map((c) => ({ index: c.index, text: text.slice(c.startOffset, c.endOffset), estimatedTokens: c.estimatedTokens, boundaryKind: c.boundaryKind })),
    };
  }

  // ---- documents ----

  createDocument(title?: string): WorkspaceSnapshot {
    const name = title?.trim() || `Document ${this.docs.length + 1}`;
    const doc = newDoc(name.slice(0, 200));
    this.docs.push(doc);
    this.activeDocId = doc.id;
    this.notify("state");
    return this.snapshot();
  }

  /** Switching documents only changes what is shown. It never stops work that is running. */
  selectDocument(documentId: string): WorkspaceSnapshot {
    this.findDoc(documentId);
    this.activeDocId = documentId;
    this.notify("view");
    return this.snapshot();
  }

  renameDocument(documentId: string, title: string): WorkspaceSnapshot {
    const doc = this.findDoc(documentId);
    const name = title.trim();
    if (name === "") throw new UserError("bad_title", "A document needs a name.");
    doc.title = name.slice(0, 200);
    this.notify("state");
    return this.snapshot();
  }

  /** Removes a document and everything translated from it. The last document is emptied instead of removed. */
  deleteDocument(documentId: string): WorkspaceSnapshot {
    const doc = this.findDoc(documentId);
    if (this.snapshot().busy) throw new UserError("busy", "Cancel the running translation before deleting a document.");
    const index = this.docs.indexOf(doc);
    if (this.docs.length === 1) {
      const empty = newDoc("Document 1");
      this.docs = [empty];
      this.activeDocId = empty.id;
    } else {
      this.docs.splice(index, 1);
      if (this.activeDocId === documentId) this.activeDocId = this.docs[Math.min(index, this.docs.length - 1)]!.id;
    }
    for (const v of doc.versions) for (const id of v.runIds) this.outdated.delete(id);
    this.notify("state");
    return this.snapshot();
  }

  /** The text in a document's editor. It is saved with the project even before it has been run. */
  setDraft(documentId: string, text: string): WorkspaceSnapshot {
    const doc = this.findDoc(documentId);
    if (text.length > 5_000_000) throw new UserError("too_large", "That text is too long.");
    if (doc.draft !== text) {
      doc.draft = text;
      this.notify("state");
    }
    return this.snapshot();
  }

  private findDoc(documentId: string): Doc {
    const doc = this.docs.find((d) => d.id === documentId);
    if (!doc) throw new UserError("unknown_document", "That document does not exist.");
    return doc;
  }

  // ---- versions and runs ----

  /** Look at an older (or the newest) version of the text and its results. */
  viewVersion(versionId: string): WorkspaceSnapshot {
    if (!this.versions.some((v) => v.id === versionId)) throw new UserError("unknown_version", "That version of the text does not exist.");
    this.viewId = versionId;
    this.notify("state");
    return this.snapshot();
  }

  /** Hides a model run (and cancels its queued work). Its results stay in the project and can be restored. */
  archiveRun(runId: string): WorkspaceSnapshot {
    this.findVersionOf(runId);
    this.need().archiveRun(runId);
    this.notify("state");
    return this.snapshot();
  }

  restoreArchivedRun(runId: string): WorkspaceSnapshot {
    const v = this.findVersionOf(runId);
    const c = this.need();
    const run = c.snapshotRun(runId);
    if (this.activeRuns(c, v).some((r) => r.label === run.label)) throw new UserError("duplicate_models", `"${run.label}" is already shown. Remove it first to bring this one back.`);
    if (this.activeRuns(c, v).length >= MAX_MODELS) throw new UserError("too_many_models", `At most ${MAX_MODELS} model runs per version of the text.`);
    c.unarchiveRun(runId);
    this.notify("state");
    return this.snapshot();
  }

  private findVersionOf(runId: string): Version {
    const v = this.allVersions().find((x) => x.runIds.includes(runId));
    if (!v) throw new UserError("unknown_run", "That model run does not exist.");
    return v;
  }

  // ---- saving and loading ----

  /** What the window is looking at, for exporting. Removed runs are left out. */
  exportViewed(): { revision: SourceRevision; runs: ModelRun[]; backend: Backend } {
    const v = this.viewed();
    const c = this.coordinator;
    if (!v || !c) throw new UserError("nothing_to_save", "There is nothing to save yet.");
    return { revision: v.revision, runs: this.activeRuns(c, v), backend: v.backend };
  }

  /** The open document's versions, each with every run including removed ones. */
  exportVersions(): ProjectVersion[] {
    const c = this.coordinator;
    if (this.versions.length === 0 || !c) throw new UserError("nothing_to_save", "There is nothing to save yet.");
    return this.versions.map((v) => ({ source: v.revision, backend: v.backend, createdAt: v.createdAt, runs: v.runIds.map((id) => c.snapshotRun(id)) }));
  }

  /** Everything a project file needs: every document, with all versions and runs (including removed ones) and the shared settings. */
  exportProject(): { documents: ProjectDocument[]; activeDocumentId: string; settings: ProjectSettings | null; knowledge: { entries: KnowledgeEntry[]; research: Record<string, ResearchRecord>; classes: string }; guided: GuidedState | null } {
    const c = this.coordinator;
    return {
      documents: this.docs.map((d) => ({
        id: d.id,
        title: d.title,
        createdAt: d.createdAt,
        draft: d.draft,
        versions: c ? d.versions.map((v) => ({ source: v.revision, backend: v.backend, createdAt: v.createdAt, runs: v.runIds.map((id) => c.snapshotRun(id)) })) : [],
      })),
      activeDocumentId: this.activeDocId,
      settings: this.settings ? structuredClone(this.settings) : null,
      knowledge: { entries: this.knowledge.everything(), research: Object.fromEntries(this.research), classes: this.classesText },
      guided: this.guided ? structuredClone(this.guided) : null,
    };
  }

  /** Replaces the open workspace with a saved project (already checked and settled by the caller). */
  restore(project: { documents: ProjectDocument[]; activeDocumentId: string; guided?: GuidedState | undefined; settings?: ProjectSettings | undefined; knowledge?: { entries: KnowledgeEntry[]; research?: Record<string, ResearchRecord> | undefined; classes?: string | undefined } | undefined }): void {
    if (this.snapshot().busy) throw new UserError("busy", "Cancel the running translation first.");
    if (!this.options.provider && project.documents.some((d) => d.versions.some((v) => v.runs.some((r) => r.providerRefId === "main")))) {
      throw new UserError("no_provider", "This project needs a model server connection, which is not set up.");
    }
    this.clear();
    const coordinator = this.ensureCoordinator();
    this.docs = project.documents.map((d) => {
      const doc: Doc = { id: d.id, title: d.title, createdAt: d.createdAt, draft: d.draft, versions: [], viewId: null };
      for (const v of d.versions) {
        coordinator.addRevision(v.source);
        for (const run of v.runs) coordinator.restoreRun(run);
        doc.versions.push({ id: v.source.id, number: doc.versions.length + 1, revision: v.source, backend: v.backend, runIds: v.runs.map((r) => r.id), createdAt: v.createdAt ?? new Date().toISOString() });
      }
      doc.viewId = doc.versions.at(-1)?.id ?? null;
      return doc;
    });
    this.activeDocId = this.docs.some((d) => d.id === project.activeDocumentId) ? project.activeDocumentId : this.docs[0]!.id;
    this.settings = project.settings ? structuredClone(project.settings) : null;
    this.guided = project.guided ? structuredClone(project.guided) : null;
    this.research = new Map(Object.entries(project.knowledge?.research ?? {}));
    this.classesText = project.knowledge?.classes === undefined || project.knowledge.classes === LEGACY_CLASSES_TEXT ? DEFAULT_CLASSES_TEXT : project.knowledge.classes;
    if (project.knowledge) this.knowledge.load(dropLooseNotes(project.knowledge.entries as KnowledgeEntry[]));
    else if (this.settings && (this.settings.glossary.length > 0 || this.settings.notes || this.settings.knowledge)) {
      // A project from before the knowledge store: bring its glossary and notes over once.
      this.knowledge.load(entriesFromLegacy(this.settings.glossary, this.settings.notes, this.settings.knowledge, { newId, now: () => new Date().toISOString() }));
      this.settings = { ...this.settings, glossary: [], notes: "" };
      delete this.settings.knowledge;
    } else this.knowledge.load([]);
    this.firstModel = this.versions.at(-1)?.runIds[0] ? coordinator.peekRun(this.versions.at(-1)!.runIds[0]!).modelId : "";
    this.epoch++;
    this.refreshOutdated();
    this.notify("state");
  }

  reset(): WorkspaceSnapshot {
    if (this.snapshot().busy) throw new UserError("busy", "Cancel the running translation before starting over.");
    this.clear();
    this.notify("state");
    return this.snapshot();
  }

  private clear(): void {
    this.coordinator = null;
    this.practice = null;
    this.docs = [newDoc("Document 1")];
    this.activeDocId = this.docs[0]!.id;
    this.settings = null;
    this.guided = null;
    this.knowledge.load([]);
    this.classesText = DEFAULT_CLASSES_TEXT;
    this.research.clear();
    this.epoch++;
    this.jobIds = [];
    this.waitingInfo.clear();
    this.outdated.clear();
    this.firstModel = "";
  }

  // ---- cancel and retry ----

  cancel(input: CancelInput): WorkspaceSnapshot {
    const c = this.need();
    if (input.kind === "job") {
      // Also stops later jobs (retries) that are queued behind the current one.
      for (const id of this.jobIds) c.cancel({ kind: "job", jobId: id });
    } else if (input.kind === "run") c.cancel({ kind: "run", runId: input.runId });
    else c.cancel({ kind: "block", runId: input.runId, blockId: input.blockId });
    return this.snapshot();
  }

  retryBlock(runId: string, blockId: string): WorkspaceSnapshot {
    const c = this.need();
    this.applyCurrentSettings(c, runId);
    // A block translated with older settings is replaced by the new translation (text you edited is kept and the
    // new one offered instead). Otherwise a retry is another try to compare with the current text.
    const replace = this.outdated.get(runId)?.has(blockId) ?? false;
    this.trackJob(c.retryBlock(runId, blockId, { replaceGenerated: replace }).job.id);
    return this.snapshot();
  }
  retryUnfinished(runId: string): WorkspaceSnapshot {
    const c = this.need();
    this.applyCurrentSettings(c, runId);
    this.trackJob(c.retryUnfinished(runId).job.id);
    return this.snapshot();
  }
  retranslateDownstream(runId: string): WorkspaceSnapshot {
    const c = this.need();
    this.applyCurrentSettings(c, runId);
    this.trackJob(c.retranslateDownstream(runId).job.id);
    return this.snapshot();
  }
  resolveWaiting(runId: string, resolution: "retry" | "skip"): WorkspaceSnapshot {
    try {
      this.need().resolveWaiting(runId, resolution);
    } catch (e) {
      throw new UserError("not_waiting", e instanceof Error ? e.message : "Nothing is waiting.");
    }
    return this.snapshot();
  }
  acceptCandidate(runId: string, blockId: string): WorkspaceSnapshot {
    this.guard(() => this.need().acceptCandidate(runId, blockId));
    return this.snapshot();
  }
  keepCurrent(runId: string, blockId: string): WorkspaceSnapshot {
    this.guard(() => this.need().keepCurrent(runId, blockId));
    return this.snapshot();
  }
  acceptReview(runId: string, blockId: string): WorkspaceSnapshot {
    this.guard(() => this.need().acceptReview(runId, blockId));
    return this.snapshot();
  }
  editBlock(runId: string, blockId: string, text: string): WorkspaceSnapshot {
    this.guard(() => this.need().editBlock(runId, blockId, text));
    return this.snapshot();
  }

  /** Practice mode: pretend the user loaded the model in LM Studio. */
  loadDemoModel(): WorkspaceSnapshot {
    this.practice?.setUnavailable(this.firstModel, false);
    this.notify("state");
    return this.snapshot();
  }

  // ---- what the window sees ----

  snapshot(): WorkspaceSnapshot {
    const c = this.coordinator;
    const view = this.viewed();
    const project = this.options.projectView?.() ?? NO_PROJECT;
    const documents = this.documentViews();

    // Work is project-wide: a job in one document keeps the whole project busy, whichever document is open.
    const jobs = c ? this.jobIds.map((id) => c.snapshotJob(id)) : [];
    const last = jobs.at(-1);
    const busy = jobs.some((j) => ["queued", "running", "waiting"].includes(j.state));
    const waitingRun = c ? this.allVersions().flatMap((v) => v.runIds).map((id) => c.snapshotRun(id)).find((r) => r.state === "waiting" && !r.archived) : undefined;
    const info = waitingRun ? this.waitingInfo.get(waitingRun.id) : undefined;
    const job = last ? { id: last.id, state: last.state, ...(last.stopReason ? { stopReason: last.stopReason } : {}) } : null;
    const waiting = waitingRun ? { runId: waitingRun.id, label: waitingRun.label, code: info?.code ?? "waiting", message: info?.message ?? "Waiting for the model." } : null;

    const base = {
      documents,
      activeDocumentId: this.activeDocId,
      draftText: this.doc.draft,
      epoch: this.epoch,
      settings: this.settings,
      knowledge: { ...this.knowledge.counts(), rev: this.knowledge.rev },
      versions: [],
      latestText: null,
      viewingId: null,
      latestId: null,
      archived: [],
      job,
      backend: null,
      busy,
      waiting,
      demoModelUnloaded: false,
      project,
    };
    if (!c || !view) return { ...base, revision: null, runs: [] };

    const all = view.runIds.map((id) => c.snapshotRun(id));
    const runs = all.filter((r) => !r.archived);
    const revision = view.revision;
    return {
      documents,
      activeDocumentId: this.activeDocId,
      draftText: this.doc.draft,
      epoch: this.epoch,
      settings: this.settings,
      knowledge: { ...this.knowledge.counts(), rev: this.knowledge.rev },
      revision: {
        id: revision.id,
        sourceLanguage: revision.sourceLanguage,
        targetLanguage: revision.targetLanguage,
        text: revision.exactText,
        blocks: revision.blocks.map((b) => ({
          id: b.id,
          index: b.index,
          text: revision.exactText.slice(b.startOffset, b.endOffset),
          estimatedTokens: b.estimatedTokens,
          boundaryKind: b.boundaryKind,
        })),
      },
      versions: this.versions.map((v) => ({
        id: v.id,
        number: v.number,
        blocks: v.revision.blocks.length,
        models: v.runIds.filter((id) => !c.snapshotRun(id).archived).length,
        createdAt: v.createdAt,
      })),
      latestText: this.versions.at(-1)!.revision.exactText,
      viewingId: view.id,
      latestId: this.versions.at(-1)!.id,
      runs: runs.map((r) => {
        const stale = this.outdated.get(r.id);
        return {
        id: r.id,
        versionId: view.id,
        label: r.label,
        unfinished: Object.values(r.outputs).filter((o) => ["pending", "failed", "canceled", "waiting"].includes(o.state)).length,
        outdated: stale?.size ?? 0,
        settings: {
          modelId: r.modelId,
          contextLimit: r.config.contextLimit,
          maxOutputTokens: r.config.maxOutputTokens,
          temperature: r.config.temperature,
          promptId: r.prompt?.id ?? "standard",
          useGlossary: true,
        },
        promptName: r.prompt?.name ?? "Standard",
        state: r.state,
        blocks: Object.fromEntries(Object.entries(r.outputs).map(([id, o]) => [id, cellView(o, stale?.has(id) ?? false)])),
        };
      }),
      archived: all.filter((r) => r.archived).map((r) => ({ runId: r.id, label: r.label })),
      backend: this.versions.at(-1)!.backend,
      job,
      busy,
      waiting,
      demoModelUnloaded: !!this.practice && this.demo.firstModelUnloaded && this.practice.isUnavailable(this.firstModel),
      project,
    };
  }

  // ---- internals ----

  /** The left rail's list: each document with the progress of its newest version. */
  private documentViews(): DocumentView[] {
    const c = this.coordinator;
    return this.docs.map((d) => {
      const latest = d.versions.at(-1);
      let done = 0;
      let total = 0;
      let models = 0;
      if (latest && c) {
        for (const id of latest.runIds) {
          const run = c.peekRun(id);
          if (run.archived) continue;
          models++;
          for (const o of Object.values(run.outputs)) {
            total++;
            if (o.state === "succeeded") done++;
          }
        }
      }
      return { id: d.id, title: d.title, blocks: latest?.revision.blocks.length ?? 0, models, done, total, hasText: d.draft.trim() !== "" || !!latest };
    });
  }

  private viewed(): Version | undefined {
    return this.versions.find((v) => v.id === this.viewId) ?? this.versions.at(-1);
  }

  private trackJob(id: string): void {
    this.jobIds.push(id);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError("invalid_action", e instanceof Error ? e.message : "That action is not possible right now.");
    }
  }

  private need(): Coordinator {
    if (!this.coordinator) throw new UserError("no_workspace", "Nothing is open yet.");
    return this.coordinator;
  }

  /** One job runner for the whole project. It knows both translators; each run says which one it uses. */
  private ensureCoordinator(): Coordinator {
    if (this.coordinator) return this.coordinator;
    const registry = new ProviderRegistry();
    this.practice = this.makePractice();
    registry.register(this.practice);
    const provider = this.options.provider;
    if (provider) registry.register(new CurrentProvider(() => provider.adapter()));
    const coordinator = new Coordinator({
      registry,
      providerConfig: (ref) => {
        if (ref === "practice") return { id: "practice", kind: "fake", baseUrl: "http://localhost:1234/v1" };
        if (!provider) throw new UserError("no_provider", "No model server connection is set up.");
        return provider.config();
      },
      // The practice translator only echoes text, so only the glossary check is meaningful for it.
      checks: (run) => (run.providerRefId === "practice" ? "terms" : "all"),
      material: (run, blockText) => this.materialFor(blockText, this.documentOfRevision(run.revisionId)),
      ...(this.options.checkpoint ? { checkpoint: this.options.checkpoint } : {}),
    });
    coordinator.onEvent((e) => this.onCoordinatorEvent(e));
    this.coordinator = coordinator;
    return coordinator;
  }

  private onCoordinatorEvent(e: CoordinatorEvent): void {
    if (e.type === "waiting" && e.runId) {
      this.waitingInfo.set(e.runId, { code: String(e.payload.code ?? "waiting"), message: String(e.payload.message ?? "") });
    }
    if (e.runId && e.blockId && (e.type === "terminal" || e.type === "stateChanged")) this.refreshBlock(e.runId, e.blockId);
    this.notify(e.type === "delta" ? "delta" : "state");
  }

  private notify(kind: ChangeKind = "state"): void {
    for (const l of this.listeners) l(kind);
  }

  /** Applies the latest practice-mode controls to the practice translator. */
  private applyDemo(firstModel: string): void {
    this.firstModel = firstModel;
    this.practiceOptions.deltaDelayMs = this.options.speedMs ?? SPEED_MS[this.demo.speed];
    this.practice?.setUnavailable(firstModel, this.demo.firstModelUnloaded);
  }

  // ---- names, hints and notes ----

  private documentRefs() {
    return this.docs.map((d) => ({ id: d.id, title: d.title }));
  }

  /** The kinds of topic and their attributes, as the user last wrote them. */
  private classesText = DEFAULT_CLASSES_TEXT;

  private fileContext(): FileContext {
    return { entries: this.knowledge.all(), classes: parseClasses(this.classesText).classes, classesText: this.classesText, docs: this.documentRefs() };
  }

  /** The files of the knowledge base: topics, scenes, summaries, the notes and the classes. */
  knowledgeFiles(): KnowledgeFiles {
    const ctx = this.fileContext();
    return { files: listFiles(ctx), classes: ctx.classes.map((c) => ({ name: c.name, label: classLabel(c.name) })), rev: this.knowledge.rev };
  }

  knowledgeFile(id: string, problems: { line: number; message: string }[] = []): KnowledgeFile {
    const ctx = this.fileContext();
    const text = fileText(id, ctx);
    if (text === null) throw new UserError("no_file", "That file no longer exists.");
    return { id, title: titleOf(id, ctx), text, problems, backlinks: backlinksOf(id, ctx), rev: this.knowledge.rev };
  }

  /**
   * Applies an edited file. Lines that could not be understood are reported and leave their entries as they were;
   * the text that comes back is the file in its tidy form.
   */
  knowledgeSetFile(id: string, text: string): KnowledgeFile {
    const result = applyFile(this.knowledge.everything(), id, text, this.fileContext(), { newId, now: () => new Date().toISOString() });
    const before = this.knowledge.rev;
    if (result.classesText !== undefined) {
      if (result.classesText !== this.classesText) {
        this.classesText = result.classesText;
        this.knowledge.touch();
      }
    } else this.knowledge.replaceWith(result.entries);
    if (this.knowledge.rev !== before) this.knowledgeChanged();
    const exists = id === "classes" || this.knowledge.all().some((e) => e.id === id);
    if (!exists) throw new UserError("no_file", "That file no longer exists.");
    const file = this.knowledgeFile(id, result.problems);
    // The same checks on the tidied text, so the window can show the problems where the lines now are.
    const again = applyFile(this.knowledge.everything(), id, file.text, this.fileContext(), { newId, now: () => new Date().toISOString() });
    return { ...file, tidyProblems: again.problems };
  }

  /** Makes a new, empty topic of a class and returns its file. */
  knowledgeCreate(type: string, name: string): { id: string } {
    const clean = name.trim();
    if (clean === "") throw new UserError("bad_name", "Enter a name.");
    const existing = resolveName(clean, this.knowledge.all());
    if (existing) throw new UserError("duplicate_topic", `There is already a topic called "${existing.source}".`);
    const topic = newTopic(type, clean, { newId, now: () => new Date().toISOString() });
    this.knowledge.replaceWith([...this.knowledge.everything(), topic]);
    this.knowledgeChanged();
    return { id: topic.id };
  }

  /**
   * Deletes a file. A topic a model suggested is remembered as rejected so it is not suggested again;
   * anything else is removed for good. The notes and classes files cannot be deleted.
   */
  knowledgeDelete(id: string): { removed: boolean } {
    const entry = this.knowledge.all().find((e) => e.id === id);
    if (!entry) return { removed: false };
    if (entry.kind === "term" && entry.status === "suggested") {
      const all = this.knowledge.everything();
      this.knowledge.replaceWith(
        all
          .filter((e) => !(e.kind === "note" && e.about === id && e.status === "confirmed"))
          .map((e) => (e.id === id || (e.kind === "note" && e.about === id) ? { ...e, status: "rejected" as const } : e.kind === "scene" ? { ...e, related: e.related.filter((r) => r !== id) } : e)),
      );
    } else this.knowledge.remove([id]);
    this.knowledgeChanged();
    return { removed: true };
  }

  knowledgeResolve(name: string): { id: string | null; title: string | null } {
    const hit = resolveName(name, this.knowledge.all());
    return { id: hit?.id ?? null, title: hit?.source ?? null };
  }

  /**
   * Looks over the whole knowledge base for things that cannot all be right (two topics sharing a name, links that lead
   * nowhere...) and notes each one on the topic it is about, as a suggested note beginning with "Check:".
   */
  knowledgeCheck(): { found: number; added: number; removed: number } {
    const issues = checkKnowledge(this.knowledge.all(), parseClasses(this.classesText).classes);
    const result = applyChecks(this.knowledge.all(), this.knowledge.rejected(), issues, { newId, now: () => new Date().toISOString() });
    if (result.added > 0 || result.removed > 0) {
      this.knowledge.replaceLive(result.entries);
      this.knowledgeChanged();
    }
    return { found: issues.length, added: result.added, removed: result.removed };
  }

  /** Before reading a document again: forget what a model suggested from it that nobody checked. */
  beginExtraction(documentId: string): { discarded: number } {
    const doc = this.docs.find((d) => d.id === documentId);
    const discarded = this.knowledge.discardSuggested(documentId, doc?.title ?? "");
    if (discarded > 0) this.knowledgeChanged();
    return { discarded };
  }

  knowledgeList(query: EntryQuery): KnowledgeList {
    const { entries, total } = this.knowledge.list(query);
    return { entries, total, counts: this.knowledge.counts(), rev: this.knowledge.rev };
  }

  knowledgeSave(input: EntryInput): { entry: KnowledgeEntry } {
    const entry = this.knowledge.save(input);
    this.knowledgeChanged();
    return { entry };
  }

  knowledgeRemove(ids: string[]): { removed: number } {
    const removed = this.knowledge.remove(ids);
    if (removed > 0) this.knowledgeChanged();
    return { removed };
  }

  knowledgeConfirm(ids?: string[]): { confirmed: number } {
    const confirmed = this.knowledge.confirm(ids);
    if (confirmed > 0) this.knowledgeChanged();
    return { confirmed };
  }

  /** Adds entries from pasted lines, as the user's own. Lines that already exist are skipped. */
  knowledgeImport(text: string): { added: number; unreadable: number } {
    const { entries, unreadable } = entriesFromText(text, { by: "user" }, "confirmed", { newId, now: () => new Date().toISOString() });
    const added = this.knowledge.addMany(entries);
    if (added > 0) this.knowledgeChanged();
    return { added, unreadable };
  }

  /** The choices runs draw on changed: bring the current plans up to date and mark what is now out of date. */
  private knowledgeChanged(): void {
    if (this.settings) {
      try {
        const plans = this.buildPlans(this.settings.models, this.settings.prompts, this.settings.glossary, this.settings.notes);
        this.currentPlans = new Map(plans.map((p) => [p.label, p]));
      } catch {
        /* keep the last usable choices */
      }
    }
    this.refreshOutdated();
    this.notify("state");
  }


  // ---- step by step translation ----

  private guided: GuidedState | null = null;

  guidedGet(): GuidedState | null {
    return this.guided;
  }

  private guidedBlock(index: number) {
    const block = this.guided?.blocks[index];
    if (!this.guided || !block) throw new UserError("no_block", "That block does not exist. Start again from the text.");
    return block;
  }

  private guidedChanged(): void {
    this.notify("state");
  }

  /** Splits the text into blocks to go through one at a time. */
  guidedStart(input: GuidedStartInput): GuidedState {
    const text = normalizeSource(input.text);
    if (text.trim() === "") throw new UserError("no_text", "Paste some text first.");
    const limits = BLOCK_SIZES[input.blockSize] ?? BLOCK_SIZES.normal;
    const chunks = chunkSource(text, { targetTokens: limits.targetTokens, maxTokens: limits.maxTokens });
    this.guided = {
      documentId: input.documentId,
      current: 0,
      blocks: chunks.map((c, index) => ({ index, text: text.slice(c.startOffset, c.endOffset), interpretation: null, translation: "", status: "new" as const, error: null })),
    };
    this.guidedChanged();
    return this.guided;
  }

  guidedGo(index: number): GuidedState {
    this.guidedBlock(index);
    this.guided!.current = index;
    this.guidedChanged();
    return this.guided!;
  }

  guidedClear(): null {
    this.guided = null;
    this.guidedChanged();
    return null;
  }

  /** The names in the glossary, in the form the reading of a block starts from. */
  private knownNames(): KnownName[] {
    const kinds: NameKind[] = ["character", "family", "place", "organization", "term"];
    return this.knowledge
      .all()
      .filter((e) => e.kind === "term" && e.status !== "rejected")
      .map((e) => ({ source: e.source, english: e.target, kind: (kinds.includes(e.category as NameKind) ? e.category : "term") as NameKind, aliases: e.aliases, narrator: (e.attrs["role"] ?? []).some((r) => /narrator/i.test(r)), gender: ((e.attrs["gender"] ?? [])[0] === "female" || (e.attrs["gender"] ?? [])[0] === "male" ? e.attrs["gender"]![0] : null) as "female" | "male" | null }));
  }

  /** Reads one block: who is named, who is telling it, who says each line. */
  async guidedInterpret(index: number): Promise<GuidedState> {
    const block = this.guidedBlock(index);
    const glossary = this.knownNames();
    const candidates = await findCandidateNames(block.text);
    const readings = await readNames([...new Set([...candidates, ...glossary.map((g) => g.source)])]);
    block.interpretation = interpretPassage({ passage: block.text, candidates, readings, glossary });
    if (block.status === "new") block.status = "interpreted";
    this.guided!.current = index;
    this.guidedChanged();
    return this.guided!;
  }

  guidedSave(index: number, interpretation: Interpretation): GuidedState {
    const block = this.guidedBlock(index);
    block.interpretation = interpretation;
    if (block.status === "new") block.status = "interpreted";
    this.guidedChanged();
    return this.guided!;
  }

  /** What the user confirmed becomes part of the glossary, so the next blocks start from it. */
  private rememberInterpretation(interp: Interpretation): void {
    const entries = this.knowledge.all().filter((e) => e.kind === "term");
    for (const n of interp.names) {
      if (n.english.trim() === "") continue;
      const found = entries.find((e) => e.source === n.source);
      const isNarrator = interp.narrator === n.source;
      const attrs = { ...(found?.attrs ?? {}) };
      if (isNarrator) attrs["role"] = ["narrator"];
      if (n.gender) attrs["gender"] = [n.gender];
      const aliases = [...new Set([...(found?.aliases ?? []), ...n.aliases])].filter((a) => a !== n.source);
      this.knowledge.save({ ...(found ? { id: found.id } : {}), kind: "term", source: n.source, target: n.english.trim(), hint: found?.hint ?? "", category: n.kind, aliases, attrs, text: "", about: null });
    }
    // Only one narrator: anyone else who was marked as one no longer is.
    if (interp.narrator) {
      for (const e of this.knowledge.all().filter((x) => x.kind === "term" && x.source !== interp.narrator && (x.attrs["role"] ?? []).some((r) => /narrator/i.test(r)))) {
        const rest = (e.attrs["role"] ?? []).filter((r) => !/narrator/i.test(r));
        const attrs = { ...e.attrs };
        if (rest.length > 0) attrs["role"] = rest;
        else delete attrs["role"];
        this.knowledge.save({ id: e.id, kind: "term", source: e.source, target: e.target, hint: e.hint, category: e.category, aliases: e.aliases, attrs, text: "", about: null });
      }
    }
    this.knowledgeChanged();
  }

  /** Translates a block with what the user confirmed, and the end of the block before it. */
  async guidedTranslate(input: GuidedModelInput & { index: number }): Promise<GuidedState> {
    const block = this.guidedBlock(input.index);
    if (!block.interpretation) await this.guidedInterpret(input.index);
    const interp = block.interpretation!;
    const abort = this.beginSideRequest();
    try {
      this.rememberInterpretation(interp);
      const system = renderPrompt(STANDARD_PROMPT, input.sourceLanguage, input.targetLanguage);
      const previous = input.index > 0 ? this.guided!.blocks[input.index - 1] : undefined;
      const glossary = glossaryFor(interp);
      const notes = notesFor(interp);
      let user = "";
      // Overlap: the end of the block before, source and translation. Fewer lines if the context is tight.
      for (const lines of [3, 2, 1, 0]) {
        const context =
          previous && previous.status === "translated" && lines > 0
            ? { source: lastLines(previous.text, lines, 500), translation: lastLines(previous.translation, lines, 500), translationStatus: "available" as const }
            : { source: null, translation: null, translationStatus: "none" as const };
        user = renderUserMessage(glossary, context, block.text, notes);
        if (estimateTokens(system) + estimateTokens(user) + input.maxOutputTokens + DEFAULTS.messageOverheadTokens <= input.contextLimit) break;
        if (lines === 0) throw new UserError("context_overflow", `This block needs about ${estimateTokens(system) + estimateTokens(user)} tokens plus ${input.maxOutputTokens} for the reply, but the context of ${input.modelId} is set to ${input.contextLimit}. Raise the context size, or use smaller blocks.`);
      }
      block.error = null;
      const reply = await this.askModel(
        {
          backend: input.backend,
          modelId: input.modelId,
          maxOutputTokens: input.maxOutputTokens,
          temperature: input.temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          practiceReply: () => `Practice translation of block ${input.index + 1}. A real model would write the story here.`,
        },
        abort,
      );
      if (reply !== null) {
        block.translation = reply.trim();
        block.status = "translated";
      }
    } catch (e) {
      block.error = e instanceof UserError ? e.message : "The translation failed.";
      this.guidedChanged();
      throw e;
    } finally {
      this.analysisAbort = null;
    }
    this.guidedChanged();
    return this.guided!;
  }

  // ---- suggested notes ----

  private analysisAbort: AbortController | null = null;

  /** Only one request of this kind at a time, and never while translations are running (the model server handles one thing at a time). */
  private beginSideRequest(): AbortController {
    if (this.snapshot().busy) throw new UserError("busy", "Wait for the translations to finish, then try again.");
    if (this.analysisAbort) throw new UserError("busy", "Already working on the text.");
    const abort = new AbortController();
    this.analysisAbort = abort;
    return abort;
  }

  /** One request to a model, answered in full. Returns null if the user stopped it. */
  private async askModel(
    ask: { backend: Backend; modelId: string; maxOutputTokens: number; messages: { role: "system" | "user"; content: string }[]; practiceReply: () => string; temperature?: number; allowEmpty?: boolean },
    abort: AbortController,
  ): Promise<string | null> {
    let reply = "";
    if (ask.backend === "practice") {
      await new Promise((r) => setTimeout(r, this.options.speedMs ?? 150));
      reply = ask.practiceReply();
    } else {
      const provider = this.options.provider;
      if (!provider) throw new UserError("no_provider", "No model server connection is set up.");
      const stream = provider.adapter().generate(
        provider.config(),
        { requestId: newId(), modelId: ask.modelId, messages: ask.messages, temperature: ask.temperature ?? 0.2, maxOutputTokens: ask.maxOutputTokens, stream: true },
        abort.signal,
      );
      const it = stream[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await it.next();
          if (next.done) break;
          const ev = next.value;
          if (ev.type === "delta") reply += ev.text;
          else if (ev.type === "error") {
            if (abort.signal.aborted) break;
            throw new UserError(ev.error.code, ev.error.message);
          } else break;
        }
      } catch (e) {
        if (!abort.signal.aborted) throw e;
      } finally {
        void it.return?.(undefined).catch(() => {});
      }
    }
    if (abort.signal.aborted) return null;
    reply = stripThinking(reply);
    if (reply.trim() === "" && !ask.allowEmpty) throw new UserError("invalid_response", "The model returned no text. If it is a thinking model, raise its reply limit.");
    return reply;
  }

  /** What the practice translator answers to each kind of question: always the most harmless option. */
  private practiceAnswer(q: Question): string {
    const letter = (start: string) => String.fromCharCode(65 + Math.max(0, (q.options ?? []).findIndex((o) => o.startsWith(start))));
    switch (q.id) {
      case "list-names":
        return "NONE";
      case "classify":
        return letter("a person");
      case "same-as":
        return letter("None");
      case "english-name":
        return "Practice name";
      case "describe":
        return "an example, not written by a model";
      case "supported":
        return letter("Yes");
      case "role":
        return letter("speaks or acts");
      case "attribute":
        return letter("Not stated");
      case "relation":
        return letter("No");
      case "same-scene":
        return letter("No");
      case "narrator":
        return letter("None");
      case "scene-text":
        return "Practice mode: this scene description is an example.";
      case "condense":
        return "Practice mode: this summary is an example.";
      default:
        return "";
    }
  }

  /** Something that puts one narrow question to the chosen model (or the practice translator). */
  private questionAsker(backend: Backend, modelId: string, abort: AbortController): Asker {
    return {
      ask: (q: Question) =>
        this.askModel(
          {
            backend,
            modelId,
            maxOutputTokens: q.maxTokens,
            temperature: 0,
            allowEmpty: true,
            messages: [
              { role: "system", content: q.system },
              { role: "user", content: q.user },
            ],
            practiceReply: () => this.practiceAnswer(q),
          },
          abort,
        ),
    };
  }

  /**
   * Reads one passage for knowledge in layers: the program finds candidate names, then asks the model one narrow
   * question at a time (what is this name, is it one we know, who is acting, what does the text say about them...) and
   * checks each answer before using it. What it finds is added to the knowledge base as suggestions.
   */
  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const abort = this.beginSideRequest();
    try {
      // The longest question is the one that lists names, which needs the whole passage.
      const fixed = estimateTokens(input.passage) + 260 + 150 + DEFAULTS.messageOverheadTokens + 60;
      if (fixed > input.contextLimit) {
        throw new UserError(
          "context_overflow",
          `This block needs about ${fixed} tokens to be read for knowledge, but the context of ${input.modelId} is set to ${input.contextLimit}. Raise the context size for this model (in its settings), or use smaller blocks.`,
        );
      }
      const candidates = await findCandidateNames(input.passage);
      const asker = this.questionAsker(input.backend, input.modelId, abort);
      const origin = { by: "model" as const, model: input.modelId, documentId: input.documentId, documentTitle: input.documentTitle, block: input.block };
      const result = await extractBlock({
        entries: this.knowledge.all(),
        rejected: this.knowledge.rejected(),
        classes: parseClasses(this.classesText).classes,
        passage: input.passage,
        scope: { documentId: input.documentId, blockHash: sha256Hex(input.passage), block: input.block },
        origin,
        candidates,
        readings: readNames,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        asker,
        deps: { newId, now: () => new Date().toISOString() },
        shouldStop: () => abort.signal.aborted,
      });
      if (abort.signal.aborted) return { added: 0, canceled: true, notes: [] };
      if (JSON.stringify(result.entries) !== JSON.stringify(this.knowledge.all())) {
        this.knowledge.replaceLive(result.entries);
        this.knowledgeChanged();
      }
      return { added: result.added, canceled: false, notes: result.problems };
    } finally {
      this.analysisAbort = null;
    }
  }

  /**
   * The second step of the scenes: every block has a scene description of its own, and here the ones that follow each
   * other and belong together are joined into one scene.
   */
  async mergeScenesStep(input: MergeScenesInput): Promise<MergeScenesResult> {
    const abort = this.beginSideRequest();
    try {
      const room = input.contextLimit - 400 - Math.min(input.maxOutputTokens, 500) - DEFAULTS.messageOverheadTokens - 100;
      const result = await mergeScenes({
        entries: this.knowledge.all(),
        documentId: input.documentId,
        title: input.documentTitle,
        targetLanguage: input.targetLanguage,
        asker: this.questionAsker(input.backend, input.modelId, abort),
        room,
        deps: { newId, now: () => new Date().toISOString() },
        shouldStop: () => abort.signal.aborted,
      });
      if (result.canceled || abort.signal.aborted) return { joined: 0, canceled: true };
      if (result.joined > 0) {
        this.knowledge.replaceLive(result.entries);
        this.knowledgeChanged();
      }
      return { joined: result.joined, canceled: false };
    } finally {
      this.analysisAbort = null;
    }
  }

  /**
   * Makes the summary of a document: its scene descriptions in order, shortened by the model only when they are too long,
   * and checked against the scenes so it cannot add anything. A summary the user accepted is kept unless a rewrite is asked for.
   */
  async summarize(input: SummarizeInput): Promise<SummarizeResult> {
    const abort = this.beginSideRequest();
    try {
      const scenes = this.knowledge
        .all()
        .filter((e) => e.kind === "scene" && e.scope?.documentId === input.documentId)
        .sort((a, b) => (a.scope?.block ?? 0) - (b.scope?.block ?? 0))
        .map((e) => e.text);
      const done = this.knowledge.all().find((e) => e.kind === "summary" && e.scope?.documentId === input.documentId && e.status === "confirmed");
      if (scenes.length === 0 || (done && !input.rewrite)) return { updated: false, canceled: false };
      const room = input.contextLimit - 400 - Math.min(input.maxOutputTokens, 500) - DEFAULTS.messageOverheadTokens - 100;
      if (room < 120 && estimateTokens(scenes.join(" ")) > SUMMARY_DIRECT_TOKENS) throw new UserError("context_overflow", "The model's context is too small to shorten the summary. Raise the context size for this model.");
      const built = await buildSummary({
        scenes,
        title: input.documentTitle,
        targetLanguage: input.targetLanguage,
        asker: this.questionAsker(input.backend, input.modelId, abort),
        room,
        shouldStop: () => abort.signal.aborted,
      });
      if (built.canceled || abort.signal.aborted) return { updated: false, canceled: true };
      const origin = { by: "model" as const, model: input.modelId, documentId: input.documentId, documentTitle: input.documentTitle };
      const merged = mergeSummary(this.knowledge.all(), built.text, { documentId: input.documentId }, origin, { newId, now: () => new Date().toISOString() }, input.rewrite === true);
      if (merged.updated) {
        this.knowledge.replaceLive(merged.entries);
        this.knowledgeChanged();
      }
      return { updated: merged.updated, canceled: false };
    } finally {
      this.analysisAbort = null;
    }
  }

  // ---- choosing the background for each block ----

  /** What has been decided about each passage, by the passage's hash. Saved with the project. */
  private research = new Map<string, ResearchRecord>();

  /** The background chosen for a block, or undefined if no one has looked through the knowledge for it (a backup is used then). */
  private materialFor(blockText: string, documentId: string | null): BlockMaterial | undefined {
    const hash = sha256Hex(blockText);
    return blockMaterial(this.knowledge.all(), this.research.get(hash)?.ids ?? null, hash, documentId) ?? undefined;
  }

  /** Which document a version of the text belongs to. */
  private documentOfRevision(revisionId: string): string | null {
    return this.docs.find((d) => d.versions.some((v) => v.revision.id === revisionId))?.id ?? null;
  }

  /**
   * A model reads one block and the project's knowledge and chooses which entries matter for translating it.
   * Only entries that are new or changed since the last time are looked at, so asking again is cheap.
   */
  async researchBlock(input: ResearchInput): Promise<ResearchResult> {
    const abort = this.beginSideRequest();
    try {
      const entries = this.knowledge.all();
      const key = sha256Hex(input.passage);
      const record = this.research.get(key);
      const pending = entriesToConsider(entries, record);
      if (entries.length === 0 || pending.length === 0) {
        if (entries.length > 0 && !record) this.research.set(key, updateRecord(undefined, entries, [], [], new Date().toISOString()));
        return { asked: false, chosen: record?.ids.length ?? 0, canceled: false };
      }
      const system = researchSystemPrompt(input.sourceLanguage, input.targetLanguage);
      const replyTokens = Math.min(input.maxOutputTokens, 256); // the reply is only a list of numbers
      const room = input.contextLimit - estimateTokens(system) - estimateTokens(input.passage) - replyTokens - DEFAULTS.messageOverheadTokens - 40;
      if (room < 60) throw new UserError("context_overflow", `This block and the knowledge base do not fit the context of ${input.modelId}, which is set to ${input.contextLimit}. Raise the context size for this model (in its settings), or use smaller blocks.`);
      const chosen: string[] = [];
      for (const batch of researchBatches(pending, room)) {
        const reply = await this.askModel(
          {
            backend: input.backend,
            modelId: input.modelId,
            maxOutputTokens: replyTokens,
            messages: [
              { role: "system", content: system },
              { role: "user", content: researchUserMessage(input.passage, batch) },
            ],
            // The practice translator has no judgement: it picks names that appear in the text, and every note.
            practiceReply: () => batch.map((e, i) => (e.kind === "note" || input.passage.includes(e.source) ? i + 1 : 0)).filter(Boolean).join(", ") || "NONE",
          },
          abort,
        );
        if (reply === null) return { asked: true, chosen: 0, canceled: true };
        for (const i of parseResearchReply(reply, batch.length)) chosen.push(batch[i]!.id);
      }
      const next = updateRecord(record, entries, pending, chosen, new Date().toISOString());
      this.research.set(key, next);
      this.refreshOutdated();
      this.notify("state");
      return { asked: true, chosen: next.ids.length, canceled: false };
    } finally {
      this.analysisAbort = null;
    }
  }

  cancelAnalysis(): { canceled: boolean } {
    const was = this.analysisAbort !== null;
    this.analysisAbort?.abort();
    return { canceled: was };
  }

  private makePractice(): FakeProvider {
    const failed = new Set<string>();
    const options: FakeProviderOptions = {
      deltaDelayMs: this.options.speedMs ?? SPEED_MS[this.demo.speed],
      chunk: 3,
      translate: (req) => {
        const user = parseUserMessage(req.messages[1]!.content);
        // Pretend to follow the glossary: swap each term it was sent for its preferred translation.
        let text = user?.sourceBlock ?? "";
        for (const g of user?.glossary ?? []) for (const name of [g.source, ...(g.aliases ?? [])]) text = text.replaceAll(name, g.target);
        return `[practice translation by ${req.modelId}] ${text}`;
      },
      scriptFor: (req) => {
        const failIndex = this.demo.failBlockOnce !== null ? this.demo.failBlockOnce - 1 : -1;
        const latest = this.versions.at(-1)?.revision;
        if (failIndex < 0 || !latest || req.modelId !== this.firstModel) return undefined;
        const key = `${latest.id}:${req.modelId}`;
        if (failed.has(key)) return undefined;
        const sourceBlock = parseUserMessage(req.messages[1]!.content)?.sourceBlock;
        const idx = latest.blocks.findIndex((b) => latest.exactText.slice(b.startOffset, b.endOffset) === sourceBlock);
        if (idx !== failIndex) return undefined;
        failed.add(key);
        return script.partialThenError("[practice translation by " + req.modelId + "] ", providerError("invalid_response", "Practice mode: the server dropped the connection partway through this block."));
      },
    };
    this.practiceOptions = options;
    return new FakeProvider(options);
  }
}

function cellView(o: BlockOutput, outdated: boolean): BlockCellView {
  const cur = currentVersion(o);
  const latest = o.attempts[o.attempts.length - 1];
  const candidate = o.candidate ? o.versions.find((v) => v.id === o.candidate!.versionId) : undefined;
  const unfinishedDraft = latest && latest.state !== "succeeded" && latest.state !== "needs_review" && latest.draft ? latest.draft : null;
  // A reply that is the request written back may have been accepted before such replies were rejected: flag it.
  const echoed = cur !== undefined && looksLikeEcho(cur.text) && (o.state === "succeeded" || o.state === "stale");
  return {
    state: echoed ? "needs_review" : o.state,
    text: cur?.text ?? null,
    draft: unfinishedDraft,
    attempts: o.attempts.length,
    error: o.state === "failed" || o.state === "waiting" ? (latest?.error?.message ?? null) : null,
    candidateText: candidate?.text ?? null,
    reviewNotes: echoed
      ? ["This looks like the request written back, not a translation. Retry this block."]
      : o.state === "needs_review"
        ? (o.attempts.find((a) => a.id === cur?.attemptId)?.notes ?? [])
        : [],
    outdated,
    edited: cur?.kind === "manual",
  };
}
