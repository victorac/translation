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

/** How one model run is configured. Each model can have its own limits. */
export interface ModelSetting {
  /** The exact model identifier the server knows (for LM Studio, as shown in its model list). */
  name: string;
  /** The context size the model is loaded with. Not discoverable, so the user confirms it. */
  contextLimit: number;
  /** The most text the model may produce for one block. */
  maxOutputTokens: number;
  temperature: number;
}

export type Backend = "provider" | "practice";

export interface StartJobInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** `provider` = the saved LM Studio / local server connection; `practice` = the built-in fake translator. */
  backend: Backend;
  /** One entry per model run, in the order they will be translated. */
  models: ModelSetting[];
  demo: DemoOptions;
}

/** The saved connection to a local model server. The API key itself is never sent to the window. */
export interface ProviderView {
  baseUrl: string;
  host: string;
  /** True when the address is on this computer. */
  loopback: boolean;
  /** The user has approved sending text to this non-local host. */
  remoteAllowed: boolean;
  hasApiKey: boolean;
  /** Why the saved address cannot be used right now, or null. */
  problem: string | null;
}

export interface SaveProviderInput {
  baseUrl: string;
  /** Approve a host that is not this computer. Ignored for local addresses. */
  allowRemote: boolean;
  /** Omitted: keep the saved key. Empty string: remove it. Otherwise: replace it. */
  apiKey?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** A sentence for the user, including what to do next when it failed. */
  message: string;
  /** Model identifiers the server listed. Listing a model does not mean it is loaded. */
  models: string[];
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
  "provider.get": undefined;
  "provider.save": SaveProviderInput;
  "provider.test": undefined;
}
export type CommandName = keyof CommandMap;

/** What each command answers with. Commands that change the workspace answer with its new snapshot. */
export type SnapshotCommand = Exclude<CommandName, "provider.get" | "provider.save" | "provider.test">;
export type CommandResultMap = { [C in SnapshotCommand]: WorkspaceSnapshot } & {
  "provider.get": ProviderView;
  "provider.save": ProviderView;
  "provider.test": ConnectionTestResult;
};
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
  "provider.get",
  "provider.save",
  "provider.test",
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
  /** Which translator the current workspace uses. */
  backend: Backend | null;
  /** True while any job is queued, running or waiting. */
  busy: boolean;
  waiting: { runId: string; label: string; code: string; message: string } | null;
  demoModelUnloaded: boolean;
}
