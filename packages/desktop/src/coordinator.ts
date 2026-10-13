import {
  blockSettingsHash,
  blockText,
  buildPrompt,
  checkTranslation,
  looksLikeEcho,
  contextHashFor,
  currentVersion,
  newId as defaultNewId,
  PROMPT_VERSION,
  usableText,
  type Attempt,
  type BlockOutput,
  type BlockState,
  type GlossaryEntry,
  type ModelRun,
  type PromptSnapshot,
  type RunConfig,
  type SourceRevision,
} from "@ltw/domain";
import {
  enforceContract,
  type GenerateEvent,
  type ProviderConfig,
  type ProviderRegistry,
} from "@ltw/providers";

/**
 * Runs translation jobs. One model request is in flight at any time, across all jobs.
 *
 * Order of work: models in the order they were added, and for each model its blocks from first to
 * last ("model-major"). That keeps a small GPU from swapping models back and forth.
 */

export type CoordinatorEventType = "queued" | "waiting" | "started" | "delta" | "terminal" | "checkpointed" | "stateChanged";

export interface CoordinatorEvent {
  eventVersion: 1;
  seq: number;
  type: CoordinatorEventType;
  jobId?: string;
  runId?: string;
  blockId?: string;
  attemptId?: string;
  payload: Record<string, unknown>;
}

export interface CoordinatorDeps {
  registry: ProviderRegistry;
  /** Looks up the connection settings for a run's provider. */
  providerConfig: (providerRefId: string) => ProviderConfig;
  now?: () => string;
  newId?: () => string;
  /** Resolves true after `ms`, or false if `signal` aborts first. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  random?: () => number;
  /**
   * Called after every finished attempt, before the next request is sent. If it throws (for example
   * the disk is full), the job stops instead of translating more work it cannot save.
   */
  checkpoint?: () => Promise<void>;
  /** Quality checks on finished text: everything (default), glossary terms only, or none. Can depend on the run. */
  checks?: "all" | "terms" | "none" | ((run: ModelRun) => "all" | "terms" | "none");
}

export type JobState = "queued" | "running" | "waiting" | "completed" | "completed_with_issues" | "canceled" | "interrupted";

export interface Job {
  id: string;
  revisionId: string;
  orderedRunIds: string[];
  state: JobState;
  createdAt: string;
  /** Why the job stopped early without being canceled (for example a failed save). */
  stopReason?: string;
}

export interface JobSpec {
  revisionId: string;
  runIds: string[];
  /** Only these blocks (used for single-block retries). */
  blockIds?: string[];
  /** Run blocks even if they already have a result; the result becomes a candidate to accept or reject. */
  retry?: boolean;
  /** Also run blocks marked stale (the "Retranslate downstream" action). */
  includeStale?: boolean;
  /** A finished result replaces the current text if that text was generated, not hand-edited. */
  replaceGenerated?: boolean;
}

export type CancelScope =
  | { kind: "job"; jobId: string }
  | { kind: "run"; runId: string }
  | { kind: "block"; runId: string; blockId: string };

export type WaitResolution = "retry" | "skip";

export interface AddRunInput {
  revisionId: string;
  providerRefId: string;
  modelId: string;
  label: string;
  config?: Partial<RunConfig>;
  glossary?: GlossaryEntry[];
  notes?: string | undefined;
  prompt?: PromptSnapshot;
}

interface JobRuntime {
  job: Job;
  spec: JobSpec;
  cancelRequested: boolean;
  done: Promise<void>;
}

interface RunRuntime {
  cancelRequested: boolean;
  skipRequested: boolean;
}

interface ActiveAttempt {
  jobId: string;
  runId: string;
  blockId: string;
  attempt: Attempt;
  output: BlockOutput;
  controller: AbortController;
}

