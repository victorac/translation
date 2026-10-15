import {
  z,
} from "zod";
import type {
  CommandName,
  CommandResultMap,
  IpcResult,
} from "@ltw/domain";
import {
  UserError,
} from "./errors.js";
import type {
  ProjectService,
} from "./project-service.js";
import type {
  ProviderService,
} from "./provider-service.js";
import type {
  WorkspaceService,
} from "./service.js";

const id = z.string().min(1).max(200);

/** The choices the window sends whenever they change. */
const syncInput = z.object({
  sourceLanguage: z.string().max(100),
  targetLanguage: z.string().max(100),
  models: z
    .array(
      z.object({
        name: z.string().max(300),
        contextLimit: z.number().int().min(512).max(10_000_000),
        maxOutputTokens: z.number().int().min(16).max(1_000_000),
        temperature: z.number().min(0).max(2),
        promptId: z.string().min(1).max(100),
        useGlossary: z.boolean(),
      }),
    )
    .max(50),
  glossary: z.array(z.object({ source: z.string().max(1000), target: z.string().max(1000), note: z.string().max(1000).optional() })).max(2000),
  notes: z.string().max(20_000).optional(),
  knowledge: z.string().max(400_000).optional(),
  prompts: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().max(200), description: z.string().max(500), template: z.string().max(20_000) })).max(100),
});

const modelInput = z.object({
  backend: z.enum(["provider", "practice"]),
  modelId: z.string().min(1).max(300),
  contextLimit: z.number().int().min(512).max(10_000_000),
  maxOutputTokens: z.number().int().min(16).max(1_000_000),
  temperature: z.number().min(0).max(2),
  promptId: z.string().max(200).optional(),
  sourceLanguage: z.string().max(100),
  targetLanguage: z.string().max(100),
});

const schemas: Record<CommandName, z.ZodType> = {
  "workspace.snapshot": z.undefined(),
  "project.save": z.object({ saveAs: z.boolean() }),
  "project.open": z.object({ useBackup: z.boolean() }),
  "project.new": z.undefined(),
  "project.rename": z.object({ title: z.string().max(200) }),
  "project.restoreRecovery": z.undefined(),
  "project.discardRecovery": z.undefined(),
  "project.dismissProblem": z.undefined(),
  "provider.get": z.undefined(),
  "provider.test": z.undefined(),
  "provider.save": z.object({ baseUrl: z.string().max(2000), allowRemote: z.boolean(), apiKey: z.string().max(2000).optional() }),
  "settings.sync": syncInput,
  "document.create": z.object({ title: z.string().max(200).optional() }),
  "document.select": z.object({ documentId: id }),
  "document.rename": z.object({ documentId: id, title: z.string().max(200) }),
  "document.delete": z.object({ documentId: id }),
  "document.setText": z.object({ documentId: id, text: z.string().max(5_000_000) }),
  "work.get": z.undefined(),
  "work.sync": z.object({ documentId: id, text: z.string().max(5_000_000) }),
  "work.setSpeaker": z.object({ line: z.number().int().min(0).max(1_000_000), speaker: z.string().max(200).nullable() }),
  "work.suggest": modelInput,
  "work.acceptSuggestion": z.object({ source: z.string().min(1).max(200), key: z.string().min(1).max(100) }),
  "work.dismissSuggestion": z.object({ source: z.string().min(1).max(200), key: z.string().min(1).max(100) }),
  "work.acceptSpeaker": z.object({ line: z.number().int().min(0).max(1_000_000) }),
  "work.addWord": z.object({ source: z.string().min(1).max(100) }),
  "work.setAttribute": z.object({ source: z.string().min(1).max(200), key: z.string().min(1).max(100), values: z.array(z.string().max(200)).max(50) }),
  "work.setUse": z.object({ source: z.string().min(1).max(200), use: z.boolean() }),
  "work.setEnglish": z.object({ source: z.string().min(1).max(200), english: z.string().max(300) }),
  "work.setHint": z.object({ source: z.string().min(1).max(200), hint: z.string().max(500) }),
  "work.setKind": z.object({ source: z.string().min(1).max(200), kind: z.string().min(1).max(100) }),
  "work.translate": modelInput.extend({ from: z.number().int().min(0).max(1_000_000).optional(), redo: z.boolean().optional() }),
  "work.setPart": z.object({ paragraph: z.number().int().min(0).max(1_000_000), text: z.string().max(1_000_000) }),
  "work.retranslate": modelInput.extend({ paragraph: z.number().int().min(0).max(1_000_000) }),
  "notes.cancel": z.undefined(),
  "knowledge.list": z.object({ text: z.string().max(500).optional(), kind: z.enum(["term", "note", "scene", "summary"]).optional(), status: z.enum(["suggested", "confirmed"]).optional(), by: z.enum(["user", "model"]).optional() }),
  "knowledge.files": z.undefined(),
  "knowledge.file": z.object({ id: id }),
  "knowledge.setFile": z.object({ id: id, text: z.string().max(2_000_000) }),
  "knowledge.create": z.object({ type: z.string().min(1).max(100), name: z.string().min(1).max(500) }),
  "knowledge.delete": z.object({ id: id }),
  "knowledge.resolve": z.object({ name: z.string().max(500) }),
  "knowledge.confirm": z.object({ ids: z.array(id).max(5000).optional() }),
};

