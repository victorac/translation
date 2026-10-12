import {
  createRevision,
  currentVersion,
  estimateTokens,
  planChunking,
  renderSystemPrompt,
  RevisionError,
  type BlockCellView,
  type BlockOutput,
  type CancelInput,
  type DemoOptions,
  type SourceRevision,
  type StartJobInput,
  type WorkspaceSnapshot,
} from "@ltw/domain";
import { FakeProvider, ProviderRegistry, providerError, script } from "@ltw/providers";
import { Coordinator, type CoordinatorEvent } from "./coordinator.js";

/** A problem the user can fix (empty text, no models...). Shown as a message, not a crash. */
export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}

const SPEED_MS = { fast: 4, normal: 35, slow: 140 } as const;
const MAX_MODELS = 8;

export interface ServiceOptions {
  /** Override the practice translator's speed (tests use 0). */
  speedMs?: number;
}

/**
 * The background side of the app for one open workspace: it owns the job runner and, for now, the
 * practice translator. Every window action ends up in one of these methods.
 */
export class WorkspaceService {
  private coordinator: Coordinator | null = null;
  private provider: FakeProvider | null = null;
  private revision: SourceRevision | null = null;
  private runIds: string[] = [];
  private jobId: string | null = null;
  private waitingInfo = new Map<string, { code: string; message: string }>();
  private demoModelUnloaded = false;
  private firstModel = "";
  private listeners = new Set<() => void>();

  constructor(private readonly options: ServiceOptions = {}) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when all queued work is done (for tests). */
  async whenIdle(): Promise<void> {
    await this.coordinator?.whenIdle();
  }

  start(input: StartJobInput): WorkspaceSnapshot {
    if (this.snapshot().busy) throw new UserError("busy", "A translation is already running. Cancel it first.");
    const models = input.models.map((m) => m.trim()).filter(Boolean);
    if (models.length === 0) throw new UserError("no_models", "Add at least one model.");
    if (models.length > MAX_MODELS) throw new UserError("too_many_models", `At most ${MAX_MODELS} models per source.`);
    if (new Set(models).size !== models.length) throw new UserError("duplicate_models", "Each model name must be different.");
    if (input.text.trim() === "") throw new UserError("empty", "Paste some text to translate first.");

    const system = estimateTokens(renderSystemPrompt(input.sourceLanguage, input.targetLanguage));
    const plan = planChunking(models.map((label) => ({ label, contextLimit: 4096, outputReserve: 1536, systemTokens: system, glossaryTokens: 0 })));
    if (!plan.ok) throw new UserError("budget", plan.issues[0]?.message ?? "The prompt does not fit the model.");
    const small = input.demo.smallBlocks;
    let revision: SourceRevision;
    try {
      revision = createRevision({
        text: input.text,
        sourceLanguage: input.sourceLanguage.trim() || "the source language",
        targetLanguage: input.targetLanguage.trim() || "the target language",
        targetTokens: small ? 40 : plan.targetTokens,
        maxTokens: small ? 60 : plan.maxTokens,
      });
    } catch (e) {
      if (e instanceof RevisionError) throw new UserError(e.code, e.message);
      throw e;
    }

    this.revision = revision;
    this.firstModel = models[0]!;
    this.demoModelUnloaded = input.demo.firstModelUnloaded;
    this.waitingInfo.clear();
    this.queuedJobIds = [];
    this.provider = this.makeProvider(revision, input.demo);
    const registry = new ProviderRegistry().register(this.provider);
    const coordinator = new Coordinator({ registry, providerConfig: () => ({ id: "practice", kind: "fake", baseUrl: "http://localhost:1234/v1" }) });
    coordinator.addRevision(revision);
    coordinator.onEvent((e) => this.onCoordinatorEvent(e));
    this.coordinator = coordinator;
    this.runIds = models.map((label) => coordinator.addRun({ revisionId: revision.id, providerRefId: "practice", modelId: label, label }).id);
    this.jobId = coordinator.startJob({ revisionId: revision.id, runIds: this.runIds }).job.id;
    return this.snapshot();
  }

  reset(): WorkspaceSnapshot {
    if (this.snapshot().busy) throw new UserError("busy", "Cancel the running translation before editing the source.");
    this.coordinator = null;
    this.provider = null;
    this.revision = null;
    this.runIds = [];
    this.jobId = null;
    this.queuedJobIds = [];
    this.waitingInfo.clear();
    this.notify();
    return this.snapshot();
  }

