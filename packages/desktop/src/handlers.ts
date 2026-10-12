import { z } from "zod";
import type { CommandName, CommandResultMap, IpcResult } from "@ltw/domain";
import { UserError } from "./errors.js";
import type { ProviderService } from "./provider-service.js";
import type { WorkspaceService } from "./service.js";

const id = z.string().min(1).max(200);
const run = z.object({ runId: id });
const block = z.object({ runId: id, blockId: id });
const MAX_TEXT = 4_000_000; // characters; the real limit (1 MiB of UTF-8) is enforced by the service

const schemas: Record<CommandName, z.ZodType> = {
  "workspace.snapshot": z.undefined(),
  "workspace.reset": z.undefined(),
  "demo.loadModel": z.undefined(),
  "provider.get": z.undefined(),
  "provider.test": z.undefined(),
  "provider.save": z.object({ baseUrl: z.string().max(2000), allowRemote: z.boolean(), apiKey: z.string().max(2000).optional() }),
  "job.start": z.object({
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
        }),
      )
      .max(50),
    demo: z.object({
      speed: z.enum(["fast", "normal", "slow"]),
      smallBlocks: z.boolean(),
      failBlockOnce: z.number().int().min(1).max(100_000).nullable(),
      firstModelUnloaded: z.boolean(),
    }),
  }),
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
};

/**
 * Turns "command + data from the window" into a result. The window is not trusted: every message
 * is checked against a schema first, and failures come back as plain messages, never as crashes.
 */
export function createHandler(service: WorkspaceService, provider?: ProviderService) {
  type Run = (p: any) => unknown | Promise<unknown>;
  const needProvider = (): ProviderService => {
    if (!provider) throw new UserError("no_provider", "No model server connection is set up.");
    return provider;
  };
  const run_: Record<CommandName, Run> = {
    "workspace.snapshot": () => service.snapshot(),
    "workspace.reset": () => service.reset(),
    "demo.loadModel": () => service.loadDemoModel(),
    "job.start": (p) => service.start(p),
    "job.cancel": (p) => service.cancel(p),
    "block.retry": (p) => service.retryBlock(p.runId, p.blockId),
    "block.acceptCandidate": (p) => service.acceptCandidate(p.runId, p.blockId),
    "block.keepCurrent": (p) => service.keepCurrent(p.runId, p.blockId),
    "block.acceptReview": (p) => service.acceptReview(p.runId, p.blockId),
    "block.edit": (p) => service.editBlock(p.runId, p.blockId, p.text),
    "run.retryUnfinished": (p) => service.retryUnfinished(p.runId),
    "run.retranslateDownstream": (p) => service.retranslateDownstream(p.runId),
    "run.resolveWaiting": (p) => service.resolveWaiting(p.runId, p.resolution),
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
