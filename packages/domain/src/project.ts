import { z } from "zod";
import type { BlockSize } from "./defaults.js";
import type { Backend } from "./ipc.js";
import type { PromptPreset } from "./prompts.js";
import { newId, sha256Hex } from "./platform.js";
import { verifyRevision, type SourceRevision } from "./revision.js";
import type { Attempt, BlockOutput, BlockState, GlossaryEntry, ModelRun } from "./state.js";
import type { ModelSetting } from "./ipc.js";

/**
 * The saved project file (`.ltw.json`). Plain JSON, UTF-8. It contains the source text, every model's
 * results (including retries and edits) and the settings used. It never contains API keys.
 */
export const PROJECT_FORMAT = "ltw-project";
export const PROJECT_SCHEMA_VERSION = 3;
export const PROJECT_EXTENSION = ".ltw.json";
/** Files larger than this are refused before reading (guards memory, not a normal case). */
export const MAX_PROJECT_BYTES = 256 * 1024 * 1024;

/** One version of the source text and everything translated from it. */
export interface ProjectVersion {
  source: SourceRevision;
  backend: Backend;
  /** Includes runs the user removed from view (archived), so nothing is lost. */
  runs: ModelRun[];
  /** When this version of the text was made. Missing in files from the first release. */
  createdAt?: string;
}

/** The choices shared by every document in a project. */
export interface ProjectSettings {
  sourceLanguage: string;
  targetLanguage: string;
  blockSize: BlockSize;
  models: ModelSetting[];
  glossary: GlossaryEntry[];
  /** Background about the story and its people, sent with every block. */
  notes?: string | undefined;
  /** The knowledge text (terms, hints, notes) as the user wrote it. Missing in older projects. */
  knowledge?: string | undefined;
  /** The user's own translation styles. */
  prompts: PromptPreset[];
}

/** One piece of text in a project (a chapter, a scene...) with its own versions and results. */
export interface ProjectDocument {
  id: string;
  title: string;
  createdAt: string;
  /** The text in the editor. It may not have been run yet, or may differ from the newest version. */
  draft: string;
  /** Oldest first. Editing the text and running again adds a version; older ones stay. */
  versions: ProjectVersion[];
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  project: { id: string; title: string; createdAt: string; updatedAt: string; version: number };
  /** Informational: the server address the project was made with. */
  providerLabel?: string;
  settings?: ProjectSettings;
  activeDocumentId: string;
  documents: ProjectDocument[];
}

// ---- shape checks (what a file must look like before anything else is trusted) ----

const str = z.string().max(5_000_000);
const id = z.string().min(1).max(200);
const iso = z.string().max(40);
const count = z.number().int().min(0).max(1e9);

const blockState = z.enum(["pending", "waiting", "running", "succeeded", "needs_review", "failed", "canceled", "stale"]);
const attemptState = z.enum(["pending", "waiting", "running", "succeeded", "needs_review", "failed", "canceled", "interrupted"]);
const runState = z.enum(["queued", "running", "waiting", "completed", "completed_with_issues", "canceled", "interrupted"]);
const boundary = z.enum(["chapter", "paragraph", "sentence", "quote", "line", "whitespace", "hard", "end"]);

const attemptSchema = z.object({
  id,
  ordinal: count,
  configHash: z.string().max(200),
  sourceHash: z.string().max(200),
  contextHash: z.string().max(200),
  state: attemptState,
  draft: str.optional(),
  rawOutput: str.optional(),
  finishReason: z.string().max(100).optional(),
  startedAt: iso.optional(),
  endedAt: iso.optional(),
  usage: z.object({ inputTokens: count.optional(), outputTokens: count.optional() }).optional(),
  error: z.object({ code: z.string().max(100), message: z.string().max(20_000), httpStatus: count.optional() }).optional(),
  notes: z.array(z.string().max(2000)).max(50).optional(),
  settingsHash: z.string().max(200).optional(),
});

const versionSchema = z.object({
  id,
  blockId: id,
  attemptId: id.optional(),
  kind: z.enum(["generated", "manual"]),
  text: str,
  createdAt: iso,
  baseVersionId: id.optional(),
});

