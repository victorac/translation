import {
  allPrompts,
  BLOCK_SIZES,
  chunkSource,
  createRevision,
  currentVersion,
  DEFAULTS,
  describeSplit,
  estimateTokens,
  normalizeGlossary,
  normalizeSource,
  planChunking,
  preflightRevision,
  renderPrompt,
  RevisionError,
  runLabel,
  snapshotPrompt,
  validatePrompt,
  type Backend,
  type BlockCellView,
  type BlockOutput,
  type CancelInput,
  type DemoOptions,
  type GlossaryEntry,
  type ModelRun,
  type ProjectVersion,
  type ProjectView,
  type PromptPreset,
  type SourceRevision,
  type SplitPreview,
  type StartJobInput,
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
import { UserError } from "./errors.js";
import type { ProviderService } from "./provider-service.js";

export { UserError };

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

export type ChangeKind = "state" | "delta";

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
  private versions: Version[] = [];
  private viewId: string | null = null;
  private jobIds: string[] = [];
  private waitingInfo = new Map<string, { code: string; message: string }>();
  private firstModel = "";
  private listeners = new Set<(kind: ChangeKind) => void>();

  constructor(private readonly options: ServiceOptions = {}) {}

  get hasRevision(): boolean {
    return this.versions.length > 0;
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

  /** Checks what the user asked for and works out the runs. Throws plain-language errors. */
  private validate(input: StartJobInput): RunPlan[] {
    const named = input.models.map((m) => ({ ...m, name: m.name.trim() })).filter((m) => m.name !== "");
    if (named.length === 0) throw new UserError("no_models", "Add at least one model.");
    if (named.length > MAX_MODELS) throw new UserError("too_many_models", `At most ${MAX_MODELS} model runs per version of the text.`);

    if (input.prompts.length > 20) throw new UserError("too_many_prompts", "At most 20 custom prompts.");
    for (const p of input.prompts) {
      const problem = validatePrompt(p);
      if (problem) throw new UserError("bad_prompt", problem);
    }
    const styles = allPrompts(input.prompts);
    const glossary = normalizeGlossary(input.glossary);
    if (glossary.problems.length > 0) throw new UserError("bad_glossary", glossary.problems[0]!);

    const plans = named.map((m) => {
      const style = styles.find((p) => p.id === m.promptId);
      if (!style) throw new UserError("unknown_prompt", `${m.name}: the chosen prompt no longer exists.`);
      if (m.maxOutputTokens >= m.contextLimit) throw new UserError("bad_limits", `${m.name}: the output limit must be smaller than the context size.`);
      return {
        name: m.name,
        label: runLabel(m, styles, glossary.entries.length),
        contextLimit: m.contextLimit,
        maxOutputTokens: m.maxOutputTokens,
        temperature: m.temperature,
        style,
        glossary: m.useGlossary ? glossary.entries : [],
      };
    });
    if (new Set(plans.map((p) => p.label)).size !== plans.length) {
      throw new UserError("duplicate_models", "Each combination of model, prompt and glossary setting can only be used once.");
    }
    return plans;
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
    // Runs the user asked to redo are replaced by fresh ones (the old results stay in the project, out of view).
    for (const label of input.rerun) {
      const old = this.activeRuns(coordinator, version).find((r) => r.label === label);
      if (old) coordinator.archiveRun(old.id);
    }
    const toRun: string[] = [];
    for (const p of plans) {
      const existing = this.activeRuns(coordinator, version).find((r) => r.label === p.label);
      if (existing) {
        if (Object.values(existing.outputs).some((o) => ["pending", "failed", "canceled", "waiting"].includes(o.state))) toRun.push(existing.id);
        continue;
      }
      const issues = preflightRevision(version.revision, [this.budgetInput(p, input)]);
      if (issues.length > 0) throw new UserError("budget", issues[0]!.message);
      if (this.activeRuns(coordinator, version).length >= MAX_MODELS) throw new UserError("too_many_models", `At most ${MAX_MODELS} model runs per version of the text.`);
      const id = this.addRun(coordinator, version.revision, p, input.backend);
      version.runIds.push(id);
      toRun.push(id);
    }
    this.viewId = version.id;
    if (toRun.length === 0) {
      this.notify("state");
      throw new UserError("nothing_to_do", "Everything is already translated. Edit the text, add a model, or retry a block.");
    }
    this.trackJob(coordinator.startJob({ revisionId: version.revision.id, runIds: toRun }).job.id);
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
    }).id;
  }

  private activeRuns(coordinator: Coordinator, version: Version): ModelRun[] {
    return version.runIds.map((id) => coordinator.snapshotRun(id)).filter((r) => !r.archived);
  }

  /** What one model run needs to know to work out how large a block may be. */
  private budgetInput(p: { label: string; contextLimit: number; maxOutputTokens: number; style: { template: string; appendFraming: boolean }; glossary: GlossaryEntry[] }, input: Pick<StartJobInput, "sourceLanguage" | "targetLanguage">) {
    return {
      label: p.label,
      contextLimit: p.contextLimit,
      outputReserve: p.maxOutputTokens,
      systemTokens: estimateTokens(renderPrompt(p.style, input.sourceLanguage, input.targetLanguage)),
      glossaryTokens: estimateTokens(JSON.stringify(p.glossary)),
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
    const glossary = normalizeGlossary(input.glossary).entries;
    const plans = input.models
      .filter((m) => m.name.trim() !== "")
      .map((m) => {
        const style = styles.find((p) => p.id === m.promptId) ?? styles[0]!;
        return { ...m, label: runLabel({ ...m, promptId: style.id }, styles, glossary.length), style, glossary: m.useGlossary ? glossary : [] };
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
    const v = this.versions.find((x) => x.runIds.includes(runId));
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

  /** Everything a project file needs: every version, with every run including removed ones. */
  exportAll(): ProjectVersion[] {
    const c = this.coordinator;
    if (this.versions.length === 0 || !c) throw new UserError("nothing_to_save", "There is nothing to save yet.");
    return this.versions.map((v) => ({ source: v.revision, backend: v.backend, createdAt: v.createdAt, runs: v.runIds.map((id) => c.snapshotRun(id)) }));
  }

  /** Replaces the open workspace with saved versions (already checked and settled by the caller). */
  restore(versions: ProjectVersion[]): void {
    if (this.snapshot().busy) throw new UserError("busy", "Cancel the running translation first.");
    if (!this.options.provider && versions.some((v) => v.runs.some((r) => r.providerRefId === "main"))) {
      throw new UserError("no_provider", "This project needs a model server connection, which is not set up.");
    }
    this.clear();
    const coordinator = this.ensureCoordinator();
    for (const v of versions) {
      coordinator.addRevision(v.source);
      for (const run of v.runs) coordinator.restoreRun(run);
      this.versions.push({ id: v.source.id, number: this.versions.length + 1, revision: v.source, backend: v.backend, runIds: v.runs.map((r) => r.id), createdAt: v.createdAt ?? new Date().toISOString() });
    }
    this.viewId = this.versions.at(-1)?.id ?? null;
    this.firstModel = versions.at(-1)?.runs[0]?.modelId ?? "";
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
    this.versions = [];
    this.viewId = null;
    this.jobIds = [];
    this.waitingInfo.clear();
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
    this.trackJob(this.need().retryBlock(runId, blockId).job.id);
    return this.snapshot();
  }
  retryUnfinished(runId: string): WorkspaceSnapshot {
    this.trackJob(this.need().retryUnfinished(runId).job.id);
    return this.snapshot();
  }
  retranslateDownstream(runId: string): WorkspaceSnapshot {
    this.trackJob(this.need().retranslateDownstream(runId).job.id);
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
    const base = { versions: [], latestText: null, viewingId: null, latestId: null, archived: [], job: null, backend: null, busy: false, waiting: null, demoModelUnloaded: false, project };
    if (!c || !view) return { ...base, revision: null, runs: [] };

    const all = view.runIds.map((id) => c.snapshotRun(id));
    const runs = all.filter((r) => !r.archived);
    const jobs = this.jobIds.map((id) => c.snapshotJob(id));
    const last = jobs.at(-1);
    const busy = jobs.some((j) => ["queued", "running", "waiting"].includes(j.state));
    const waitingRun = this.versions.flatMap((v) => v.runIds).map((id) => c.snapshotRun(id)).find((r) => r.state === "waiting" && !r.archived);
    const info = waitingRun ? this.waitingInfo.get(waitingRun.id) : undefined;
    const revision = view.revision;
    return {
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
      runs: runs.map((r) => ({
        id: r.id,
        versionId: view.id,
        label: r.label,
        settings: {
          modelId: r.modelId,
          contextLimit: r.config.contextLimit,
          maxOutputTokens: r.config.maxOutputTokens,
          temperature: r.config.temperature,
          promptId: r.prompt?.id ?? "standard",
          useGlossary: r.glossary.length > 0,
        },
        promptName: r.prompt?.name ?? "Standard",
        state: r.state,
        blocks: Object.fromEntries(Object.entries(r.outputs).map(([id, o]) => [id, cellView(o)])),
      })),
      archived: all.filter((r) => r.archived).map((r) => ({ runId: r.id, label: r.label })),
      backend: this.versions.at(-1)!.backend,
      job: last ? { id: last.id, state: last.state, ...(last.stopReason ? { stopReason: last.stopReason } : {}) } : null,
      busy,
      waiting: waitingRun ? { runId: waitingRun.id, label: waitingRun.label, code: info?.code ?? "waiting", message: info?.message ?? "Waiting for the model." } : null,
      demoModelUnloaded: !!this.practice && this.demo.firstModelUnloaded && this.practice.isUnavailable(this.firstModel),
      project,
    };
  }

  // ---- internals ----

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

  private makePractice(): FakeProvider {
    const failed = new Set<string>();
    const options: FakeProviderOptions = {
      deltaDelayMs: this.options.speedMs ?? SPEED_MS[this.demo.speed],
      chunk: 3,
      translate: (req) => {
        const user = JSON.parse(req.messages[1]!.content) as { source_block: string; glossary?: { source: string; target: string }[] };
        // Pretend to follow the glossary: swap each term it was sent for its preferred translation.
        let text = user.source_block;
        for (const g of user.glossary ?? []) text = text.replaceAll(g.source, g.target.split("|")[0]!.trim());
        return `[practice translation by ${req.modelId}] ${text}`;
      },
      scriptFor: (req) => {
        const failIndex = this.demo.failBlockOnce !== null ? this.demo.failBlockOnce - 1 : -1;
        const latest = this.versions.at(-1)?.revision;
        if (failIndex < 0 || !latest || req.modelId !== this.firstModel) return undefined;
        const key = `${latest.id}:${req.modelId}`;
        if (failed.has(key)) return undefined;
        const user = JSON.parse(req.messages[1]!.content) as { source_block: string };
        const idx = latest.blocks.findIndex((b) => latest.exactText.slice(b.startOffset, b.endOffset) === user.source_block);
        if (idx !== failIndex) return undefined;
        failed.add(key);
        return script.partialThenError("[practice translation by " + req.modelId + "] ", providerError("invalid_response", "Practice mode: the server dropped the connection partway through this block."));
      },
    };
    this.practiceOptions = options;
    return new FakeProvider(options);
  }
}

function cellView(o: BlockOutput): BlockCellView {
  const cur = currentVersion(o);
  const latest = o.attempts[o.attempts.length - 1];
  const candidate = o.candidate ? o.versions.find((v) => v.id === o.candidate!.versionId) : undefined;
  const unfinishedDraft = latest && latest.state !== "succeeded" && latest.state !== "needs_review" && latest.draft ? latest.draft : null;
  return {
    state: o.state,
    text: cur?.text ?? null,
    draft: unfinishedDraft,
    attempts: o.attempts.length,
    error: o.state === "failed" || o.state === "waiting" ? (latest?.error?.message ?? null) : null,
    candidateText: candidate?.text ?? null,
    reviewNotes: o.state === "needs_review" ? (o.attempts.find((a) => a.id === cur?.attemptId)?.notes ?? []) : [],
    edited: cur?.kind === "manual",
  };
}
