import type {
  EntryCounts,
  EntryQuery,
  KnowledgeEntry,
} from "./entries.js";
import type {
  AttributeDef,
} from "./classes.js";
import type {
  FileInfo,
} from "./topicfile.js";
import type {
  ProjectSettings,
} from "./project.js";
import type {
  PromptPreset,
} from "./prompts.js";
import type {
  GlossaryEntry,
} from "./glossary.js";
import type {
  Work,
} from "./work.js";

/** What the window and the background process say to each other. Types only; no code. */

export type IpcError = { code: string; message: string };
export type IpcResult<T> = { requestId: string; ok: true; value: T } | { requestId: string; ok: false; error: IpcError };

/** How one model is set up: its own limits, temperature and translation style. */
export interface ModelSetting {
  /** The exact model identifier the server knows (for LM Studio, as shown in its model list). */
  name: string;
  /** The context size the model is loaded with. Not discoverable, so the user confirms it. */
  contextLimit: number;
  /** The most text the model may produce for one paragraph. */
  maxOutputTokens: number;
  temperature: number;
  /** Which translation style to use (a built-in one or one of `StartJobInput.prompts`). */
  promptId: string;
  /** Send the glossary to this model. Turn off to compare with and without it. */
  useGlossary: boolean;
}

export type Backend = "provider" | "practice";

/** Which model translates, and how. */
export interface ModelInput {
  backend: Backend;
  modelId: string;
  contextLimit: number;
  maxOutputTokens: number;
  temperature: number;
  /** The translation style (instructions) to use: a built-in one or the user's own. */
  promptId?: string;
  sourceLanguage: string;
  targetLanguage: string;
}

