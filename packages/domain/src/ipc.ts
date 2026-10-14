import type { EntryCounts, EntryInput, EntryQuery, KnowledgeEntry } from "./entries.js";
import type { FileInfo } from "./topicfile.js";
import type { ProjectSettings } from "./project.js";
import type { PromptPreset } from "./prompts.js";
import type { BlockState, GlossaryEntry, RunState } from "./state.js";
import type { BoundaryKind } from "./chunker.js";
import type { BlockSize } from "./defaults.js";
import type { ExportFormat, ExportPreview, ExportTextVersion } from "./export.js";

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
  /** Which translation style to use (a built-in one or one of `StartJobInput.prompts`). */
  promptId: string;
  /** Send the glossary to this model. Turn off to compare with and without it. */
  useGlossary: boolean;
}

export type Backend = "provider" | "practice";

/** What the splitting preview shows: the blocks the run would use, and why they are that size. */
export interface SplitPreview {
  /** Nothing in the way of running (text present, everything fits). */
  ok: boolean;
  /** Why there is no preview, or null. */
  problem: string | null;
  blocks: { index: number; text: string; estimatedTokens: number; boundaryKind: BoundaryKind }[];
  characters: number;
  bytes: number;
  /** Sizes actually used, after the models' limits were applied. */
  targetTokens: number;
  maxTokens: number;
  /** The model whose limits set the block size, if any. */
  limitingModel: string | null;
  /** Per model: how much of its context a block may use. */
  models: { label: string; contextLimit: number; outputReserve: number; fixedTokens: number; sourceBudget: number; contextReserve: number; fits: boolean }[];
  /** Things that stop the run, in plain words. */
  issues: string[];
  /** Things worth a look, in plain words. */
  notes: string[];
}

/** Ask a model to read one passage and suggest notes (people, who speaks to whom) that help with pronouns. */
export interface AnalyzeInput {
  backend: Backend;
  modelId: string;
  contextLimit: number;
  maxOutputTokens: number;
  sourceLanguage: string;
  targetLanguage: string;
  passage: string;
  /** Where the passage is from, so what the model finds can say where it came from. */
  documentId: string;
  documentTitle: string;
  /** Number of the block (starting at 1). */
  block: number;
}

/** Ask a model which of the project's names, hints and notes matter for one block. */
export interface ResearchInput {
  backend: Backend;
  modelId: string;
  contextLimit: number;
  maxOutputTokens: number;
  sourceLanguage: string;
  targetLanguage: string;
  passage: string;
}

export interface ResearchResult {
  /** False when nothing needed asking (nothing is known yet, or this block was already looked through). */
  asked: boolean;
  /** How many entries are now chosen for this block. */
  chosen: number;
  canceled: boolean;
}

/** Ask a model to write an abridged version of a document from the scene descriptions found in it. */
export interface SummarizeInput {
  backend: Backend;
  modelId: string;
  contextLimit: number;
  maxOutputTokens: number;
  sourceLanguage: string;
  targetLanguage: string;
  documentId: string;
  documentTitle: string;
  /** Replace a summary the user accepted too. */
  rewrite?: boolean | undefined;
}

/** Join the scenes of neighbouring blocks that belong together. */
export interface MergeScenesInput {
  backend: Backend;
  modelId: string;
  contextLimit: number;
  maxOutputTokens: number;
  sourceLanguage: string;
  targetLanguage: string;
  documentId: string;
  documentTitle: string;
}

export interface MergeScenesResult {
  /** How many scenes were joined into the one before them. */
  joined: number;
  canceled: boolean;
}

export interface SummarizeResult {
  /** False when there was nothing to summarize, or the user had already confirmed a summary. */
  updated: boolean;
  canceled: boolean;
}

export interface AnalyzeResult {
  /** How many entries were added to (or filled in) the project's knowledge. */
  added: number;
  /** True when the user stopped it; nothing was added in that case. */
  canceled: boolean;
  /** Things that were left out or could not be done, in plain words. */
  notes: string[];
}