/**
 * Turns "command + data from the window" into a result. The window is not trusted: every message
 * is checked against a schema first, and failures come back as plain messages, never as crashes.
 */
export function createHandler(service: WorkspaceService, provider?: ProviderService, project?: ProjectService) {
  type Run = (p: any) => unknown | Promise<unknown>;
  const needProvider = (): ProviderService => {
    if (!provider) throw new UserError("no_provider", "No model server connection is set up.");
    return provider;
  };
  const needProject = (): ProjectService => {
    if (!project) throw new UserError("no_project", "Projects are not available here.");
    return project;
  };
  const run_: Record<CommandName, Run> = {
    "workspace.snapshot": () => service.snapshot(),
      "project.save": async (p) => (await needProject().save(p.saveAs), service.snapshot()),
    "project.open": async (p) => (await needProject().open(p.useBackup), service.snapshot()),
    "project.new": () => (needProject().newProject(), service.snapshot()),
    "project.rename": (p) => (needProject().rename(p.title), service.snapshot()),
    "project.restoreRecovery": () => (needProject().restoreRecovery(), service.snapshot()),
    "project.discardRecovery": () => (needProject().discardRecovery(), service.snapshot()),
    "project.dismissProblem": () => (needProject().dismissProblem(), service.snapshot()),
        "settings.sync": (p) => service.syncSettings(p),
    "document.create": (p) => service.createDocument(p.title),
    "document.select": (p) => service.selectDocument(p.documentId),
    "document.rename": (p) => service.renameDocument(p.documentId, p.title),
    "document.delete": (p) => service.deleteDocument(p.documentId),
    "document.setText": (p) => service.setDraft(p.documentId, p.text),
                              "notes.cancel": () => service.cancelAnalysis(),
    "work.get": () => service.workGet(),
    "work.sync": (p) => service.workSync(p),
    "work.setSpeaker": (p) => service.workSetSpeaker(p.line, p.speaker),
    "work.suggest": (p) => service.workSuggest(p),
    "work.acceptSuggestion": (p) => service.workAcceptSuggestion(p.source, p.key),
    "work.dismissSuggestion": (p) => service.workDismissSuggestion(p.source, p.key),
    "work.acceptSpeaker": (p) => service.workAcceptSpeaker(p.line),
    "work.addWord": (p) => service.workAddWord(p.source),
    "work.setAttribute": (p) => service.workSetAttribute(p.source, p.key, p.values),
    "work.setKind": (p) => service.workSetKind(p.source, p.kind),
    "work.setEnglish": (p) => service.workSetEnglish(p.source, p.english),
    "work.setHint": (p) => service.workSetHint(p.source, p.hint),
    "work.setUse": (p) => service.workSetUse(p.source, p.use),
    "work.translate": (p) => service.workTranslate(p),
    "work.setPart": (p) => service.workSetPart(p.paragraph, p.text),
    "work.retranslate": (p) => service.workRetranslate(p),
    "knowledge.files": () => service.knowledgeFiles(),
    "knowledge.file": (p) => service.knowledgeFile(p.id),
    "knowledge.setFile": (p) => service.knowledgeSetFile(p.id, p.text),
    "knowledge.create": (p) => service.knowledgeCreate(p.type, p.name),
    "knowledge.delete": (p) => service.knowledgeDelete(p.id),
    "knowledge.resolve": (p) => service.knowledgeResolve(p.name),
    "knowledge.list": (p) => service.knowledgeList(p),
        "knowledge.confirm": (p) => service.knowledgeConfirm(p.ids),
          "provider.get": () => needProvider().view(),
    "provider.save": (p) => needProvider().save(p),
    "provider.test": () => needProvider().test(),
  };
  return async (requestId: unknown, command: unknown, payload: unknown): Promise<IpcResult<CommandResultMap[CommandName]>> => {
    const rid = typeof requestId === "string" ? requestId.slice(0, 100) : "";
    if (typeof command !== "string" || !Object.hasOwn(schemas, command)) {
      return { requestId: rid, ok: false, error: { code: "unknown_command", message: "Unknown command." } };
    }
    const name = command as CommandName;
    const parsed = schemas[name]!.safeParse(payload);
    if (!parsed.success) {
      return { requestId: rid, ok: false, error: { code: "invalid_payload", message: "The request was malformed." } };
    }
    try {
      return { requestId: rid, ok: true, value: (await run_[name](parsed.data)) as CommandResultMap[CommandName] };
    } catch (e) {
      if (e instanceof UserError) return { requestId: rid, ok: false, error: { code: e.code, message: e.message } };
      return { requestId: rid, ok: false, error: { code: "internal", message: "Something went wrong inside the app." } };
    }
  };
}