  cancel(input: CancelInput): WorkspaceSnapshot {
    const c = this.need();
    if (input.kind === "job") {
      if (this.jobId) c.cancel({ kind: "job", jobId: this.jobId });
      // Also stop later jobs (retries) that are queued behind the current one.
      for (const id of this.queuedJobIds) c.cancel({ kind: "job", jobId: id });
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
    this.provider?.setUnavailable(this.firstModel, false);
    this.demoModelUnloaded = false;
    this.notify();
    return this.snapshot();
  }

  snapshot(): WorkspaceSnapshot {
    const c = this.coordinator;
    const revision = this.revision;
    if (!c || !revision) {
      return { revision: null, runs: [], job: null, busy: false, waiting: null, demoModelUnloaded: false };
    }
    const runs = this.runIds.map((id) => c.snapshotRun(id));
    const job = this.jobId ? c.snapshotJob(this.jobId) : null;
    const jobs = [this.jobId, ...this.queuedJobIds].filter((x): x is string => !!x).map((id) => c.snapshotJob(id));
    const busy = jobs.some((j) => ["queued", "running", "waiting"].includes(j.state));
    const waitingRun = runs.find((r) => r.state === "waiting");
    const info = waitingRun ? this.waitingInfo.get(waitingRun.id) : undefined;
    return {
      revision: {
        id: revision.id,
        sourceLanguage: revision.sourceLanguage,
        targetLanguage: revision.targetLanguage,
        blocks: revision.blocks.map((b) => ({
          id: b.id,
          index: b.index,
          text: revision.exactText.slice(b.startOffset, b.endOffset),
          estimatedTokens: b.estimatedTokens,
          boundaryKind: b.boundaryKind,
        })),
      },
      runs: runs.map((r) => ({
        id: r.id,
        label: r.label,
        state: r.state,
        blocks: Object.fromEntries(Object.entries(r.outputs).map(([id, o]) => [id, cellView(o)])),
      })),
      job: job ? { id: job.id, state: job.state, ...(job.stopReason ? { stopReason: job.stopReason } : {}) } : null,
      busy,
      waiting: waitingRun ? { runId: waitingRun.id, label: waitingRun.label, code: info?.code ?? "waiting", message: info?.message ?? "Waiting for the model." } : null,
      demoModelUnloaded: this.demoModelUnloaded,
    };
  }

  // ---- internals ----

  private queuedJobIds: string[] = [];
  private trackJob(id: string): void {
    this.queuedJobIds.push(id);
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

  private onCoordinatorEvent(e: CoordinatorEvent): void {
    if (e.type === "waiting" && e.runId) {
      this.waitingInfo.set(e.runId, { code: String(e.payload.code ?? "waiting"), message: String(e.payload.message ?? "") });
    }
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private makeProvider(revision: SourceRevision, demo: DemoOptions): FakeProvider {
    const delay = this.options.speedMs ?? SPEED_MS[demo.speed];
    const failed = new Set<string>();
    const first = this.firstModel;
    const failIndex = demo.failBlockOnce !== null ? demo.failBlockOnce - 1 : -1;
    return new FakeProvider({
      deltaDelayMs: delay,
      chunk: 3,
      unavailable: demo.firstModelUnloaded ? [first] : [],
      translate: (req) => {
        const user = JSON.parse(req.messages[1]!.content) as { source_block: string };
        return `[practice translation by ${req.modelId}] ${user.source_block}`;
      },
      scriptFor: (req) => {
        if (failIndex < 0 || req.modelId !== first || failed.has(req.modelId)) return undefined;
        const user = JSON.parse(req.messages[1]!.content) as { source_block: string };
        const idx = revision.blocks.findIndex((b) => revision.exactText.slice(b.startOffset, b.endOffset) === user.source_block);
        if (idx !== failIndex) return undefined;
        failed.add(req.modelId);
        return script.partialThenError("[practice translation by " + req.modelId + "] ", providerError("invalid_response", "Practice mode: the server dropped the connection partway through this block."));
      },
    });
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
    edited: cur?.kind === "manual",
  };
}
