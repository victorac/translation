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
async function fakeLmStudio(opts: { loaded?: string[]; apiKey?: string; failBlock?: string; analysisReply?: string; researchReply?: string } = {}) {
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
        const researching = j.messages[0]!.content.includes("prepare background for a translator");
        const summarizing = j.messages[0]!.content.includes("abridged version of the chapter");
        const reading = researching || summarizing || j.messages[0]!.content.includes("help a translator prepare");
        const source = reading ? "" : parseUserMessage(j.messages[1]!.content)!.sourceBlock;
        if (opts.failBlock && source.includes(opts.failBlock)) {
          res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"Trying to keep the first 9000 tokens when context overflows"}}');
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const text = reading ? (summarizing ? "A short summary of the chapter." : researching ? (opts.researchReply ?? "NONE") : (opts.analysisReply ?? "NONE")) : `EN(${j.model}): ${fakeEnglish(source)}`;
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

describe("suggested knowledge", () => {
  const ask = (over = {}) => ({
    backend: "provider" as const,
    modelId: "qwen2.5-7b-instruct",
    contextLimit: 4096,
    maxOutputTokens: 512,
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    passage: "「え、だって花子、昨日は休みだったんだろ？」",
    documentId: "doc1",
    documentTitle: "Chapter 1",
    block: 3,
    ...over,
  });
  const reply = "CHARACTER: 花子 / 花ちゃん = Hanako | girl\nFACT: 花子 | Is addressed by her first name.\nSCENE: NEW | 花子 | Taro asks Hanako why she was absent yesterday.";

  it("reads a passage and adds terms, facts attached to their person, and a scene tied to the block", async () => {
    const lm = await fakeLmStudio({ analysisReply: reply });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const r = await service.analyze(ask());
    expect(r).toEqual({ added: 3, canceled: false });
    const origin = { by: "model", model: "qwen2.5-7b-instruct", documentTitle: "Chapter 1", block: 3 };
    const [term, fact, scene] = service.knowledgeList({}).entries;
    expect(term).toMatchObject({ kind: "term", source: "花子", aliases: ["花ちゃん"], category: "character", target: "Hanako", hint: "girl", status: "suggested", origin });
    expect(fact).toMatchObject({ kind: "note", about: term!.id, text: "Is addressed by her first name." });
    expect(scene).toMatchObject({ kind: "scene", related: [term!.id], scope: { documentId: "doc1", block: 3 }, text: "Taro asks Hanako why she was absent yesterday." });
    expect(service.snapshot().knowledge).toMatchObject({ terms: 1, notes: 1, scenes: 1, suggested: 3 });
    const sent = lm.seen.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as { messages: { content: string }[] }).at(-1)!;
    expect(sent.messages[1]!.content).toContain("PASSAGE:\n「え、だって花子");
  });

  it("fits a long block in a small context by reserving only the reply it needs, and trims what is already known to make room", async () => {
    const lm = await fakeLmStudio({ analysisReply: reply });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    for (let i = 0; i < 40; i++) service.knowledgeSave({ kind: "term", source: `名${i}`, target: `Name${i}`, hint: "a hint that takes some room in the list", text: "", about: null, category: "term" as const, aliases: [] });
    // The model's reply limit is for translations (1536); reading for knowledge only needs a short reply.
    const r = await service.analyze(ask({ passage: "あ".repeat(600), contextLimit: 4096, maxOutputTokens: 1536 }));
    expect(r.canceled).toBe(false);
    const sent = lm.seen.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as { max_tokens: number; messages: { content: string }[] }).at(-1)!;
    expect(sent.max_tokens).toBe(700);
    expect(sent.messages[1]!.content).toContain("PASSAGE:\n" + "あ".repeat(600));
  });

  it("says how much room a block needs when it cannot fit at all", async () => {
    const lm = await fakeLmStudio({ analysisReply: reply });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await expect(service.analyze(ask({ passage: "あ".repeat(3000), contextLimit: 4096 }))).rejects.toThrow(/needs about \d+ tokens.*set to 4096/);
  });

  it("tells the next passage what the scene before it was, and removing a person removes their facts", async () => {
    const lm = await fakeLmStudio({ analysisReply: reply });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await service.analyze(ask({ block: 1 }));
    await service.analyze(ask({ block: 2, passage: "次の文。" }));
    const bodies = lm.seen.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as { messages: { content: string }[] });
    expect(bodies[1]!.messages[1]!.content).toContain("The scene before this passage (block 1): Taro asks Hanako");
    expect(bodies[1]!.messages[1]!.content).toContain("CHARACTER: 花子 / 花ちゃん = Hanako | girl\n  fact: Is addressed by her first name.");
    const person = service.knowledgeList({ kind: "term" }).entries[0]!;
    service.knowledgeRemove([person.id]);
    expect(service.knowledgeList({}).entries.map((e) => e.kind)).toEqual(["scene", "scene"]);
    expect(service.knowledgeList({ kind: "scene" }).entries.every((e) => e.related.length === 0)).toBe(true);
  });

  it("can be run again: unchecked suggestions are replaced, what was confirmed stays, and what was rejected is not suggested again", async () => {
    const lm = await fakeLmStudio({ analysisReply: "CHARACTER: 花子 = Hanako | girl\nCHARACTER: 太郎 = Taro | boy\nFACT: 花子 | Is polite.\nSCENE: NEW | 花子 | A scene." });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    await service.analyze(ask({ documentId: docId, documentTitle: "Document 1" }));
    // The user corrects and accepts one person, and deletes another from the text.
    const doc = service.knowledgeText().text;
    expect(doc).toContain("## 花子 = Hanako ?");
    const edited = doc.replace("## 花子 = Hanako ?", "## 花子 = Hanako-san").replace(/## 太郎 = Taro \?[^\n]*\nboy\n\n/, "");
    expect(service.knowledgeSetText(edited).problems).toEqual([]);
    expect(service.snapshot().knowledge).toMatchObject({ terms: 1, suggested: 2 }); // the fact and the scene are still unchecked

    // Reading again forgets the unchecked ones.
    expect(service.beginExtraction(docId)).toEqual({ discarded: 2 });
    expect(service.knowledgeList({}).entries.map((e) => e.kind)).toEqual(["term"]);
    await service.analyze(ask({ documentId: docId, documentTitle: "Document 1" }));
    const bodies = lm.seen.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as { messages: { content: string }[] });
    const second = bodies.at(-1)!.messages[1]!.content;
    expect(second).toContain("CHARACTER: 花子 = Hanako-san | girl"); // the corrected, confirmed version is what the model is shown
    expect(second).toContain("REJECTED (the user checked these and they are wrong; do not suggest them again):\nCHARACTER: 太郎 = Taro | boy");
    const now = service.knowledgeList({}).entries;
    expect(now.filter((e) => e.kind === "term").map((e) => `${e.source}:${e.target}:${e.status}`)).toEqual(["花子:Hanako-san:confirmed"]); // 太郎 came back from the model and was refused; 花子 was not duplicated
    expect(now.filter((e) => e.kind === "note")).toHaveLength(1);
  });

  it("keeps a suggestion that something confirmed depends on when the text is read again", async () => {
    const lm = await fakeLmStudio({ analysisReply: "CHARACTER: 花子 = Hanako | girl\nSCENE: NEW | 花子 | A scene." });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    await service.analyze(ask({ documentId: docId, documentTitle: "Document 1" }));
    const doc = service.knowledgeText().text;
    service.knowledgeSetText(doc.replace(/## Block 3 \| 花子 \?/, "## Block 3 | 花子")); // the scene is accepted, the person is not
    expect(service.beginExtraction(docId)).toEqual({ discarded: 0 });
    expect(service.knowledgeList({ kind: "term" }).entries).toHaveLength(1);
  });

  it("lets a scene run over several blocks when the model says the passage continues it", async () => {
    const lm = await fakeLmStudio({ analysisReply: "SCENE: CONTINUES | At the gate, still talking." });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await service.analyze(ask({ block: 1, passage: "一つ目。" }));
    await service.analyze(ask({ block: 2, passage: "二つ目。" }));
    await service.analyze(ask({ block: 3, passage: "三つ目。" }));
    const scenes = service.knowledgeList({ kind: "scene" }).entries;
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.scope).toMatchObject({ block: 1, blockEnd: 3 });
    expect(scenes[0]!.scope?.blockHashes).toHaveLength(3);
  });

  it("writes a summary of a document from its scenes, and keeps one the user confirmed", async () => {
    const lm = await fakeLmStudio({ analysisReply: reply });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const sum = { backend: "provider" as const, modelId: "qwen2.5-7b-instruct", contextLimit: 4096, maxOutputTokens: 512, sourceLanguage: "Japanese", targetLanguage: "English", documentId: "doc1", documentTitle: "Chapter 1" };
    expect(await service.summarize(sum)).toEqual({ updated: false, canceled: false }); // no scenes yet
    await service.analyze(ask());
    expect(await service.summarize(sum)).toEqual({ updated: true, canceled: false });
    const summary = service.knowledgeList({ kind: "summary" }).entries[0]!;
    expect(summary).toMatchObject({ text: "A short summary of the chapter.", status: "suggested", scope: { documentId: "doc1" } });
    service.knowledgeSave({ id: summary.id, kind: "summary", source: "", target: "", hint: "", text: "My own summary.", about: null, category: "term" as const, aliases: [] });
    expect(await service.summarize(sum)).toEqual({ updated: false, canceled: false });
    expect(service.knowledgeList({ kind: "summary" }).entries[0]!.text).toBe("My own summary.");
  });

  it("explains a problem in plain words and does not run while translating", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await expect(service.analyze(ask({ contextLimit: 512, maxOutputTokens: 500 }))).rejects.toThrow(/needs about/);
    service.start(job());
    await expect(service.analyze(ask())).rejects.toThrow(/Wait for the translations/);
    await service.whenIdle();
  });
});

