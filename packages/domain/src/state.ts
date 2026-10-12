import type { ModelBudgetInput } from "./budget.js";

/** A glossary line: how a name or term should be translated. */
export interface GlossaryEntry {
  source: string;
  target: string;
  note?: string;
}

export type AttemptState =
  | "pending"
  | "waiting"
  | "running"
  | "succeeded"
  | "needs_review"
  | "failed"
  | "canceled"
  | "interrupted";

export type BlockState =
  | "pending"
  | "waiting"
  | "running"
  | "succeeded"
  | "needs_review"
  | "failed"
  | "canceled"
  | "stale";

export interface AttemptError {
  code: string;
  message: string;
  httpStatus?: number;
}

/** One request to a model for one block. A retry is always a new attempt with a new id. */
export interface Attempt {
  id: string;
  ordinal: number;
  configHash: string;
  sourceHash: string;
  contextHash: string;
  state: AttemptState;
  /** Text streamed so far. A draft is never an accepted translation. */
  draft?: string;
  rawOutput?: string;
  finishReason?: string;
  startedAt?: string;
  endedAt?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: AttemptError;
}

export interface OutputVersion {
  id: string;
  blockId: string;
  attemptId?: string;
  /** `generated` is exactly what the model produced; `manual` is a user edit. */
  kind: "generated" | "manual";
  text: string;
  createdAt: string;
  baseVersionId?: string;
}

export interface BlockOutput {
  blockId: string;
  state: BlockState;
  attempts: Attempt[];
  versions: OutputVersion[];
  /** The version shown and exported. Streaming and retries never overwrite it. */
  currentVersionId?: string;
  /** A finished retry waiting for the user to choose "Use candidate" or "Keep current". */
  candidate?: { attemptId: string; versionId: string };
  staleReason?: "context_changed";
}

export interface RunConfig {
  temperature: number;
  maxOutputTokens: number;
  contextLimit: number;
}

export type RunState = "queued" | "running" | "waiting" | "completed" | "completed_with_issues" | "canceled" | "interrupted";

export interface ModelRun {
  id: string;
  revisionId: string;
  providerRefId: string;
  modelId: string;
  label: string;
  config: RunConfig;
  promptVersion: string;
  glossary: GlossaryEntry[];
  state: RunState;
  archived: boolean;
  outputs: Record<string, BlockOutput>;
}

export const latestAttempt = (o: BlockOutput): Attempt | undefined => o.attempts[o.attempts.length - 1];

export const currentVersion = (o: BlockOutput): OutputVersion | undefined =>
  o.versions.find((v) => v.id === o.currentVersionId);

/**
 * The translation text that later blocks may use as context.
 * Only finished, accepted text counts: drafts, truncated or refused output, and stale blocks do not.
 * A manual edit counts, because the user chose that wording.
 */
export function usableText(o: BlockOutput | undefined): string | null {
  if (!o || o.state === "needs_review" || o.state === "stale") return null;
  const v = currentVersion(o);
  if (!v) return null;
  if (v.kind === "manual") return v.text;
  const producedBy = o.attempts.find((a) => a.id === v.attemptId);
  return producedBy?.state === "succeeded" ? v.text : null;
}

export function runBudgetInput(run: ModelRun, systemTokens: number, glossaryTokens: number): ModelBudgetInput {
  return {
    label: run.label,
    contextLimit: run.config.contextLimit,
    outputReserve: run.config.maxOutputTokens,
    systemTokens,
    glossaryTokens,
  };
}