/** The files of the knowledge base, for the file list. */
export interface KnowledgeFiles {
  files: FileInfo[];
  /** Classes a new topic can be made from. */
  classes: { name: string; label: string }[];
  rev: number;
}

/** One file of the knowledge base: its text, what could not be understood in it, and what links to it. */
export interface KnowledgeFile {
  id: string;
  title: string;
  text: string;
  problems: { line: number; message: string }[];
  /** After applying an edit: the same problems, placed on the lines of the tidied text. */
  tidyProblems?: { line: number; message: string }[];
  backlinks: { id: string; title: string }[];
  rev: number;
}

/** The project's names, hints and notes, as the window asks for them. */
export interface KnowledgeList {
  entries: KnowledgeEntry[];
  /** How many entries match, which can be more than were returned. */
  total: number;
  counts: EntryCounts;
  rev: number;
}

export interface KnowledgeSummary extends EntryCounts {
  /** Changes whenever the knowledge changes, so the window knows to ask again. */
  rev: number;
}

export interface StartJobInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** `provider` = the saved LM Studio / local server connection; `practice` = the built-in fake translator. */
  backend: Backend;
  /** One entry per model run, in the order they will be translated. */
  models: ModelSetting[];
  glossary: GlossaryEntry[];
  /** Background about the story and its people, sent with every block. */
  notes?: string | undefined;
  /** The knowledge text the terms and notes came from; kept so the project can show it as it was written. */
  knowledge?: string | undefined;
  /** The user's own translation styles (the built-in ones are always available). */
  prompts: PromptPreset[];
  /** How big each block should be. The models' own limits can make blocks smaller. */
  blockSize: BlockSize;
  /** Names of existing model runs to translate again from the start with the current settings. */
  rerun: string[];
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

/** The choices that decide how blocks are translated. Sent whenever they change, so retries use them. */
export type SyncSettingsInput = Pick<StartJobInput, "sourceLanguage" | "targetLanguage" | "models" | "glossary" | "notes" | "knowledge" | "prompts" | "blockSize">;

export type CancelInput = { kind: "job" } | { kind: "run"; runId: string } | { kind: "block"; runId: string; blockId: string };

/** What to put in an exported file. */
export interface ExportInput {
  format: ExportFormat;
  runIds: string[];
  textVersion: ExportTextVersion;
  /** Include blocks that have no translation, marked as missing. */
  allowPartial: boolean;
  /** CSV: protect against spreadsheet formulas. */
  formulaSafe: boolean;
}

export interface ExportWriteResult {
  /** Where the file was written, or null if the user cancelled the dialog. */
  path: string | null;
  bytes: number;
}

export interface CommandMap {
  "workspace.snapshot": undefined;
  "workspace.reset": undefined;
  "job.start": StartJobInput;
  "settings.sync": SyncSettingsInput;
  "document.create": { title?: string };
  "document.select": { documentId: string };
  "document.rename": { documentId: string; title: string };
  "document.delete": { documentId: string };
  "document.setText": { documentId: string; text: string };
  "job.cancel": CancelInput;
  "block.retry": { runId: string; blockId: string };
  "block.acceptCandidate": { runId: string; blockId: string };
  "block.keepCurrent": { runId: string; blockId: string };
  "block.acceptReview": { runId: string; blockId: string };
  "block.edit": { runId: string; blockId: string; text: string };
  "run.retryUnfinished": { runId: string };
  "run.retranslateDownstream": { runId: string };
  "run.resolveWaiting": { runId: string; resolution: "retry" | "skip" };
  "run.archive": { runId: string };
  "run.restore": { runId: string };
  "version.view": { versionId: string };
  "demo.loadModel": undefined;
  "project.save": { saveAs: boolean };
  "project.open": { useBackup: boolean };
  "project.new": undefined;
  "project.restoreRecovery": undefined;
  "project.discardRecovery": undefined;
  "project.dismissProblem": undefined;
  "export.preview": ExportInput;
  "export.write": ExportInput;
  "source.preview": StartJobInput;
  "notes.analyze": AnalyzeInput;
  "notes.cancel": undefined;
  "research.block": ResearchInput;
  "knowledge.summarize": SummarizeInput;
  "knowledge.mergeScenes": MergeScenesInput;
  "knowledge.files": undefined;
  "knowledge.file": { id: string };
  "knowledge.setFile": { id: string; text: string };
  "knowledge.create": { type: string; name: string };
  "knowledge.delete": { id: string };
  "knowledge.resolve": { name: string };
  "knowledge.beginExtraction": { documentId: string };
  "knowledge.check": undefined;
  "knowledge.list": EntryQuery;
  "knowledge.save": EntryInput;
  "knowledge.remove": { ids: string[] };
  "knowledge.confirm": { ids?: string[] };
  "knowledge.import": { text: string };
  "provider.get": undefined;
  "provider.save": SaveProviderInput;
  "provider.test": undefined;
}
export type CommandName = keyof CommandMap;

