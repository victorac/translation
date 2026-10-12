import type { BlockState, RunState } from "./state.js";
import type { BoundaryKind } from "./chunker.js";

/** What the window and the background process say to each other. Types only; no code. */

export type IpcError = { code: string; message: string };
export type IpcResult<T> = { requestId: string; ok: true; value: T } | { requestId: string; ok: false; error: IpcError };

/** Settings for the practice translator, so the app can be tried without a real model. */
export interface DemoOptions {
  speed: "fast" | "normal" | "slow";
  /** Use small blocks so even a short pasted text splits into several. */
  smallBlocks: boolean;
  /** The first model's Nth block (1-based) fails halfway, once. Null for no failure. */
  failBlockOnce: number | null;
  /** The first model starts "not loaded" so you can see the Waiting state. */
  firstModelUnloaded: boolean;
}

export interface StartJobInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** One entry per model run, in the order they will be translated. */
  models: string[];
  demo: DemoOptions;
}

export type CancelInput = { kind: "job" } | { kind: "run"; runId: string } | { kind: "block"; runId: string; blockId: string };

export interface CommandMap {
  "workspace.snapshot": undefined;
  "workspace.reset": undefined;
  "job.start": StartJobInput;
  "job.cancel": CancelInput;
  "block.retry": { runId: string; blockId: string };
  "block.acceptCandidate": { runId: string; blockId: string };
  "block.keepCurrent": { runId: string; blockId: string };
  "block.acceptReview": { runId: string; blockId: string };
  "block.edit": { runId: string; blockId: string; text: string };
  "run.retryUnfinished": { runId: string };
  "run.retranslateDownstream": { runId: string };
  "run.resolveWaiting": { runId: string; resolution: "retry" | "skip" };
  "demo.loadModel": undefined;
}
export type CommandName = keyof CommandMap;
export const COMMAND_NAMES: readonly CommandName[] = [
  "workspace.snapshot",
  "workspace.reset",
  "job.start",
  "job.cancel",
  "block.retry",
  "block.acceptCandidate",
  "block.keepCurrent",
  "block.acceptReview",
  "block.edit",
  "run.retryUnfinished",
  "run.retranslateDownstream",
  "run.resolveWaiting",
  "demo.loadModel",
];

export interface IpcEvent {
  eventVersion: 1;
  seq: number;
  /** Something changed; fetch a new snapshot. The window never rebuilds its state from event contents. */
  type: "changed";
}

/** One model's result for one block, as the window needs to draw it. */
export interface BlockCellView {
  state: BlockState;
  /** The current accepted text (what would be exported), or null if none yet. */
  text: string | null;
  /** Partial text from the latest attempt that never finished; always shown as incomplete. */
  draft: string | null;
  attempts: number;
  error: string | null;
  /** A retried result waiting for "use it" or "keep current". */
  candidateText: string | null;
  edited: boolean;
}

export interface RunView {
  id: string;
  label: string;
  state: RunState;
  blocks: Record<string, BlockCellView>;
}

export interface BlockView {
  id: string;
  index: number;
  text: string;
  estimatedTokens: number;
  boundaryKind: BoundaryKind;
}

export interface WorkspaceSnapshot {
  revision: { id: string; sourceLanguage: string; targetLanguage: string; blocks: BlockView[] } | null;
  runs: RunView[];
  job: { id: string; state: string; stopReason?: string } | null;
  /** True while any job is queued, running or waiting. */
  busy: boolean;
  waiting: { runId: string; label: string; code: string; message: string } | null;
  demoModelUnloaded: boolean;
}
