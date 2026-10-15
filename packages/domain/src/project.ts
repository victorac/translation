import {
  workFromBlocks,
  type LegacyBlocks,
} from "./legacy.js";
import type {
  Work,
} from "./work.js";
import type {
  KnowledgeEntry,
} from "./entries.js";
import {
  z,
} from "zod";
import type {
  PromptPreset,
} from "./prompts.js";
import {
  newId,
} from "./platform.js";
import type {
  GlossaryEntry,
} from "./glossary.js";
import type {
  ModelSetting,
} from "./ipc.js";

/**
 * The saved project file (`.ltw.json`). Plain JSON, UTF-8. It contains the documents' source text, the knowledge base, the work on
 * each document (blocks, what was read, the translation of each paragraph) and the settings. It never contains API keys.
 */
export const PROJECT_FORMAT = "ltw-project";
export const PROJECT_SCHEMA_VERSION = 3;
export const PROJECT_EXTENSION = ".ltw.json";
/** Files larger than this are refused before reading (guards memory, not a normal case). */
export const MAX_PROJECT_BYTES = 256 * 1024 * 1024;

/** The choices shared by every document in a project. */
export interface ProjectSettings {
  sourceLanguage: string;
  targetLanguage: string;
  models: ModelSetting[];
  /** Only projects from before the knowledge base have a glossary here; it is brought over once when they are opened. */
  glossary: GlossaryEntry[];
  /** Background about the story and its people, from before the knowledge base. */
  notes?: string | undefined;
  /** The knowledge text as the user wrote it, from before the knowledge base. */
  knowledge?: string | undefined;
  /** The user's own translation styles. */
  prompts: PromptPreset[];
}

/** One piece of text in a project (a chapter, a scene...). */
export interface ProjectDocument {
  id: string;
  title: string;
  createdAt: string;
  /** The text in the editor. */
  draft: string;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  project: { id: string; title: string; createdAt: string; updatedAt: string; version: number };
  settings?: ProjectSettings;
  /** The project's names, hints and notes. Missing in projects saved before the knowledge store existed. */
  knowledge?: { entries: KnowledgeEntry[]; classes?: string };
  /** The blocks of each document's translation, with what was confirmed and translated so far. */
  work?: Work[];
  activeDocumentId: string;
  documents: ProjectDocument[];
}

// ---- shape checks (what a file must look like before anything else is trusted) ----

const str = z.string().max(5_000_000);
const id = z.string().min(1).max(200);
const iso = z.string().max(40);
const count = z.number().int().min(0).max(1e9);

const entrySchema = z.object({
  id,
  kind: z.enum(["term", "note", "scene", "summary"]),
  source: z.string().max(2000),
  target: z.string().max(2000),
  hint: z.string().max(2000),
  text: z.string().max(4000),
  category: z.string().max(100).optional(),
  aliases: z.array(z.string().max(2000)).max(50).optional(),
  attrs: z.record(z.string().max(200), z.array(z.string().max(2000)).max(50)).optional(),
  attrFlags: z.array(z.string().max(200)).max(200).optional(),
  about: z.string().max(200).nullable().optional(),
  related: z.array(id).max(200).optional(),
  scope: z.object({ documentId: id, blockHash: z.string().max(100).optional(), blockHashes: z.array(z.string().max(100)).max(100_000).optional(), block: z.number().int().min(1).max(1e7).optional(), blockEnd: z.number().int().min(1).max(1e7).optional() }).nullable().optional(),
  origin: z.object({ by: z.enum(["user", "model"]), model: z.string().max(300).optional(), documentId: z.string().max(200).optional(), documentTitle: z.string().max(500).optional(), block: z.number().int().min(1).max(1e7).optional() }),
  status: z.enum(["suggested", "confirmed", "rejected"]),
  updatedAt: iso,
});

const wordSchema = z.object({ source: z.string().max(200), english: z.string().max(300), kind: z.enum(["character", "family", "place", "organization", "term"]), aliases: z.array(z.string().max(200)).max(50), reading: z.string().max(300), known: z.boolean(), draft: z.boolean().optional(), use: z.boolean().optional(), hint: z.string().max(1000).optional(), suggestions: z.record(z.string().max(100), z.array(z.string().max(300)).max(5)).optional(), fromReading: z.boolean().optional(), written: z.boolean().optional(), attrs: z.record(z.string().max(100), z.array(z.string().max(300)).max(50)).optional(), gender: z.enum(["female", "male"]).nullable().optional() });

const workSchema = z.object({
  documentId: id,
  source: z.string().max(5_000_000),
  words: z.array(wordSchema).max(5000),
  lines: z.array(z.object({ paragraph: count, text: str, speaker: z.string().max(200).nullable(), suggested: z.string().max(200).nullable().optional() })).max(100_000),
  paragraphs: z.array(z.object({ text: str, translation: str, issue: z.string().max(5000).nullable().optional() })).max(200_000),
  error: z.string().max(5000).nullable().optional(),
});

/** What older projects kept for each document: its text cut into blocks. Read only, to bring the work over. */
const legacySchema = z.object({
  documentId: id,
  blocks: z
    .array(
      z.object({
        text: str,
        translation: str,
        parts: z.array(str).max(10_000).default([]),
        interpretation: z.object({ names: z.array(wordSchema.extend({ guessed: z.boolean().optional() })).max(500), lines: z.array(z.object({ text: str, speaker: z.string().max(200).nullable() })).max(5000) }).nullable(),
      }),
    )
    .max(20_000),
});