const outputSchema = z.object({
  blockId: id,
  state: blockState,
  attempts: z.array(attemptSchema).max(10_000),
  versions: z.array(versionSchema).max(10_000),
  currentVersionId: id.optional(),
  candidate: z.object({ attemptId: id, versionId: id }).optional(),
  staleReason: z.literal("context_changed").optional(),
});

const runSchema = z.object({
  id,
  revisionId: id,
  providerRefId: id,
  modelId: z.string().min(1).max(300),
  label: z.string().min(1).max(300),
  config: z.object({
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.number().int().min(1).max(10_000_000),
    contextLimit: z.number().int().min(1).max(100_000_000),
  }),
  promptVersion: z.string().max(50),
  prompt: z.object({ id: z.string().min(1).max(100), name: z.string().max(200), template: z.string().max(20_000), appendFraming: z.boolean() }).optional(),
  glossary: z.array(z.object({ source: z.string().max(2000), target: z.string().max(2000), note: z.string().max(2000).optional() })).max(10_000),
  notes: z.string().max(20_000).optional(),
  state: runState,
  archived: z.boolean(),
  outputs: z.record(id, outputSchema),
});

const sourceSchema = z.object({
  id,
  parentId: id.optional(),
  exactText: z.string().max(5_000_000),
  sha256: z.string().max(100),
  sourceLanguage: z.string().max(200),
  targetLanguage: z.string().max(200),
  chunkerVersion: z.string().max(50),
  chunkSettings: z.object({ targetTokens: count, maxTokens: count, estimator: z.literal("scalar-v1") }),
  blocks: z
    .array(
      z.object({
        id,
        revisionId: id,
        index: count,
        startOffset: count,
        endOffset: count,
        textHash: z.string().max(100),
        boundaryKind: boundary,
        estimatedTokens: count,
      }),
    )
    .max(5000),
});

const projectHead = z.object({ id, title: z.string().max(500), createdAt: iso, updatedAt: iso, version: count });
const versionSchema_ = z.object({ source: sourceSchema, backend: z.enum(["provider", "practice"]), runs: z.array(runSchema).max(24), createdAt: iso.optional() });

const modelSettingSchema = z.object({
  name: z.string().min(1).max(300),
  contextLimit: z.number().int().min(1).max(100_000_000),
  maxOutputTokens: z.number().int().min(1).max(10_000_000),
  temperature: z.number().min(0).max(2),
  promptId: z.string().min(1).max(100),
  useGlossary: z.boolean(),
});
const settingsSchema = z.object({
  sourceLanguage: z.string().max(200),
  targetLanguage: z.string().max(200),
  blockSize: z.enum(["small", "normal", "large"]),
  models: z.array(modelSettingSchema).max(24),
  glossary: z.array(z.object({ source: z.string().max(2000), target: z.string().max(2000), note: z.string().max(2000).optional() })).max(10_000),
  notes: z.string().max(20_000).optional(),
  knowledge: z.string().max(400_000).optional(),
  prompts: z
    .array(z.object({ id: z.string().min(1).max(100), name: z.string().max(200), description: z.string().max(500), template: z.string().max(20_000), appendFraming: z.boolean() }))
    .max(100),
});

const documentSchema = z.object({
  id,
  title: z.string().max(500),
  createdAt: iso,
  draft: z.string().max(5_000_000),
  versions: z.array(versionSchema_).max(50),
});

const fileSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  schemaVersion: z.literal(3),
  project: projectHead,
  providerLabel: z.string().max(2000).optional(),
  settings: settingsSchema.optional(),
  activeDocumentId: id,
  documents: z.array(documentSchema).min(1).max(200),
});

/** Files written by the second release: one document's versions at the top level. Converted on load. */
const fileSchemaV2 = z.object({
  format: z.literal(PROJECT_FORMAT),
  schemaVersion: z.literal(2),
  project: projectHead,
  providerLabel: z.string().max(2000).optional(),
  versions: z.array(versionSchema_).min(1).max(50),
});

/** Files written by the first release: one source text, no history. Converted on load. */
const fileSchemaV1 = z.object({
  format: z.literal(PROJECT_FORMAT),
  schemaVersion: z.literal(1),
  project: projectHead,
  backend: z.enum(["provider", "practice"]),
  providerLabel: z.string().max(2000).optional(),
  source: sourceSchema,
  runs: z.array(runSchema).max(24),
});