/** What each command answers with. Commands that change the workspace answer with its new snapshot. */
export type SnapshotCommand = Exclude<CommandName, "notes.analyze" | "notes.cancel" | "research.block" | "knowledge.summarize" | "knowledge.mergeScenes" | "knowledge.files" | "knowledge.file" | "knowledge.check" | "knowledge.setFile" | "knowledge.create" | "knowledge.delete" | "knowledge.resolve" | "knowledge.beginExtraction" | "knowledge.list" | "knowledge.save" | "knowledge.remove" | "knowledge.confirm" | "knowledge.import" | "provider.get" | "provider.save" | "provider.test" | "export.preview" | "export.write" | "source.preview">;
export type CommandResultMap = { [C in SnapshotCommand]: WorkspaceSnapshot } & {
  "source.preview": SplitPreview;
  "notes.analyze": AnalyzeResult;
  "notes.cancel": { canceled: boolean };
  "research.block": ResearchResult;
  "knowledge.summarize": SummarizeResult;
  "knowledge.mergeScenes": MergeScenesResult;
  "knowledge.files": KnowledgeFiles;
  "knowledge.file": KnowledgeFile;
  "knowledge.setFile": KnowledgeFile;
  "knowledge.create": { id: string };
  "knowledge.delete": { removed: boolean };
  "knowledge.resolve": { id: string | null; title: string | null };
  "knowledge.beginExtraction": { discarded: number };
  "knowledge.check": { found: number; added: number; removed: number };
  "knowledge.list": KnowledgeList;
  "knowledge.save": { entry: KnowledgeEntry };
  "knowledge.remove": { removed: number };
  "knowledge.confirm": { confirmed: number };
  "knowledge.import": { added: number; unreadable: number };
  "export.preview": ExportPreview;
  "export.write": ExportWriteResult;
  "provider.get": ProviderView;
  "provider.save": ProviderView;
  "provider.test": ConnectionTestResult;
};
export const COMMAND_NAMES: readonly CommandName[] = [
  "workspace.snapshot",
  "workspace.reset",
  "job.start",
  "settings.sync",
  "document.create",
  "document.select",
  "document.rename",
  "document.delete",
  "document.setText",
  "job.cancel",
  "block.retry",
  "block.acceptCandidate",
  "block.keepCurrent",
  "block.acceptReview",
  "block.edit",
  "run.retryUnfinished",
  "run.retranslateDownstream",
  "run.resolveWaiting",
  "run.archive",
  "run.restore",
  "version.view",
  "demo.loadModel",
  "project.save",
  "project.open",
  "project.new",
  "project.restoreRecovery",
  "project.discardRecovery",
  "project.dismissProblem",
  "export.preview",
  "export.write",
  "source.preview",
  "notes.analyze",
  "notes.cancel",
  "research.block",
  "knowledge.summarize",
  "knowledge.mergeScenes",
  "knowledge.files",
  "knowledge.file",
  "knowledge.setFile",
  "knowledge.create",
  "knowledge.delete",
  "knowledge.resolve",
  "knowledge.beginExtraction",
  "knowledge.check",
  "knowledge.list",
  "knowledge.save",
  "knowledge.remove",
  "knowledge.confirm",
  "knowledge.import",
  "provider.get",
  "provider.save",
  "provider.test",
];