/** Explains an empty reply in terms of what the user can change. */
export function emptyReplyMessage(reason: string, outputTokens: number | undefined, reasoningSeen: boolean, replyLimit: number): string {
  if (reason === "length") {
    return (
      `The model used up its whole reply limit (${outputTokens ?? replyLimit} tokens) before writing any translation.` +
      (reasoningSeen
        ? ' It was "thinking" first, and thinking text is never added to the translation. Raise "Longest reply", turn thinking off for this model in LM Studio, or use a model that does not think.'
        : ' Raise "Longest reply" or check the model.')
    );
  }
  if (reasoningSeen) {
    return 'The model sent only "thinking" text and no translation. Turn thinking off for this model in LM Studio, or use a model that does not think.';
  }
  return `The model finished without writing anything (it reported: ${reason}). Check that the model is fully loaded and suitable for chat, then Retry.`;
}

const WAIT_CODES = new Set(["connection", "model_unavailable", "auth", "context_overflow"]);
const BACKOFF_MS = [1000, 3000];
const MAX_RETRY_AFTER_MS = 30_000;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class Coordinator {
  private readonly revisions = new Map<string, SourceRevision>();
  private readonly runs = new Map<string, ModelRun>();
  private readonly runtime = new Map<string, RunRuntime>();
  private readonly jobs = new Map<string, JobRuntime>();
  private readonly listeners = new Set<(e: CoordinatorEvent) => void>();
  private readonly waiters = new Map<string, (r: WaitResolution | "canceled") => void>();
  private readonly canceledBlocks = new Set<string>();
  private active: ActiveAttempt | null = null;
  /** The pause between automatic retries, so a cancel can end it at once. */
  private backoff: { jobId: string; runId: string; blockId: string; controller: AbortController } | null = null;
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;

  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
  private readonly random: () => number;

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? defaultNewId;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
  }

  // ---- setup ----

  addRevision(revision: SourceRevision): void {
    this.revisions.set(revision.id, revision);
  }

  addRun(input: AddRunInput): ModelRun {
    const revision = this.revision(input.revisionId);
    const run: ModelRun = {
      id: this.newId(),
      revisionId: input.revisionId,
      providerRefId: input.providerRefId,
      modelId: input.modelId,
      label: input.label,
      config: { temperature: 0.2, maxOutputTokens: 1536, contextLimit: 4096, ...input.config },
      promptVersion: PROMPT_VERSION,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      glossary: input.glossary ?? [],
      ...(input.notes ? { notes: input.notes } : {}),
      state: "queued",
      archived: false,
      outputs: Object.fromEntries(
        revision.blocks.map((b) => [b.id, { blockId: b.id, state: "pending" as BlockState, attempts: [], versions: [] }]),
      ),
    };
    this.runs.set(run.id, run);
    this.runtime.set(run.id, { cancelRequested: false, skipRequested: false });
    return run;
  }

  /** Puts a model run that was loaded from a saved project back into the runner. */
  restoreRun(run: ModelRun): void {
    this.revision(run.revisionId);
    this.runs.set(run.id, structuredClone(run));
    this.runtime.set(run.id, { cancelRequested: false, skipRequested: false });
  }

  /**
   * Brings a run's settings up to date (glossary, style, temperature, limits), so its next attempts use them.
   * Results already produced keep the settings they were made with. Not possible while the run is working.
   */
  updateRunSettings(runId: string, next: { glossary: GlossaryEntry[]; notes?: string | undefined; prompt: PromptSnapshot; config: Partial<RunConfig> }): boolean {
    const run = this.run(runId);
    if (run.state === "running" || run.state === "waiting" || this.active?.runId === runId) return false;
    run.glossary = structuredClone(next.glossary);
    run.notes = next.notes?.trim() ? next.notes.trim() : undefined;
    run.prompt = structuredClone(next.prompt);
    run.config = { ...run.config, ...next.config };
    return true;
  }

  /** Hides a model run from view, cancelling any work it still has queued. Its results are kept. */
  archiveRun(runId: string): void {
    const run = this.run(runId);
    this.cancel({ kind: "run", runId });
    run.archived = true;
    this.emit({ type: "stateChanged", runId, payload: { archived: true } });
  }

  unarchiveRun(runId: string): void {
    this.run(runId).archived = false;
    this.emit({ type: "stateChanged", runId, payload: { archived: false } });
  }

  /** The live run, for quick read-only checks. Do not change it. */
  peekRun(runId: string): ModelRun {
    return this.run(runId);
  }

  /** A copy, safe to read or compare in tests and UI code. */
  snapshotRun(runId: string): ModelRun {
    return structuredClone(this.run(runId));
  }

  snapshotJob(jobId: string): Job {
    return structuredClone(this.jobRuntime(jobId).job);
  }

  onEvent(listener: (e: CoordinatorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when all queued work has finished. */
  async whenIdle(): Promise<void> {
    let t: Promise<void>;
    do {
      t = this.tail;
      await t;
    } while (t !== this.tail);
  }

  // ---- jobs ----

  startJob(spec: JobSpec): { job: Job; done: Promise<void> } {
    this.revision(spec.revisionId);
    for (const id of spec.runIds) {
      const run = this.run(id);
      if (run.revisionId !== spec.revisionId) throw new Error("A model run belongs to one source revision.");
      const rt = this.rt(id);
      rt.cancelRequested = false;
      rt.skipRequested = false;
      for (const key of [...this.canceledBlocks]) if (key.startsWith(`${id}:`)) this.canceledBlocks.delete(key);
    }
    const job: Job = {
      id: this.newId(),
      revisionId: spec.revisionId,
      orderedRunIds: [...spec.runIds],
      state: "queued",
      createdAt: this.now(),
    };
    const runtime: JobRuntime = { job, spec, cancelRequested: false, done: Promise.resolve() };
    this.jobs.set(job.id, runtime);
    this.emit({ type: "queued", jobId: job.id, payload: { runIds: job.orderedRunIds } });
    // Jobs run one after another, so a retry requested during a request waits its turn.
    runtime.done = this.tail = this.tail.then(() => this.processJob(runtime));
    return { job, done: runtime.done };
  }

  /** Adds a model to the end of a job that has not finished yet. */
  appendRun(jobId: string, runId: string): void {
    const j = this.jobRuntime(jobId);
    if (["completed", "completed_with_issues", "canceled", "interrupted"].includes(j.job.state)) {
      throw new Error("That job has already finished; start a new job instead.");
    }
    if (this.run(runId).revisionId !== j.job.revisionId) throw new Error("A model run belongs to one source revision.");
    if (!j.job.orderedRunIds.includes(runId)) j.job.orderedRunIds.push(runId);
    this.emit({ type: "queued", jobId, runId, payload: { appended: true } });
  }

  retryBlock(runId: string, blockId: string, options: { replaceGenerated?: boolean } = {}): { job: Job; done: Promise<void> } {
    const run = this.run(runId);
    return this.startJob({ revisionId: run.revisionId, runIds: [runId], blockIds: [blockId], retry: true, ...(options.replaceGenerated ? { replaceGenerated: true } : {}) });
  }

  /** Runs every failed, canceled or not-yet-run block of a model. */
  retryUnfinished(runId: string): { job: Job; done: Promise<void> } {
    const run = this.run(runId);
    return this.startJob({ revisionId: run.revisionId, runIds: [runId] });
  }

  /** Re-runs blocks marked stale, in source order. Old versions are kept. */
  retranslateDownstream(runId: string): { job: Job; done: Promise<void> } {
    const run = this.run(runId);
    const stale = Object.values(run.outputs).filter((o) => o.state === "stale").map((o) => o.blockId);
    return this.startJob({ revisionId: run.revisionId, runIds: [runId], blockIds: stale, retry: true, replaceGenerated: true });
  }

  // ---- cancel / waiting ----

  cancel(scope: CancelScope): void {
    if (scope.kind === "job") {
      const j = this.jobRuntime(scope.jobId);
      j.cancelRequested = true;
      if (this.active?.jobId === scope.jobId) this.cancelActive();
      if (this.backoff?.jobId === scope.jobId) this.backoff.controller.abort();
      for (const id of j.job.orderedRunIds) this.waiters.get(id)?.("canceled");
    } else if (scope.kind === "run") {
      this.rt(scope.runId).cancelRequested = true;
      if (this.active?.runId === scope.runId) this.cancelActive();
      if (this.backoff?.runId === scope.runId) this.backoff.controller.abort();
      this.waiters.get(scope.runId)?.("canceled");
    } else {
      const key = `${scope.runId}:${scope.blockId}`;
      this.canceledBlocks.add(key);
      if (this.active?.runId === scope.runId && this.active.blockId === scope.blockId) this.cancelActive();
      else if (this.backoff?.runId === scope.runId && this.backoff.blockId === scope.blockId) this.backoff.controller.abort();
      else {
        const out = this.run(scope.runId).outputs[scope.blockId];
        if (out && (out.state === "pending" || out.state === "waiting")) this.setBlockState(scope.runId, out, "canceled");
        if (out?.state === "canceled") this.waiters.get(scope.runId)?.("canceled");
      }
    }
  }

  /** The user fixed the problem (retry) or gave up on this model (skip). */
  resolveWaiting(runId: string, resolution: WaitResolution): void {
    const w = this.waiters.get(runId);
    if (!w) throw new Error("That model is not waiting for anything.");
    w(resolution);
  }

  // ---- results the user decides on ----

  /** Use the retried result as the current text. */
  acceptCandidate(runId: string, blockId: string): void {
    const run = this.run(runId);
    const out = this.output(run, blockId);
    if (!out.candidate) throw new Error("There is no candidate to accept.");
    const attempt = out.attempts.find((a) => a.id === out.candidate!.attemptId);
    out.currentVersionId = out.candidate.versionId;
    delete out.candidate;
    if (attempt && attempt.state === "needs_review") attempt.state = "succeeded"; // the user accepted it
    this.setBlockState(runId, out, "succeeded");
    delete out.staleReason;
    this.recheckDownstream(run, blockId);
  }

  /** Discard the retried result and keep what is there. Both stay in the version history. */
  keepCurrent(runId: string, blockId: string): void {
    const out = this.output(this.run(runId), blockId);
    delete out.candidate;
    this.emit({ type: "stateChanged", runId, blockId, payload: { state: out.state, candidate: false } });
  }

  /** Accept the current text of a block flagged "needs review". */
  acceptReview(runId: string, blockId: string): void {
    const run = this.run(runId);
    const out = this.output(run, blockId);
    if (out.state !== "needs_review") throw new Error("This block is not waiting for review.");
    const v = currentVersion(out);
    const attempt = out.attempts.find((a) => a.id === v?.attemptId);
    if (attempt) attempt.state = "succeeded";
    this.setBlockState(runId, out, "succeeded");
    this.recheckDownstream(run, blockId);
  }

  /** The user edits a finished block. The model's text stays in the history. */
  editBlock(runId: string, blockId: string, text: string): void {
    const run = this.run(runId);
    const out = this.output(run, blockId);
    const base = currentVersion(out);
    if (!base) throw new Error("Only blocks with a result can be edited.");
    if (this.active?.runId === runId && this.active.blockId === blockId) throw new Error("This block is still being translated.");
    const version = { id: this.newId(), blockId, kind: "manual" as const, text, createdAt: this.now(), baseVersionId: base.id };
    out.versions.push(version);
    out.currentVersionId = version.id;
    if (out.state === "needs_review") this.setBlockState(runId, out, "succeeded");
    else this.emit({ type: "stateChanged", runId, blockId, payload: { state: out.state, edited: true } });
    this.recheckDownstream(run, blockId);
  }

  // ---- internals: job loop ----

  private async processJob(j: JobRuntime): Promise<void> {
    const { job } = j;
    if (j.cancelRequested) return this.finishJob(j);
    this.setJobState(job, "running");
    for (let i = 0; i < job.orderedRunIds.length; i++) {
      if (j.cancelRequested || job.stopReason) break;
      const run = this.runs.get(job.orderedRunIds[i]!);
      if (!run || run.archived) continue;
      await this.processRun(j, run);
    }
    this.finishJob(j);
  }

  private selected(j: JobRuntime, out: BlockOutput): boolean {
    const { spec } = j;
    if (spec.blockIds && !spec.blockIds.includes(out.blockId)) return false;
    if (spec.retry) return true;
    const open: BlockState[] = ["pending", "waiting", "failed", "canceled"];
    if (spec.includeStale) open.push("stale");
    return open.includes(out.state);
  }

  private async processRun(j: JobRuntime, run: ModelRun): Promise<void> {
    const rt = this.rt(run.id);
    const revision = this.revision(run.revisionId);
    run.state = "running";
    this.emit({ type: "stateChanged", jobId: j.job.id, runId: run.id, payload: { runState: "running" } });
    for (const block of revision.blocks) {
      if (j.cancelRequested || rt.cancelRequested || rt.skipRequested || j.job.stopReason) break;
      const out = run.outputs[block.id]!;
      if (!this.selected(j, out)) continue;
      if (this.canceledBlocks.has(`${run.id}:${block.id}`)) continue;
      await this.executeBlock(j, run, revision, block.index, out);
    }
  }

  private finishJob(j: JobRuntime): void {
    const { job } = j;
    let issues = false;
    for (const id of job.orderedRunIds) {
      const run = this.runs.get(id);
      if (!run) continue;
      const rt = this.rt(id);
      const wasCanceled = j.cancelRequested || rt.cancelRequested || rt.skipRequested;
      for (const out of Object.values(run.outputs)) {
        const mine = this.selected(j, out) && !this.canceledBlocks.has(`${id}:${out.blockId}`);
        if (wasCanceled && mine && (out.state === "pending" || out.state === "waiting")) this.setBlockState(id, out, "canceled");
      }
      const states = Object.values(run.outputs).map((o) => o.state);
      const allDone = states.every((s) => s === "succeeded");
      if (j.cancelRequested || rt.cancelRequested) run.state = "canceled";
      else if (job.stopReason && states.some((s) => s === "pending" || s === "waiting")) run.state = "interrupted";
      else run.state = allDone ? "completed" : "completed_with_issues";
      if (run.state !== "completed") issues = true;
      this.emit({ type: "stateChanged", jobId: job.id, runId: id, payload: { runState: run.state } });
    }
    if (j.cancelRequested) this.setJobState(job, "canceled");
    else if (job.stopReason) this.setJobState(job, "interrupted");
    else this.setJobState(job, issues ? "completed_with_issues" : "completed");
  }

  private async executeBlock(j: JobRuntime, run: ModelRun, revision: SourceRevision, index: number, out: BlockOutput): Promise<void> {
    const rt = this.rt(run.id);
    const block = revision.blocks[index]!;
    const key = `${run.id}:${block.id}`;
    const stopped = () => j.cancelRequested || rt.cancelRequested || rt.skipRequested || this.canceledBlocks.has(key);
    const priorState = out.state;
    let transientRetries = 0;

    for (;;) {
      if (stopped()) return;
      const previous = index > 0 ? run.outputs[revision.blocks[index - 1]!.id] : undefined;
      const built = buildPrompt(revision, index, run, previous);
      const attempt: Attempt = {
        id: this.newId(),
        ordinal: out.attempts.length + 1,
        configHash: built.configHash,
        sourceHash: built.sourceHash,
        contextHash: built.contextHash,
        settingsHash: blockSettingsHash(revision, index, run),
        state: "pending",
      };
      out.attempts.push(attempt);

      if (!built.fits) {
        attempt.state = "failed";
        attempt.endedAt = this.now();
        attempt.error = { code: "preflight", message: built.problem ?? "The block does not fit." };
        this.setBlockState(run.id, out, "failed");
        this.emit({ type: "terminal", jobId: j.job.id, runId: run.id, blockId: block.id, attemptId: attempt.id, payload: { state: "failed", error: attempt.error } });
        await this.checkpoint(j);
        return;
      }

      const result = await this.sendOnce(j, run, out, attempt, built.messages);
      if (result.kind === "canceled") {
        await this.checkpoint(j);
        return;
      }
      if (result.kind === "done") {
        if (attempt.state === "succeeded") this.runChecks(run, revision, block.index, attempt);
        if (attempt.state === "succeeded" || attempt.state === "needs_review") this.commit(j, run, index, out, attempt, priorState);
        await this.checkpoint(j);
        return;
      }
      await this.checkpoint(j);
      if (j.job.stopReason) return;

      if (result.kind === "transient") {
        if (transientRetries >= BACKOFF_MS.length) {
          this.setBlockState(run.id, out, "failed");
          return;
        }
        const base = result.retryAfterMs !== undefined ? Math.min(result.retryAfterMs, MAX_RETRY_AFTER_MS) : BACKOFF_MS[transientRetries]!;
        const delay = Math.round(base * (0.85 + this.random() * 0.3));
        transientRetries++;
        const controller = new AbortController();
        this.backoff = { jobId: j.job.id, runId: run.id, blockId: block.id, controller };
        const finished = await this.sleep(delay, controller.signal);
        this.backoff = null;
        if (!finished || stopped()) {
          this.setBlockState(run.id, out, "canceled");
          return;
        }
        continue;
      }

      // result.kind === "wait": the user has to fix something (server down, model not loaded, bad key...).
      const resolution = await this.waitForUser(j, run, out, result.code, result.message);
      if (resolution === "retry") {
        transientRetries = 0;
        continue;
      }
      if (resolution === "skip") rt.skipRequested = true;
      return;
    }
  }

  private waitForUser(j: JobRuntime, run: ModelRun, out: BlockOutput, code: string, message: string): Promise<WaitResolution | "canceled"> {
    run.state = "waiting";
    this.setJobState(j.job, "waiting");
    this.setBlockState(run.id, out, "waiting");
    this.emit({ type: "waiting", jobId: j.job.id, runId: run.id, blockId: out.blockId, payload: { code, message } });
    return new Promise((resolve) => {
      this.waiters.set(run.id, (r) => {
        this.waiters.delete(run.id);
        run.state = "running";
        if (j.job.state === "waiting") this.setJobState(j.job, "running");
        resolve(r);
      });
    });
  }

  // ---- internals: one request ----

  private async sendOnce(
    j: JobRuntime,
    run: ModelRun,
    out: BlockOutput,
    attempt: Attempt,
    messages: { role: "system" | "user"; content: string }[],
  ): Promise<
    | { kind: "done" }
    | { kind: "canceled" }
    | { kind: "transient"; retryAfterMs?: number }
    | { kind: "wait"; code: string; message: string }
  > {
    const controller = new AbortController();
    const active: ActiveAttempt = { jobId: j.job.id, runId: run.id, blockId: out.blockId, attempt, output: out, controller };
    this.active = active;
    attempt.state = "running";
    attempt.startedAt = this.now();
    attempt.draft = "";
    this.setBlockState(run.id, out, "running");
    this.emit({ type: "started", jobId: j.job.id, runId: run.id, blockId: out.blockId, attemptId: attempt.id, payload: { ordinal: attempt.ordinal } });

    const live = () => this.active === active && attempt.state === "running";
    const aborted = new Promise<"aborted">((resolve) => controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));

    let draft = "";
    let terminal: Exclude<GenerateEvent, { type: "delta" }> | undefined;
    try {
      const provider = this.deps.registry.get(this.deps.providerConfig(run.providerRefId).kind);
      const config = this.deps.providerConfig(run.providerRefId);
      const stream = enforceContract(
        provider.generate(
          config,
          {
            requestId: attempt.id,
            modelId: run.modelId,
            messages,
            temperature: run.config.temperature,
            maxOutputTokens: run.config.maxOutputTokens,
            stream: true,
          },
          controller.signal,
        ),
      );
      const it = stream[Symbol.asyncIterator]();
      try {
        for (;;) {
          // Race against cancel, so a server that ignores the cancel cannot freeze the queue.
          const next = await Promise.race([it.next(), aborted]);
          if (next === "aborted" || !live()) break;
          if (next.done) break;
          const ev = next.value;
          if (ev.type === "delta") {
            draft += ev.text;
            attempt.draft = draft;
            this.emit({ type: "delta", jobId: j.job.id, runId: run.id, blockId: out.blockId, attemptId: attempt.id, payload: { text: ev.text } });
          } else {
            terminal = ev;
            break;
          }
        }
      } finally {
        // Always close the stream so the connection to the model server is released.
        void it.return?.(undefined).catch(() => {});
      }
    } catch (e) {
      terminal = {
        type: "error",
        error: { code: "server", message: e instanceof Error ? e.message : "Unexpected failure.", retryable: false },
      };
    }

    // A late result after cancel is ignored: the attempt is already closed.
    if (!live()) {
      if (this.active === active) this.active = null;
      return { kind: "canceled" };
    }
    this.active = null;
    attempt.endedAt = this.now();
    attempt.rawOutput = draft;

    if (terminal?.type === "finish") {
      if (terminal.usage) attempt.usage = terminal.usage;
      attempt.finishReason = terminal.reason;
      if (draft.trim() === "") {
        this.failAttempt(j, run, out, attempt, {
          code: "invalid_response",
          message: emptyReplyMessage(terminal.reason, terminal.usage?.outputTokens ?? undefined, terminal.reasoningSeen === true, run.config.maxOutputTokens),
        });
        this.setBlockState(run.id, out, "failed");
        return { kind: "done" };
      }
      if (looksLikeEcho(draft)) {
        // The model wrote the request back instead of translating. Keeping it would also poison the next block's context.
        this.failAttempt(j, run, out, attempt, {
          code: "echoed_request",
          message: "The model repeated the request (JSON or its labels) instead of translating. Retry, or try another style or model.",
        });
        this.setBlockState(run.id, out, "failed");
        return { kind: "done" };
      }
      attempt.state = terminal.reason === "stop" ? "succeeded" : "needs_review";
      return { kind: "done" };
    }

    const error = terminal?.type === "error" ? terminal.error : { code: "invalid_response" as const, message: "The stream ended unexpectedly.", retryable: false };
    this.failAttempt(j, run, out, attempt, {
      code: error.code,
      message: error.message,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    });
    const beforeContent = draft === "";
    if (WAIT_CODES.has(error.code) && beforeContent) return { kind: "wait", code: error.code, message: error.message };
    if (error.retryable && beforeContent) {
      return error.retryAfterMs !== undefined ? { kind: "transient", retryAfterMs: error.retryAfterMs } : { kind: "transient" };
    }
    this.setBlockState(run.id, out, error.code === "canceled" ? "canceled" : "failed");
    return { kind: "done" };
  }

  private failAttempt(j: JobRuntime, run: ModelRun, out: BlockOutput, attempt: Attempt, error: { code: string; message: string; httpStatus?: number }): void {
    attempt.state = "failed";
    attempt.error = error;
    this.emit({ type: "terminal", jobId: j.job.id, runId: run.id, blockId: out.blockId, attemptId: attempt.id, payload: { state: "failed", error } });
  }

  /**
   * Quality checks on text the model finished normally: missing glossary terms, possible commentary,
   * untranslated text. They only flag the block for review (with reasons); the user can accept it.
   */
  private runChecks(run: ModelRun, revision: SourceRevision, index: number, attempt: Attempt): void {
    const configured = this.deps.checks ?? "all";
    const mode = typeof configured === "function" ? configured(run) : configured;
    if (mode === "none") return;
    const notes = checkTranslation({
      source: blockText(revision, revision.blocks[index]!),
      output: attempt.rawOutput ?? "",
      glossary: run.glossary,
      targetLanguage: revision.targetLanguage,
      mode,
    });
    if (notes.length > 0) {
      attempt.state = "needs_review";
      attempt.notes = notes;
    }
  }

  /** Stores a finished result. Existing text is never overwritten unless the job says generated text may be replaced. */
  private commit(j: JobRuntime, run: ModelRun, index: number, out: BlockOutput, attempt: Attempt, priorState: BlockState): void {
    const text = attempt.rawOutput ?? "";
    const version = { id: this.newId(), blockId: out.blockId, attemptId: attempt.id, kind: "generated" as const, text, createdAt: this.now() };
    out.versions.push(version);
    const existing = currentVersion(out);
    const replace = !existing || (j.spec.replaceGenerated === true && existing.kind === "generated");

    if (replace) {
      out.currentVersionId = version.id;
      delete out.candidate;
      delete out.staleReason;
      this.setBlockState(run.id, out, attempt.state === "succeeded" ? "succeeded" : "needs_review");
    } else {
      out.candidate = { attemptId: attempt.id, versionId: version.id };
      this.setBlockState(run.id, out, priorState === "stale" || priorState === "needs_review" ? priorState : "succeeded");
    }
    this.emit({
      type: "terminal",
      jobId: j.job.id,
      runId: run.id,
      blockId: out.blockId,
      attemptId: attempt.id,
      payload: { state: attempt.state, candidate: !replace },
    });
    if (replace && usableText(out) !== null) this.recheckDownstream(run, out.blockId, index);
  }

  /**
   * After a block's accepted text changes, work out what context the NEXT block would get now.
   * If it differs from what that block was translated with, the next block is stale.
   * Only the next block is checked; if it is retranslated and changes, the check moves on from there.
   */
  private recheckDownstream(run: ModelRun, blockId: string, knownIndex?: number): void {
    const revision = this.revision(run.revisionId);
    const index = knownIndex ?? revision.blocks.findIndex((b) => b.id === blockId);
    const nextBlock = revision.blocks[index + 1];
    if (!nextBlock) return;
    const next = run.outputs[nextBlock.id]!;
    const produced = this.producingAttempt(next);
    if (!produced) return;
    const now = contextHashFor(revision, index + 1, run, run.outputs[blockId]);
    if (now !== produced.contextHash) {
      if (next.state === "succeeded") {
        next.staleReason = "context_changed";
        this.setBlockState(run.id, next, "stale");
      }
    } else if (next.state === "stale" && next.staleReason === "context_changed") {
      delete next.staleReason;
      this.setBlockState(run.id, next, "succeeded");
    }
  }

  private producingAttempt(out: BlockOutput): Attempt | undefined {
    let v = currentVersion(out);
    while (v && !v.attemptId && v.baseVersionId) {
      const base = v.baseVersionId;
      v = out.versions.find((x) => x.id === base);
    }
    return out.attempts.find((a) => a.id === v?.attemptId);
  }

  private cancelActive(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    a.attempt.state = "canceled";
    a.attempt.endedAt = this.now();
    a.attempt.error = { code: "canceled", message: "Canceled." };
    // The partial text stays on the attempt, marked incomplete by its state. It is never an accepted version.
    this.setBlockState(a.runId, a.output, "canceled");
    this.emit({ type: "terminal", jobId: a.jobId, runId: a.runId, blockId: a.blockId, attemptId: a.attempt.id, payload: { state: "canceled" } });
    a.controller.abort();
  }

  private async checkpoint(j: JobRuntime): Promise<void> {
    if (!this.deps.checkpoint) return;
    try {
      await this.deps.checkpoint();
      this.emit({ type: "checkpointed", jobId: j.job.id, payload: {} });
    } catch (e) {
      j.job.stopReason = `Could not save progress: ${e instanceof Error ? e.message : String(e)}`;
      this.emit({ type: "stateChanged", jobId: j.job.id, payload: { stopReason: j.job.stopReason } });
    }
  }

  // ---- internals: small helpers ----

  private setBlockState(runId: string, out: BlockOutput, state: BlockState): void {
    out.state = state;
    this.emit({ type: "stateChanged", runId, blockId: out.blockId, payload: { state } });
  }

  private setJobState(job: Job, state: JobState): void {
    if (job.state === state) return;
    job.state = state;
    this.emit({ type: "stateChanged", jobId: job.id, payload: { jobState: state } });
  }

  private emit(e: Omit<CoordinatorEvent, "eventVersion" | "seq">): void {
    const event: CoordinatorEvent = { eventVersion: 1, seq: ++this.seq, ...e };
    for (const l of this.listeners) l(event);
  }

  private revision(id: string): SourceRevision {
    const r = this.revisions.get(id);
    if (!r) throw new Error(`Unknown source revision ${id}`);
    return r;
  }
  private run(id: string): ModelRun {
    const r = this.runs.get(id);
    if (!r) throw new Error(`Unknown model run ${id}`);
    return r;
  }
  private rt(id: string): RunRuntime {
    const r = this.runtime.get(id);
    if (!r) throw new Error(`Unknown model run ${id}`);
    return r;
  }
  private jobRuntime(id: string): JobRuntime {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Unknown job ${id}`);
    return j;
  }
  private output(run: ModelRun, blockId: string): BlockOutput {
    const o = run.outputs[blockId];
    if (!o) throw new Error(`Unknown block ${blockId}`);
    return o;
  }
}