const projectHead = z.object({ id, title: z.string().max(500), createdAt: iso, updatedAt: iso, version: count });

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
  models: z.array(modelSettingSchema).max(24),
  glossary: z.array(z.object({ source: z.string().max(2000), target: z.string().max(2000), note: z.string().max(2000).optional(), aliases: z.array(z.string().max(2000)).max(50).optional() })).max(10_000),
  notes: z.string().max(20_000).optional(),
  knowledge: z.string().max(400_000).optional(),
  prompts: z
    .array(z.object({ id: z.string().min(1).max(100), name: z.string().max(200), description: z.string().max(500), template: z.string().max(20_000) }))
    .max(100),
});

const documentSchema = z.object({
  id,
  title: z.string().max(500),
  createdAt: iso,
  draft: z.string().max(5_000_000),
});

const fileSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  schemaVersion: z.literal(3),
  project: projectHead,
  settings: settingsSchema.optional(),
  knowledge: z.object({ entries: z.array(entrySchema).max(50_000), classes: z.string().max(200_000).optional() }).optional(),
  work: z.array(workSchema).max(200).optional(),
  // Older projects kept the work block by block: one record per document (the first release had just one).
  guided: z.union([legacySchema, z.array(legacySchema).max(200)]).transform((g) => (Array.isArray(g) ? g : [g])).optional(),
  activeDocumentId: id,
  documents: z.array(documentSchema).min(1).max(200),
});

/** The first two releases translated a whole text at once. Only the text is taken from their files. */
const sourceText = z.object({ exactText: str });
const fileSchemaV1 = z.object({ format: z.literal(PROJECT_FORMAT), schemaVersion: z.literal(1), project: projectHead, source: sourceText });
const fileSchemaV2 = z.object({ format: z.literal(PROJECT_FORMAT), schemaVersion: z.literal(2), project: projectHead, versions: z.array(z.object({ source: sourceText })).min(1).max(50) });

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
 * Reads a project file and checks it. It never repairs anything: if the file is not exactly consistent it is refused, so a damaged
 * file cannot silently produce wrong results.
 */
export function parseProject(text: string): ParsedProject {
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
  const invalid = (issues: { path: PropertyKey[]; message: string }[]) =>
    fail("invalid", "This project file is missing information or has unexpected content, so it cannot be opened safely.", issues.slice(0, 8).map((i) => `${i.path.map(String).join(".") || "(file)"}: ${i.message}`));
  /** Older files held one text; it becomes the project's first document, with its text in the editor. */
  const singleDocument = (project: ProjectFile["project"], draft: string): ProjectFile => {
    const docId = newId();
    return {
      format: PROJECT_FORMAT,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      project,
      activeDocumentId: docId,
      documents: [{ id: docId, title: "Document 1", createdAt: project.createdAt, draft }],
    };
  };
  let file: ProjectFile;
  if (head.schemaVersion === 1) {
    const v1 = fileSchemaV1.safeParse(json);
    if (!v1.success) return invalid(v1.error.issues);
    file = singleDocument(v1.data.project, v1.data.source.exactText);
  } else if (head.schemaVersion === 2) {
    const v2 = fileSchemaV2.safeParse(json);
    if (!v2.success) return invalid(v2.error.issues);
    file = singleDocument(v2.data.project, v2.data.versions.at(-1)!.source.exactText);
  } else {
    const shape = fileSchema.safeParse(json);
    if (!shape.success) return invalid(shape.error.issues);
    const { guided, work, ...rest } = shape.data;
    file = { ...rest, ...(work ? { work } : {}) } as unknown as ProjectFile;
    // Work saved block by block is brought over, for the documents that have no work of the new kind.
    const brought = (guided ?? []).flatMap((g) => {
      const doc = file.documents.find((d) => d.id === g.documentId);
      return doc && !(work ?? []).some((w) => w.documentId === g.documentId) ? [workFromBlocks(g as LegacyBlocks, doc.draft)] : [];
    });
    if (brought.length > 0) file.work = [...(file.work ?? []), ...brought];
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const doc of file.documents) {
    if (seen.has(doc.id)) problems.push(`Document id ${doc.id} is used more than once.`);
    seen.add(doc.id);
  }
  if (!file.documents.some((d) => d.id === file.activeDocumentId)) problems.push("The document that was open no longer exists.");
  if (problems.length > 0) return fail("corrupt", `This project file is damaged or was changed outside the app: ${problems[0]}`, problems);
  return { ok: true, file };
}

export function buildProjectFile(input: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  settings?: ProjectSettings | null;
  knowledge?: { entries: KnowledgeEntry[]; classes?: string | undefined };
  work?: Work[];
  activeDocumentId: string;
  documents: ProjectDocument[];
}): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: { id: input.id, title: input.title, createdAt: input.createdAt, updatedAt: input.updatedAt, version: input.version },
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.knowledge && input.knowledge.entries.length > 0 ? { knowledge: { entries: input.knowledge.entries, ...(input.knowledge.classes !== undefined ? { classes: input.knowledge.classes } : {}) } } : {}),
    ...(input.work && input.work.length > 0 ? { work: input.work } : {}),
    activeDocumentId: input.activeDocumentId,
    documents: input.documents,
  };
}