/** The files of the knowledge base, for the file list. */
export interface KnowledgeFiles {
  files: FileInfo[];
  /** Classes a new topic can be made from. */
  classes: { name: string; label: string; attributes: AttributeDef[] }[];
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

/** The choices that decide how the text is translated. Sent whenever they change, so the project keeps them. */
export interface SyncSettingsInput {
  sourceLanguage: string;
  targetLanguage: string;
  models: ModelSetting[];
  glossary: GlossaryEntry[];
  /** Background about the story and its people. Only projects from before the knowledge base have any. */
  notes?: string | undefined;
  knowledge?: string | undefined;
  /** The user's own translation styles (the built-in ones are always available). */
  prompts: PromptPreset[];
}

export interface CommandMap {
  "workspace.snapshot": undefined;
  "settings.sync": SyncSettingsInput;
  "document.create": { title?: string };
  "document.select": { documentId: string };
  "document.rename": { documentId: string; title: string };
  "document.delete": { documentId: string };
  "document.setText": { documentId: string; text: string };
  "project.save": { saveAs: boolean };
  "project.open": { useBackup: boolean };
  "project.new": undefined;
  "project.rename": { title: string };
  "project.restoreRecovery": undefined;
  "project.discardRecovery": undefined;
  "project.dismissProblem": undefined;
  "notes.cancel": undefined;
  "work.get": undefined;
  /** Brings the work on a document up to date with its text: the paragraphs, the words and who says each line. */
  "work.sync": { documentId: string; text: string };
  "work.setSpeaker": { line: number; speaker: string | null };
  "work.addWord": { source: string };
  "work.removeWord": { source: string };
  "work.undoRemove": undefined;
  "work.setAttribute": { source: string; key: string; values: string[] };
  "work.setKind": { source: string; kind: string };
  "work.setEnglish": { source: string; english: string };
  "work.setHint": { source: string; hint: string };
  "work.setUse": { source: string; use: boolean };
  /** Translates the paragraphs one after the other. Without `redo`, the ones that have a translation are skipped. */
  "work.translate": ModelInput & { from?: number; redo?: boolean };
  /** Reads the translation for suggestions: how each name was written, genders, and who says each line. Nothing is confirmed by it. */
  /** `only`: the words (their sources) to read the translation for; without it, every word and line. */
  "work.suggest": ModelInput & { only?: string[] };
  "work.setSuggestion": { source: string; key: string; value: string };
  "work.acceptSuggestion": { source: string; key: string };
  "work.dismissSuggestion": { source: string; key: string };
  "work.acceptSpeaker": { line: number };
  /** The user's own text for the translation of one paragraph. */
  "work.setPart": { paragraph: number; text: string };
  /** Translates one paragraph again, keeping the others. */
  "work.retranslate": ModelInput & { paragraph: number };
  "knowledge.files": undefined;
  "knowledge.file": { id: string };
  "knowledge.setFile": { id: string; text: string };
  "knowledge.create": { type: string; name: string; english?: string; hint?: string };
  "knowledge.delete": { id: string };
  "knowledge.deleteMany": { ids: string[] };
  "knowledge.edit": { id: string; target?: string; hint?: string; kind?: string; attribute?: { key: string; values: string[] } };
  "knowledge.resolve": { name: string };
  "knowledge.list": EntryQuery;
  "knowledge.confirm": { ids?: string[] };
  "provider.get": undefined;
  "provider.save": SaveProviderInput;
  "provider.test": undefined;
}
export type CommandName = keyof CommandMap;

/** What each command answers with. Commands that change the workspace answer with its new snapshot. */
export type SnapshotCommand = Exclude<CommandName, "notes.cancel" | "work.get" | "work.sync" | "work.setSpeaker" | "work.addWord" | "work.removeWord" | "work.undoRemove" | "work.setAttribute" | "work.setKind" | "work.setEnglish" | "work.setHint" | "work.setUse" | "work.translate" | "work.suggest" | "work.setSuggestion" | "work.acceptSuggestion" | "work.dismissSuggestion" | "work.acceptSpeaker" | "work.setPart" | "work.retranslate" | "knowledge.files" | "knowledge.file" | "knowledge.setFile" | "knowledge.create" | "knowledge.delete" | "knowledge.deleteMany" | "knowledge.edit" | "knowledge.resolve" | "knowledge.list" | "knowledge.confirm" | "provider.get" | "provider.save" | "provider.test">;
export type CommandResultMap = { [C in SnapshotCommand]: WorkspaceSnapshot } & {
  "notes.cancel": { canceled: boolean };
  "work.get": Work | null;
  "work.sync": Work | null;
  "work.setSpeaker": Work;
  "work.addWord": Work;
  "work.removeWord": Work;
  "work.undoRemove": Work | null;
  "work.setAttribute": Work;
  "work.setKind": Work;
  "work.setEnglish": Work;
  "work.setHint": Work;
  "work.setUse": Work;
  "work.translate": Work;
  "work.suggest": Work;
  "work.setSuggestion": Work;
  "work.acceptSuggestion": Work;
  "work.dismissSuggestion": Work;
  "work.acceptSpeaker": Work;
  "work.setPart": Work;
  "work.retranslate": Work;
  "knowledge.files": KnowledgeFiles;
  "knowledge.file": KnowledgeFile;
  "knowledge.setFile": KnowledgeFile;
  "knowledge.create": { id: string };
  "knowledge.delete": { removed: boolean };
  "knowledge.deleteMany": { removed: number };
  "knowledge.edit": { id: string };
  "knowledge.resolve": { id: string | null; title: string | null };
  "knowledge.list": KnowledgeList;
  "knowledge.confirm": { confirmed: number };
  "provider.get": ProviderView;
  "provider.save": ProviderView;
  "provider.test": ConnectionTestResult;
};

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
  recovery: { updatedAt: string; paragraphs: number; documents: number } | null;
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

/** One document in the project, as the left rail lists it. */
export interface DocumentView {
  id: string;
  title: string;
  /** Blocks translated, and all its blocks (0 until its text has been cut into blocks). */
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
  project: ProjectView;
}