/** The open project, as the window needs to show it. */
export interface ProjectView {
  /** File name without the extension, or "Untitled". */
  title: string;
  /** Where it is saved, or null if it has never been saved. */
  path: string | null;
  /** There are changes that are not in the saved file. */
  dirty: boolean;
  lastSavedAt: string | null;
  /** Unsaved work from an earlier session, waiting for the user to restore or discard it. */
  recovery: { updatedAt: string; blocks: number; models: number; documents: number } | null;
  /** The last file the user tried to open could not be opened. */
  openProblem: { message: string; canOpenBackup: boolean } | null;
  /** Something worth knowing (for example the project used a different server address). */
  notice: string | null;
}

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
  /** Reasons the text deserves a look (missing glossary terms, possible commentary...). */
  reviewNotes: string[];
  /** The glossary, style or temperature changed in a way that affects this block since it was translated. */
  outdated: boolean;
  edited: boolean;
}

export interface RunView {
  id: string;
  versionId: string;
  label: string;
  /** Blocks not translated yet, failed or canceled. */
  unfinished: number;
  /** Blocks translated with settings that have since changed. */
  outdated: number;
  /** The settings the run was made with, so the window can show and edit them. */
  settings: { modelId: string; contextLimit: number; maxOutputTokens: number; temperature: number; promptId: string; useGlossary: boolean };
  /** The translation style this model used. */
  promptName: string;
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

export interface VersionView {
  id: string;
  /** 1 for the first text, 2 for the next, and so on. */
  number: number;
  blocks: number;
  models: number;
  createdAt: string;
}

/** One document in the project, as the left rail lists it. */
export interface DocumentView {
  id: string;
  title: string;
  /** Blocks in its newest version (0 if it has not been run). */
  blocks: number;
  models: number;
  /** Finished and total blocks across its models in the newest version. */
  done: number;
  total: number;
  hasText: boolean;
}

export interface WorkspaceSnapshot {
  /** The project's documents, in order. Everything below describes the open one. */
  documents: DocumentView[];
  activeDocumentId: string;
  /** The text in the open document's editor. */
  draftText: string;
  /** Changes whenever a project is opened, restored or started, so the window knows to reload its choices. */
  epoch: number;
  /** The project's saved choices, or null if the project has none yet (the window keeps its own). */
  settings: ProjectSettings | null;
  /** How much names, hints and notes there are, and a number that changes whenever they change. */
  knowledge: KnowledgeSummary;
  /** The version being looked at (the newest unless the user picked an older one). */
  revision: { id: string; sourceLanguage: string; targetLanguage: string; blocks: BlockView[]; text: string } | null;
  /** Every version of the text, oldest first. */
  versions: VersionView[];
  /** The text of the newest version (which may differ from the one being viewed). */
  latestText: string | null;
  viewingId: string | null;
  latestId: string | null;
  /** Model runs of the version being looked at (not the ones the user removed). */
  runs: RunView[];
  /** Model runs the user removed from this version, which can be brought back. */
  archived: { runId: string; label: string }[];
  job: { id: string; state: string; stopReason?: string } | null;
  /** Which translator the current workspace uses. */
  backend: Backend | null;
  /** True while any job is queued, running or waiting. */
  busy: boolean;
  waiting: { runId: string; label: string; code: string; message: string } | null;
  demoModelUnloaded: boolean;
  project: ProjectView;
}
