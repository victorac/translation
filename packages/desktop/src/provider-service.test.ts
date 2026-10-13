import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUserMessage, type ModelSetting, type StartJobInput } from "@ltw/domain";
import { createHandler } from "./handlers.js";
import { ProviderService } from "./provider-service.js";
import { WorkspaceService } from "./service.js";
import { EncryptedFileCredentialStore, FileSettingsStore, MemoryCredentialStore, MemorySettingsStore, DEFAULT_SETTINGS } from "./storage.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** What the stand-in "translates" a block into: not the source text, so it does not look untranslated. */
const fakeEnglish = (source: string): string => source.replace(/[\u3000-\u9fff]/g, "a");

/** A small stand-in for LM Studio: lists two models and "translates" by echoing the source block. */
async function fakeLmStudio(opts: { loaded?: string[]; apiKey?: string; failBlock?: string } = {}) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Invalid API key"}}');
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen2.5-7b-instruct" }, { id: "gemma-2-9b" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const j = JSON.parse(body) as { model: string; messages: { content: string }[] };
        if (opts.loaded && !opts.loaded.includes(j.model)) {
          res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"No models loaded. Please load a model in the developer page."}}');
          return;
        }
        const source = parseUserMessage(j.messages[1]!.content)!.sourceBlock;
        if (opts.failBlock && source.includes(opts.failBlock)) {
          res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"Trying to keep the first 9000 tokens when context overflows"}}');
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const text = `EN(${j.model}): ${fakeEnglish(source)}`;
        let i = 0;
        const parts = Array.from(text);
        const tick = () => {
          if (i < parts.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts.slice(i, i + 4).join("") }, finish_reason: null }] })}\n\n`);
            i += 4;
            setTimeout(tick, 1);
          } else {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
            res.end();
          }
        };
        tick();
        return;
      }
      res.writeHead(404).end("not found");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, server };
}

const model = (name: string, over: Partial<ModelSetting> = {}): ModelSetting => ({ name, contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2, promptId: "standard", useGlossary: true, ...over });
const TEXT = "一つ目の段落です。\n\n二つ目の段落です。\n\n三つ目の段落です。";
const job = (over: Partial<StartJobInput> = {}): StartJobInput => ({
  text: TEXT,
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  backend: "provider",
  models: [model("qwen2.5-7b-instruct")],
  glossary: [],
  prompts: [],
  blockSize: "normal",
  rerun: [],
  demo: { speed: "fast", smallBlocks: false, failBlockOnce: null, firstModelUnloaded: false },
  ...over,
});
const setup = () => {
  const settings = new MemorySettingsStore();
  const creds = new MemoryCredentialStore();
  const provider = new ProviderService(settings, creds);
  const service = new WorkspaceService({ provider });
  return { settings, creds, provider, service };
};

describe("saved connection", () => {
  it("starts with LM Studio's usual local address", () => {
    expect(setup().provider.view()).toMatchObject({ baseUrl: "http://localhost:1234/v1", loopback: true, hasApiKey: false, problem: null });
  });

  it("saves a local address and an API key without ever returning the key", async () => {
    const { provider, creds, settings } = setup();
    const v = provider.save({ baseUrl: "http://127.0.0.1:5555/v1/", allowRemote: false, apiKey: "sk-secret" });
    expect(v).toMatchObject({ baseUrl: "http://127.0.0.1:5555/v1", hasApiKey: true });
    expect(JSON.stringify(v)).not.toContain("sk-secret");
    expect(JSON.stringify(settings.load())).not.toContain("sk-secret");
    expect(creds.get("local-provider")).toBe("sk-secret");
    expect(provider.save({ baseUrl: "http://127.0.0.1:5555/v1", allowRemote: false }).hasApiKey).toBe(true); // key kept
    expect(provider.save({ baseUrl: "http://127.0.0.1:5555/v1", allowRemote: false, apiKey: "" }).hasApiKey).toBe(false); // removed
  });

  it("AC-15: a non-local host is refused until the user approves it", () => {
    const { provider } = setup();
    expect(() => provider.save({ baseUrl: "http://192.168.1.20:1234/v1", allowRemote: false })).toThrow(/not on this computer/);
    expect(provider.view().baseUrl).toBe("http://localhost:1234/v1");
    const v = provider.save({ baseUrl: "http://192.168.1.20:1234/v1", allowRemote: true });
    expect(v).toMatchObject({ loopback: false, remoteAllowed: true, problem: null, host: "192.168.1.20:1234" });
    // moving back to this computer clears the approval
    provider.save({ baseUrl: "http://localhost:1234/v1", allowRemote: false });
    expect(provider.view().remoteAllowed).toBe(false);
  });

  it("rejects bad addresses with an explanation", () => {
    const { provider } = setup();
    expect(() => provider.save({ baseUrl: "ftp://x", allowRemote: false })).toThrow(/http/);
    expect(() => provider.save({ baseUrl: "http://u:p@localhost/v1", allowRemote: false })).toThrow(/API key field/);
  });
});

describe("testing the connection", () => {
  it("lists the server's models and warns that listed is not loaded", async () => {
    const lm = await fakeLmStudio();
    const { provider } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const r = await provider.test();
    expect(r).toMatchObject({ ok: true, models: ["qwen2.5-7b-instruct", "gemma-2-9b"] });
    expect(r.message).toMatch(/does not mean a model is loaded/);
  });

  it("tells the user to start the server when nothing is listening", async () => {
    const lm = await fakeLmStudio();
    const { provider } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await new Promise<void>((r) => lm.server.close(() => r()));
    const r = await provider.test();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Start the LM Studio server/);
  });

  it("explains a missing or wrong key and sends the saved key", async () => {
    const lm = await fakeLmStudio({ apiKey: "right-key" });
    const { provider } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    expect((await provider.test()).message).toMatch(/API key/);
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false, apiKey: "right-key" });
    expect((await provider.test()).ok).toBe(true);
  });
});

describe("translating through the saved connection", () => {
  it("AC-18 (stand-in): runs a job against the server and fills every block", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    service.start(job({ models: [model("qwen2.5-7b-instruct"), model("gemma-2-9b", { temperature: 0.7 })] }));
    await service.whenIdle();
    const snap = service.snapshot();
    expect(snap.job?.state).toBe("completed");
    const block = snap.revision!.blocks[0]!;
    expect(snap.runs[0]!.blocks[block.id]!.text).toBe(`EN(qwen2.5-7b-instruct): ${fakeEnglish(block.text)}`);
    expect(snap.runs[1]!.blocks[block.id]!.text).toBe(`EN(gemma-2-9b): ${fakeEnglish(block.text)}`);
    const posts = lm.seen.filter((s) => s.method === "POST");
    expect(posts.map((p) => JSON.parse(p.body).model)).toEqual([...Array(posts.length / 2).fill("qwen2.5-7b-instruct"), ...Array(posts.length / 2).fill("gemma-2-9b")]);
    expect(JSON.parse(posts.at(-1)!.body)).toMatchObject({ temperature: 0.7, max_tokens: 1536, stream: true });
  });

  it("sends the API key with each request", async () => {
    const lm = await fakeLmStudio({ apiKey: "k1" });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false, apiKey: "k1" });
    service.start(job());
    await service.whenIdle();
    expect(service.snapshot().job?.state).toBe("completed");
    expect(lm.seen.every((s) => s.headers.authorization === "Bearer k1")).toBe(true);
  });

  it("an unloaded model puts the run in Waiting with LM Studio's instructions, and Retry works once it is loaded", async () => {
    const loaded: string[] = [];
    const lm = await fakeLmStudio({ loaded });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    service.start(job());
    for (let i = 0; i < 200 && !service.snapshot().waiting; i++) await new Promise((r) => setTimeout(r, 10));
    const w = service.snapshot().waiting!;
    expect(w).toMatchObject({ code: "model_unavailable" });
    expect(w.message).toMatch(/Load the model in LM Studio/);
    loaded.push("qwen2.5-7b-instruct");
    service.resolveWaiting(w.runId, "retry");
    await service.whenIdle();
    expect(service.snapshot().job?.state).toBe("completed");
  });

  it("a context overflow stops the run with guidance instead of retrying", async () => {
    const lm = await fakeLmStudio({ failBlock: "二つ目" });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    service.start(job({ text: "一つ目の段落です。\n\n二つ目の段落です。" }));
    for (let i = 0; i < 300 && !service.snapshot().waiting; i++) await new Promise((r) => setTimeout(r, 10));
    const snap = service.snapshot();
    expect(snap.waiting).toMatchObject({ code: "context_overflow" });
    expect(snap.waiting!.message).toMatch(/context/i);
    service.cancel({ kind: "job" });
    await service.whenIdle();
    expect(lm.seen.filter((s) => s.method === "POST")).toHaveLength(1); // not retried
  });

  it("refuses to start with a bad connection or without one", () => {
    const { provider, service } = setup();
    expect(() => new WorkspaceService().start(job())).toThrow(/No model server connection/);
    void provider;
    // an unapproved remote host saved earlier by hand-editing the settings file
    const settings = new MemorySettingsStore();
    settings.save({ ...DEFAULT_SETTINGS, provider: { baseUrl: "http://192.168.9.9:1234/v1", allowedRemoteHost: null } });
    const s2 = new WorkspaceService({ provider: new ProviderService(settings, new MemoryCredentialStore()) });
    expect(() => s2.start(job())).toThrow(/not on this computer/);
    void service;
  });

  it("rejects output limits that do not leave room in the context", () => {
    const { service } = setup();
    expect(() => service.start(job({ models: [model("m", { contextLimit: 1024, maxOutputTokens: 1024 })] }))).toThrow(/smaller than the context/);
  });

  it("through the command handler, test and save report plain results", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    const h = createHandler(service, provider);
    expect(await h("1", "provider.save", { baseUrl: lm.baseUrl, allowRemote: false })).toMatchObject({ ok: true, value: { loopback: true } });
    expect(await h("2", "provider.test", undefined)).toMatchObject({ ok: true, value: { ok: true } });
    expect(await h("3", "provider.save", { baseUrl: "http://10.0.0.5:1234/v1", allowRemote: false })).toMatchObject({ ok: false, error: { code: "remote_not_allowed" } });
  });
});

describe("glossary and prompt styles with a real server connection", () => {
  const style = { id: "mine", name: "Brisk", description: "", template: "Translate {sourceLanguage} to {targetLanguage} briskly.", appendFraming: true };
  const posts = (lm: { seen: Seen[] }) => lm.seen.filter((s) => s.method === "POST").map((s) => JSON.parse(s.body) as { model: string; messages: { content: string }[] });

  it("sends each model its own style and only the glossary entries a block needs", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    service.start(
      job({
        text: "魔王が来た。",
        glossary: [{ source: "魔王", target: "Demon King", note: "villain" }, { source: "勇者", target: "Hero" }],
        prompts: [style],
        models: [model("qwen2.5-7b-instruct"), model("qwen2.5-7b-instruct", { promptId: "mine" }), model("qwen2.5-7b-instruct", { promptId: "literary" })],
      }),
    );
    await service.whenIdle();
    const sent = posts(lm);
    expect(sent).toHaveLength(3);
    expect(sent[0]!.messages[0]!.content).toContain("SOURCE_BLOCK"); // standard style
    expect(sent[1]!.messages[0]!.content).toMatch(/^Translate Japanese to English briskly\./);
    expect(sent[1]!.messages[0]!.content).toContain("SOURCE_BLOCK"); // layout notes were added
    expect(parseUserMessage(sent[0]!.messages[1]!.content)!.glossary).toEqual([{ source: "魔王", target: "Demon King" }]); // 勇者 is not in the block
    expect(parseUserMessage(sent[2]!.messages[1]!.content)!.glossary).toEqual([{ source: "魔王", target: "Demon King" }]);
    expect(service.snapshot().runs.map((r) => r.label)).toEqual(["qwen2.5-7b-instruct", "qwen2.5-7b-instruct · Brisk", "qwen2.5-7b-instruct · Natural, literary"]);
  });

  it("flags a block whose required term is missing, with the reason, and the user can accept it", async () => {
    const lm = await fakeLmStudio(); // this stand-in ignores the glossary
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    service.start(job({ text: "魔王が来た。", glossary: [{ source: "魔王", target: "Demon King" }] }));
    await service.whenIdle();
    let snap = service.snapshot();
    const run = snap.runs[0]!;
    const blockId = snap.revision!.blocks[0]!.id;
    expect(run.blocks[blockId]).toMatchObject({ state: "needs_review", reviewNotes: ['Glossary: "魔王" should be "Demon King", but that was not found.'] });
    expect(snap.job?.state).toBe("completed_with_issues");
    service.acceptReview(run.id, blockId);
    snap = service.snapshot();
    expect(snap.runs[0]!.blocks[blockId]).toMatchObject({ state: "succeeded", reviewNotes: [] });
  });

  it("a flagged block that finished normally is still used as context for the next block", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const text = `魔王が来た。${"あ".repeat(550)}。\n\n${"い".repeat(100)}。`; // two blocks at the default size
    service.start(job({ text, glossary: [{ source: "魔王", target: "Demon King" }] }));
    await service.whenIdle();
    const snap = service.snapshot();
    expect(snap.revision!.blocks).toHaveLength(2);
    expect(snap.runs[0]!.blocks[snap.revision!.blocks[0]!.id]!.state).toBe("needs_review");
    const sent = posts(lm);
    expect(sent).toHaveLength(2);
    expect(parseUserMessage(sent[1]!.messages[1]!.content)!.context).toMatchObject({ translation: expect.any(String) });
  });
});

describe("storage", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ltw-"));

  it("settings survive a restart and damaged settings are set aside", () => {
    const path = join(dir(), "settings.json");
    const store = new FileSettingsStore(path);
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    store.save({ version: 1, provider: { baseUrl: "http://localhost:9/v1", allowedRemoteHost: null } });
    expect(new FileSettingsStore(path).load().provider.baseUrl).toBe("http://localhost:9/v1");
    writeFileSync(path, "{ not json");
    expect(new FileSettingsStore(path).load()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(`${path}.damaged`)).toBe(true);
  });

  it("API keys are encrypted on disk and never appear in plain text", () => {
    const path = join(dir(), "credentials.json");
    const cipher = {
      isAvailable: () => true,
      encrypt: (s: string) => Buffer.from(s.split("").reverse().join("") + "#enc"),
      decrypt: (b: Buffer) => b.toString().replace(/#enc$/, "").split("").reverse().join(""),
    };
    const store = new EncryptedFileCredentialStore(path, cipher);
    store.set("ref", "sk-very-secret");
    expect(readFileSync(path, "utf8")).not.toContain("sk-very-secret");
    const reopened = new EncryptedFileCredentialStore(path, cipher);
    expect(reopened.has("ref")).toBe(true);
    expect(reopened.get("ref")).toBe("sk-very-secret");
    reopened.delete("ref");
    expect(new EncryptedFileCredentialStore(path, cipher).has("ref")).toBe(false);
  });

  it("refuses to save a key when secure storage is unavailable", () => {
    const store = new EncryptedFileCredentialStore(join(dir(), "c.json"), { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
    expect(() => store.set("r", "k")).toThrow(/secure storage/);
  });
});
