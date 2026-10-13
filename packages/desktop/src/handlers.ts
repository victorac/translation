import { z } from "zod";
import type { CommandName, CommandResultMap, IpcResult } from "@ltw/domain";
import { UserError } from "./errors.js";
import type { ProjectService } from "./project-service.js";
import type { ProviderService } from "./provider-service.js";
import type { WorkspaceService } from "./service.js";

const id = z.string().min(1).max(200);
const run = z.object({ runId: id });
const block = z.object({ runId: id, blockId: id });
const MAX_TEXT = 4_000_000; // characters; the real limit (1 MiB of UTF-8) is enforced by the service

const exportInput = z.object({
  format: z.enum(["text", "markdown", "csv"]),
  runIds: z.array(id).max(8),
  textVersion: z.enum(["current", "original"]),
  allowPartial: z.boolean(),
  formulaSafe: z.boolean(),
});

const startInput = z.object({
    text: z.string().max(MAX_TEXT),
    sourceLanguage: z.string().max(100),
    targetLanguage: z.string().max(100),
    backend: z.enum(["provider", "practice"]),
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
    glossary: z
      .array(z.object({ source: z.string().max(1000), target: z.string().max(1000), note: z.string().max(1000).optional() }))
      .max(2000),
    prompts: z
      .array(z.object({ id: z.string().min(1).max(100), name: z.string().max(200), description: z.string().max(500), template: z.string().max(20_000), appendFraming: z.boolean() }))
      .max(100),
    blockSize: z.enum(["small", "normal", "large"]),
    rerun: z.array(z.string().max(500)).max(20),
    demo: z.object({
      speed: z.enum(["fast", "normal", "slow"]),
      smallBlocks: z.boolean(),
      failBlockOnce: z.number().int().min(1).max(100_000).nullable(),
      firstModelUnloaded: z.boolean(),
    }),
  });

const syncInput = startInput.pick({ sourceLanguage: true, targetLanguage: true, models: true, glossary: true, prompts: true, blockSize: true });

const schemas: Record<CommandName, z.ZodType> = {
  "workspace.snapshot": z.undefined(),
  "workspace.reset": z.undefined(),
  "demo.loadModel": z.undefined(),
  "project.save": z.object({ saveAs: z.boolean() }),
  "project.open": z.object({ useBackup: z.boolean() }),
  "project.new": z.undefined(),
  "project.restoreRecovery": z.undefined(),
  "project.discardRecovery": z.undefined(),
  "project.dismissProblem": z.undefined(),
  "export.preview": exportInput,
  "export.write": exportInput,
  "provider.get": z.undefined(),
  "provider.test": z.undefined(),
  "provider.save": z.object({ baseUrl: z.string().max(2000), allowRemote: z.boolean(), apiKey: z.string().max(2000).optional() }),
  "job.start": startInput,
  "settings.sync": syncInput,
  "document.create": z.object({ title: z.string().max(200).optional() }),
  "document.select": z.object({ documentId: id }),
  "document.rename": z.object({ documentId: id, title: z.string().max(200) }),
  "document.delete": z.object({ documentId: id }),
  "document.setText": z.object({ documentId: id, text: z.string().max(5_000_000) }),
  "source.preview": startInput,
  "job.cancel": z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("job") }),
    z.object({ kind: z.literal("run"), runId: id }),
    z.object({ kind: z.literal("block"), runId: id, blockId: id }),
  ]),
  "block.retry": block,
  "block.acceptCandidate": block,
  "block.keepCurrent": block,
  "block.acceptReview": block,
  "block.edit": z.object({ runId: id, blockId: id, text: z.string().max(MAX_TEXT) }),
  "run.retryUnfinished": run,
  "run.retranslateDownstream": run,
  "run.resolveWaiting": z.object({ runId: id, resolution: z.enum(["retry", "skip"]) }),
  "run.archive": run,
  "run.restore": run,
  "version.view": z.object({ versionId: id }),
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
    "workspace.reset": () => (project ? (project.newProject(), service.snapshot()) : service.reset()),
    "project.save": async (p) => (await needProject().save(p.saveAs), service.snapshot()),
    "project.open": async (p) => (await needProject().open(p.useBackup), service.snapshot()),
    "project.new": () => (needProject().newProject(), service.snapshot()),
    "project.restoreRecovery": () => (needProject().restoreRecovery(), service.snapshot()),
    "project.discardRecovery": () => (needProject().discardRecovery(), service.snapshot()),
    "project.dismissProblem": () => (needProject().dismissProblem(), service.snapshot()),
    "demo.loadModel": () => service.loadDemoModel(),
    "job.start": (p) => service.start(p),
    "settings.sync": (p) => service.syncSettings(p),
    "document.create": (p) => service.createDocument(p.title),
    "document.select": (p) => service.selectDocument(p.documentId),
    "document.rename": (p) => service.renameDocument(p.documentId, p.title),
    "document.delete": (p) => service.deleteDocument(p.documentId),
    "document.setText": (p) => service.setDraft(p.documentId, p.text),
    "job.cancel": (p) => service.cancel(p),
    "block.retry": (p) => service.retryBlock(p.runId, p.blockId),
    "block.acceptCandidate": (p) => service.acceptCandidate(p.runId, p.blockId),
    "block.keepCurrent": (p) => service.keepCurrent(p.runId, p.blockId),
    "block.acceptReview": (p) => service.acceptReview(p.runId, p.blockId),
    "block.edit": (p) => service.editBlock(p.runId, p.blockId, p.text),
    "run.retryUnfinished": (p) => service.retryUnfinished(p.runId),
    "run.retranslateDownstream": (p) => service.retranslateDownstream(p.runId),
    "run.resolveWaiting": (p) => service.resolveWaiting(p.runId, p.resolution),
    "run.archive": (p) => service.archiveRun(p.runId),
    "run.restore": (p) => service.restoreArchivedRun(p.runId),
    "version.view": (p) => service.viewVersion(p.versionId),
    "source.preview": (p) => service.previewSplit(p),
    "export.preview": (p) => needProject().exportPreview(p),
    "export.write": (p) => needProject().exportFile(p),
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