export type ProjectLoadErrorCode = "not_json" | "not_project" | "newer_schema" | "invalid" | "corrupt";
export interface ProjectLoadError {
  code: ProjectLoadErrorCode;
  /** One or two sentences for the user. */
  message: string;
  /** Technical details of what failed, for diagnostics. */
  details: string[];
}

export type ParsedProject = { ok: true; file: ProjectFile } | { ok: false; error: ProjectLoadError };

export function serializeProject(file: ProjectFile): string {
  return JSON.stringify(file, null, 1) + "\n";
}

/**
 * Reads a project file and checks it thoroughly. It never repairs anything: if the file is not exactly
 * consistent it is refused, so a damaged file cannot silently produce wrong results.
 */
export function parseProject(text: string, hash: (t: string) => string = sha256Hex): ParsedProject {
  const fail = (code: ProjectLoadErrorCode, message: string, details: string[] = []): ParsedProject => ({ ok: false, error: { code, message, details } });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("not_json", "This file is not readable. It may be damaged or may not be a translation project.");
  }
  const head = json as { format?: unknown; schemaVersion?: unknown };
  if (head === null || typeof head !== "object" || head.format !== PROJECT_FORMAT) {
    return fail("not_project", "This is not a Local Translation Workbench project file.");
  }
  if (typeof head.schemaVersion === "number" && head.schemaVersion > PROJECT_SCHEMA_VERSION) {
    return fail("newer_schema", `This project was saved by a newer version of the app (file format ${head.schemaVersion}). Update the app to open it.`);
  }
  const shapeIssues = (issues: { path: PropertyKey[]; message: string }[]) =>
    issues.slice(0, 8).map((i) => `${i.path.map(String).join(".") || "(file)"}: ${i.message}`);
  const invalid = (issues: { path: PropertyKey[]; message: string }[]) =>
    fail("invalid", "This project file is missing information or has unexpected content, so it cannot be opened safely.", shapeIssues(issues));
  /** Older files held one text; it becomes the project's first document, with its text in the editor. */
  const singleDocument = (project: ProjectFile["project"], versions: ProjectVersion[], providerLabel?: string): ProjectFile => {
    const docId = newId();
    return {
      format: PROJECT_FORMAT,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      project,
      ...(providerLabel !== undefined ? { providerLabel } : {}),
      activeDocumentId: docId,
      documents: [{ id: docId, title: "Document 1", createdAt: project.createdAt, draft: versions.at(-1)?.source.exactText ?? "", versions }],
    };
  };
  let file: ProjectFile;
  if (head.schemaVersion === 1) {
    const v1 = fileSchemaV1.safeParse(json);
    if (!v1.success) return invalid(v1.error.issues);
    const { source, runs, backend, project, providerLabel } = v1.data as unknown as { source: SourceRevision; runs: ModelRun[]; backend: Backend; project: ProjectFile["project"]; providerLabel?: string };
    file = singleDocument(project, [{ source, backend, runs }], providerLabel);
  } else if (head.schemaVersion === 2) {
    const v2 = fileSchemaV2.safeParse(json);
    if (!v2.success) return invalid(v2.error.issues);
    const { versions, project, providerLabel } = v2.data as unknown as { versions: ProjectVersion[]; project: ProjectFile["project"]; providerLabel?: string };
    file = singleDocument(project, versions, providerLabel);
  } else {
    const shape = fileSchema.safeParse(json);
    if (!shape.success) return invalid(shape.error.issues);
    file = shape.data as unknown as ProjectFile;
  }

  const problems: string[] = [];
  const seenIds = new Set<string>();
  const unique = (kind: string, ident: string) => {
    if (seenIds.has(ident)) problems.push(`${kind} id ${ident} is used more than once.`);
    seenIds.add(ident);
  };
  if (!file.documents.some((d) => d.id === file.activeDocumentId)) problems.push("The document that was open no longer exists.");
  for (const doc of file.documents) unique("Document", doc.id);
  for (const version of file.documents.flatMap((d) => d.versions)) {
    const source = version.source;
    for (const p of verifyRevision(source, hash)) problems.push(p.message);
    unique("Text version", source.id);
    for (const b of source.blocks) unique("Block", b.id);
    const blockIds = new Set(source.blocks.map((b) => b.id));
    for (const run of version.runs) {
      const at = `Model "${run.label}"`;
      unique("Model run", run.id);
      if (run.revisionId !== source.id) problems.push(`${at} belongs to a different source version.`);
      const outputIds = Object.keys(run.outputs);
      if (outputIds.length !== blockIds.size || outputIds.some((k) => !blockIds.has(k))) {
        problems.push(`${at} does not have exactly one result slot per source block.`);
      }
      for (const [key, out] of Object.entries(run.outputs)) {
        if (out.blockId !== key) problems.push(`${at}: result slot ${key} points at another block.`);
        const attemptIds = new Set(out.attempts.map((a) => a.id));
        const versionIds = new Set(out.versions.map((v) => v.id));
        if (attemptIds.size !== out.attempts.length) problems.push(`${at}: duplicate attempt ids.`);
        if (versionIds.size !== out.versions.length) problems.push(`${at}: duplicate version ids.`);
        out.attempts.forEach((a, i) => {
          if (a.ordinal !== i + 1) problems.push(`${at}: attempts are out of order.`);
        });
        for (const v of out.versions) {
          if (v.blockId !== key) problems.push(`${at}: a version belongs to another block.`);
          if (v.attemptId !== undefined && !attemptIds.has(v.attemptId)) problems.push(`${at}: a version refers to a missing attempt.`);
          if (v.baseVersionId !== undefined && !versionIds.has(v.baseVersionId)) problems.push(`${at}: a version refers to a missing earlier version.`);
        }
        if (out.currentVersionId !== undefined && !versionIds.has(out.currentVersionId)) problems.push(`${at}: the current text is missing.`);
        if (out.candidate && (!versionIds.has(out.candidate.versionId) || !attemptIds.has(out.candidate.attemptId))) {
          problems.push(`${at}: a pending new version is missing.`);
        }
        for (const a of out.attempts) {
          if (a.sourceHash !== source.blocks.find((b) => b.id === key)?.textHash) problems.push(`${at}: an attempt was made for different source text.`);
        }
      }
    }
  }
  if (problems.length > 0) {
    const unique = [...new Set(problems)];
    return fail("corrupt", `This project file is damaged or was changed outside the app: ${unique[0]}`, unique.slice(0, 20));
  }
  return { ok: true, file };
}