describe("choosing the background for each block", () => {
  const ask = (passage: string, over = {}) => ({ backend: "provider" as const, modelId: "qwen2.5-7b-instruct", contextLimit: 4096, maxOutputTokens: 512, sourceLanguage: "Japanese", targetLanguage: "English", passage, ...over });
  const save = (service: ReturnType<typeof setup>["service"], source: string, target: string, hint = "") => service.knowledgeSave({ kind: "term", source, target, hint, text: "", about: null, category: "term" as const, aliases: [] });
  const bodies = (lm: { seen: Seen[] }) => lm.seen.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as { messages: { content: string }[] });

  it("lets a model choose, so a person who is only implied still reaches the translation", async () => {
    const lm = await fakeLmStudio({ researchReply: "2" });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    save(service, "魔王", "Demon King");
    save(service, "勇者", "Hero", "shy, the one being spoken to");
    const text = "魔王が来た。";
    const r = await service.researchBlock(ask(text));
    expect(r).toEqual({ asked: true, chosen: 1, canceled: false });
    expect(bodies(lm)[0]!.messages[1]!.content).toBe("KNOWN SO FAR:\n1. 魔王 = Demon King\n2. 勇者 = Hero (shy, the one being spoken to)\n\nPASSAGE:\n魔王が来た。");

    service.start(job({ text }));
    await service.whenIdle();
    const translation = bodies(lm).at(-1)!.messages[1]!.content;
    expect(parseUserMessage(translation)!.glossary).toEqual([{ source: "勇者", target: "Hero" }]); // chosen by the model, although 魔王 is in the text
  });

  it("asks again only about entries that are new or changed, and not at all when nothing changed", async () => {
    const lm = await fakeLmStudio({ researchReply: "NONE" });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    save(service, "魔王", "Demon King");
    await service.researchBlock(ask("本文。"));
    expect((await service.researchBlock(ask("本文。"))).asked).toBe(false);
    save(service, "勇者", "Hero");
    expect((await service.researchBlock(ask("本文。"))).asked).toBe(true);
    const last = bodies(lm).at(-1)!.messages[1]!.content;
    expect(last).toContain("1. 勇者 = Hero");
    expect(last).not.toContain("魔王");
  });

  it("gives a block its own scene, the summary, the people present and the facts about them", async () => {
    const lm = await fakeLmStudio({ researchReply: "NONE", analysisReply: "CHARACTER: 花子 / 花ちゃん = Hanako | girl\nFACT: 花子 | Speaks politely.\nSCENE: CONTINUES | 花子 | Hanako greets someone at the gate." });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const text = "「おはよう」";
    const base = { backend: "provider" as const, modelId: "qwen2.5-7b-instruct", contextLimit: 4096, maxOutputTokens: 512, sourceLanguage: "Japanese", targetLanguage: "English" };
    service.start(job({ text })); // creates the document the knowledge is about
    await service.whenIdle();
    const doc = service.snapshot().activeDocumentId;
    await service.analyze({ ...base, passage: text, documentId: doc, documentTitle: "Document 1", block: 1 });
    await service.summarize({ ...base, documentId: doc, documentTitle: "Document 1" });
    await service.researchBlock({ ...base, passage: text });
    const before = bodies(lm).length;
    service.start(job({ text, rerun: ["qwen2.5-7b-instruct"] }));
    await service.whenIdle();
    const sent = bodies(lm).slice(before).at(-1)!.messages[1]!.content;
    expect(sent).toContain("SCENE (what is happening around this block; reference only, do not translate):\nHanako greets someone at the gate.");
    expect(sent).toContain("STORY SO FAR");
    expect(sent).toContain("- Hanako: Speaks politely.");
    expect(sent).toContain("- 花子 / 花ちゃん => Hanako — girl");
    expect(parseUserMessage(sent)!.glossary).toEqual([{ source: "花子", target: "Hanako", aliases: ["花ちゃん"] }]); // present in the scene, though the text never names her
  });

  it("splits a long list over several requests and reports a model that is too small", async () => {
    const lm = await fakeLmStudio({ researchReply: "1" });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    for (let i = 0; i < 80; i++) save(service, `名${i}`, `Name${i}`, "a fairly long hint so that the list takes room in the request");
    await service.researchBlock(ask("本文。", { contextLimit: 1400 }));
    expect(bodies(lm).length).toBeGreaterThan(1);
    await expect(service.researchBlock(ask("本文。".repeat(300), { contextLimit: 600, maxOutputTokens: 300 }))).rejects.toThrow(/do not fit/);
  });
});