/**
 * Work that was in progress when a project was saved or the app stopped cannot still be running.
 * Such attempts become "interrupted" (their partial text is kept) and their blocks go back to being
 * unfinished, so Resume can run them again without touching finished blocks.
 */
export function settleLoadedRun(run: ModelRun): ModelRun {
  const out: ModelRun = structuredClone(run);
  let unfinished = false;
  for (const o of Object.values(out.outputs)) {
    for (const a of o.attempts as Attempt[]) {
      if (a.state === "running" || a.state === "pending" || a.state === "waiting") a.state = "interrupted";
    }
    if (o.state === "running" || o.state === "waiting") {
      const cur = o.versions.find((v) => v.id === o.currentVersionId);
      if (cur) {
        const producer = o.attempts.find((a) => a.id === cur.attemptId);
        o.state = (producer?.state === "needs_review" ? "needs_review" : "succeeded") satisfies BlockState;
      } else {
        o.state = "pending";
      }
    }
    if (o.state === "pending") unfinished = true;
  }
  if (out.state === "running" || out.state === "waiting" || out.state === "queued" || (out.state === "interrupted" && unfinished)) {
    out.state = "interrupted";
  }
  return out;
}

export function buildProjectFile(input: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  providerLabel?: string;
  settings?: ProjectSettings | null;
  activeDocumentId: string;
  documents: ProjectDocument[];
}): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: { id: input.id, title: input.title, createdAt: input.createdAt, updatedAt: input.updatedAt, version: input.version },
    ...(input.providerLabel !== undefined ? { providerLabel: input.providerLabel } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    activeDocumentId: input.activeDocumentId,
    documents: input.documents,
  };
}

export type { BlockOutput };
