import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUserMessage, type GuidedState, type ModelSetting, type StartJobInput } from "@ltw/domain";
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
async function fakeLmStudio(opts: { loaded?: string[]; apiKey?: string; failBlock?: string; answer?: (system: string, user: string) => string; researchReply?: string } = {}) {
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
        const summarizing = j.messages[0]!.content.includes("shorten scene descriptions");
        const reading = researching || summarizing || parseUserMessage(j.messages[1]!.content) === null;
        const source = reading ? "" : parseUserMessage(j.messages[1]!.content)!.sourceBlock;
        if (opts.failBlock && source.includes(opts.failBlock)) {
          res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"Trying to keep the first 9000 tokens when context overflows"}}');
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const text = reading ? (summarizing ? "A short summary of the chapter." : researching ? (opts.researchReply ?? "NONE") : (opts.answer?.(j.messages[0]!.content, j.messages[1]!.content) ?? "NONE")) : `EN(${j.model}): ${fakeEnglish(source)}`;
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

describe("topics as files", () => {
  const setupService = () => new WorkspaceService({ speedMs: 0 });

  it("lists topics by class, makes new ones, and refuses a name that is already used", () => {
    const service = setupService();
    const { id } = service.knowledgeCreate("character", "花子");
    service.knowledgeCreate("place", "学園");
    expect(service.knowledgeFiles().files.map((f) => `${f.group}:${f.title}`)).toEqual(["character:花子", "place:学園", "classes:Classes"]);
    expect(service.knowledgeFiles().classes.map((c) => c.name)).toEqual(["character", "place", "organization", "family", "term"]);
    expect(() => service.knowledgeCreate("character", "花子")).toThrow(/already a topic/);
    expect(service.knowledgeResolve("花子")).toEqual({ id, title: "花子" });
    expect(service.knowledgeResolve("誰か")).toEqual({ id: null, title: null });
  });

  it("edits a topic through its file, shows what links to it, and renames it everywhere", () => {
    const service = setupService();
    const hanako = service.knowledgeCreate("character", "花子").id;
    const school = service.knowledgeCreate("place", "学園").id;
    const text = service.knowledgeFile(hanako).text;
    const done = service.knowledgeSetFile(hanako, text.replace("lives in:", "lives in: [[学園]]").replace("gender:", "gender: female").replace("english: 花子", "english: Hanako"));
    expect(done.problems).toEqual([]);
    expect(done.text).toContain("gender: female");
    expect(service.knowledgeFile(school).backlinks).toEqual([{ id: hanako, title: "花子" }]);
    // Rename the school; the link in Hanako's file follows.
    const renamed = service.knowledgeSetFile(school, service.knowledgeFile(school).text.replace("name: 学園", "name: 学院"));
    expect(renamed.problems).toEqual([]);
    expect(service.knowledgeFile(hanako).text).toContain("lives in: [[学院]]");
    // What the translating model is told about her includes the attributes.
    const note = service.knowledgeList({ kind: "term" }).entries[0]!;
    expect(note.attrs).toMatchObject({ gender: ["female"], "lives in": ["学院"] });
  });

  it("remembers a deleted suggestion as rejected, and removes anything else", () => {
    const service = setupService();
    const { id } = service.knowledgeCreate("character", "花子");
    expect(service.knowledgeDelete(id)).toEqual({ removed: true });
    expect(service.knowledgeFiles().files.some((f) => f.id === id)).toBe(false);
    expect(service.knowledgeDelete("nope")).toEqual({ removed: false });
    expect(() => service.knowledgeFile(id)).toThrow(/no longer exists/);
  });

  it("lets the user define their own classes, and says what is wrong in the definition", () => {
    const service = setupService();
    const result = service.knowledgeSetFile("classes", "# item\nowner: link(character)\nweight: text\n");
    expect(result.problems).toEqual([]);
    expect(service.knowledgeFiles().classes.map((c) => c.name)).toEqual(["item"]);
    const item = service.knowledgeCreate("item", "魔剣");
    expect(service.knowledgeFile(item.id).text).toContain("owner:\nweight:");
    expect(service.knowledgeSetFile("classes", "owner: text").problems[0]!.message).toMatch(/Start with the name of a class/);
  });
});

describe("accepting suggestions", () => {
  it("accepts a topic together with its suggested attributes and facts", () => {
    const service = new WorkspaceService({ speedMs: 0 });
    const id = service.knowledgeCreate("character", "花子").id;
    const text = service.knowledgeFile(id).text.replace("english: 花子", "english: Hanako").replace("gender:", "gender: female ?").replace("## Notes\n", "## Notes\n- Is polite. ?\n");
    service.knowledgeSetFile(id, text);
    expect(service.knowledgeFiles().files.find((f) => f.id === id)!.suggested).toBe(true); // an attribute and a fact are still unchecked
    expect(service.snapshot().knowledge.suggested).toBeGreaterThan(0);

    service.knowledgeConfirm([id]);
    expect(service.knowledgeFiles().files.find((f) => f.id === id)!.suggested).toBe(false);
    expect(service.knowledgeFile(id).text).toContain("gender: female\n");
    expect(service.knowledgeFile(id).text).toContain("- Is polite.\n");
    expect(service.snapshot().knowledge.suggested).toBe(0);
  });
});

describe("translating step by step", () => {
  const model = { backend: "provider" as const, modelId: "qwen2.5-7b-instruct", contextLimit: 4096, maxOutputTokens: 512, temperature: 0.2, sourceLanguage: "Japanese", targetLanguage: "English" };
  const bodies = (lm: { seen: Seen[] }) => lm.seen.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as { messages: { content: string }[] });

  it("reads a block for the user, translates it with what was confirmed, remembers the names, and gives the next block the end of this one", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    const text = "花子は笑った。\n\n「おはよう」と太郎は言った。\n\n「おはよう」";
    const started = service.guidedStart({ documentId: docId, text: `${text}\n\n${"あ".repeat(10)}`, blockSize: "small" });
    expect(started.blocks.length).toBeGreaterThan(0);

    const read = await service.guidedInterpret(0);
    expect(read.blocks[0]!.status).toBe("interpreted");
    // The names are glossary topics, suggested for the user to check. The user fixes the English names there.
    const topics = service.knowledgeList({ kind: "term" }).entries;
    expect(topics.map((e) => `${e.source}:${e.status}`)).toEqual(expect.arrayContaining(["花子:suggested", "太郎:suggested"]));
    for (const e of topics) {
      if (e.source === "花子" || e.source === "太郎") service.knowledgeSave({ id: e.id, kind: "term", source: e.source, target: e.source === "花子" ? "Hanako" : "Taro", hint: e.hint, category: e.category, aliases: e.aliases, attrs: e.attrs, text: "", about: null });
    }
    expect(service.guidedGet()!.blocks[0]!.interpretation!.names.find((n) => n.source === "花子")).toMatchObject({ english: "Hanako", known: true });
    const done = await service.guidedTranslate({ ...model, index: 0 });
    expect(done.blocks[0]).toMatchObject({ status: "translated", error: null });
    expect(done.blocks[0]!.translation).toContain("EN(qwen2.5-7b-instruct)");

    const first = bodies(lm).at(-1)!.messages[1]!.content;
    expect(first).toContain("=> Hanako");
    expect(first).toContain("=> Taro");
    expect(first).not.toContain("CONTEXT"); // nothing before the first block
    // What was confirmed is now in the glossary.
    expect(service.knowledgeList({ kind: "term" }).entries.map((e) => `${e.source}:${e.target}:${e.status}`)).toEqual(expect.arrayContaining(["花子:Hanako:confirmed", "太郎:Taro:confirmed"]));
  });

  it("gives a later block the end of the block before it, source and translation", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    const long = Array.from({ length: 40 }, (_, i) => `これは${i}番目の文です。`).join("\n\n");
    const started = service.guidedStart({ documentId: docId, text: long, blockSize: "small" });
    if (started.blocks.length < 2) return; // the text fits in one block with this size; nothing to overlap
    await service.guidedTranslate({ ...model, index: 0 });
    await service.guidedTranslate({ ...model, index: 1 });
    const second = bodies(lm).at(-1)!.messages[1]!.content;
    const prev = service.guidedGet()!.blocks[0]!;
    expect(second).toContain("CONTEXT");
    expect(second).toContain(prev.text.split("\n").filter(Boolean).at(-1)!);
  });

  it("translates a long block in pieces, each with the end of the one before it, and keeps what the user corrects", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    const paragraphs = Array.from({ length: 30 }, (_, i) => `これは${i}番目の長い段落で、少し言葉が多めに書かれています。`);
    service.guidedStart({ documentId: docId, text: paragraphs.join("\n"), blockSize: "large" });
    const before = bodies(lm).length;
    const done = await service.guidedTranslate({ ...model, contextLimit: 1400, maxOutputTokens: 300, index: 0 });
    const sent = bodies(lm).slice(before).map((b) => b.messages[1]!.content);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]).not.toContain("CONTEXT");
    expect(sent[1]).toContain("CONTEXT");
    // Every paragraph reaches the model exactly once, in order.
    const asked = sent.flatMap((u) => parseUserMessage(u)!.sourceBlock.split("\n"));
    expect(asked).toEqual(paragraphs);
    expect(done.blocks[0]!.warning ?? null).toBe(null);
    expect(done.blocks[0]!.translation.split(/\n+/).length).toBe(30);

    const fixed = service.guidedSetTranslation(0, "My own version.");
    expect(fixed.blocks[0]).toMatchObject({ translation: "My own version.", status: "translated", warning: null });
  });

  it("carries the narrator on to the blocks read after it, until the user changes it", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    const paragraphs = Array.from({ length: 40 }, (_, i) => (i === 0 ? "ぼくは山田太郎という。" : i === 20 ? "ぼくは花子を見た。" : `これは${i}番目の長い段落で、少し言葉が多めに書かれています。`));
    const started = service.guidedStart({ documentId: docId, text: paragraphs.join("\n"), blockSize: "small" });
    expect(started.blocks.length).toBeGreaterThan(1);
    const first = await service.guidedInterpret(0);
    expect(first.blocks[0]!.interpretation!.names.map((n) => n.source)).toContain("山田太郎");
    service.guidedSave(0, "山田太郎", first.blocks[0]!.interpretation!.lines.map((l) => l.speaker));
    await service.guidedTranslate({ ...model, index: 0 });
    const second = await service.guidedInterpret(1);
    expect(second.blocks[1]!.interpretation!.narrator).toBe("山田太郎");
    // Changed on this block, it is the new one for the next.
    service.guidedSave(1, null, second.blocks[1]!.interpretation!.lines.map((l) => l.speaker));
    if (started.blocks.length > 2) expect((await service.guidedInterpret(2)).blocks[2]!.interpretation!.narrator).toBe(null);
  });

  it("lists the names of a block from the glossary: a word the user adds becomes a topic, and a deleted topic is gone from the list and not offered again", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "花子は魔法使いだった。太郎が来た。", blockSize: "normal" });
    const read = await service.guidedInterpret(0);
    const hanako = read.blocks[0]!.interpretation!.names.find((n) => n.source === "花子")!;
    expect(hanako).toMatchObject({ kind: "character", known: false });
    expect(hanako.id).toBeTruthy();

    const added = await service.guidedAddName(0, "魔法使い");
    const term = added.blocks[0]!.interpretation!.names.find((n) => n.source === "魔法使い")!;
    expect(term.id).toBeTruthy();
    expect(service.knowledgeList({ kind: "term" }).entries.some((e) => e.source === "魔法使い")).toBe(true);
    // Adding it again changes nothing.
    expect((await service.guidedAddName(0, "魔法使い")).blocks[0]!.interpretation!.names.filter((n) => n.source === "魔法使い")).toHaveLength(1);

    service.knowledgeDelete(hanako.id!);
    expect(service.guidedGet()!.blocks[0]!.interpretation!.names.some((n) => n.source === "花子")).toBe(false);
    const again = await service.guidedInterpret(0);
    expect(again.blocks[0]!.interpretation!.names.some((n) => n.source === "花子")).toBe(false);
  });

  it("carries a conversation on from the end of one block into the start of the next", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "あ", blockSize: "normal" });
    // Two blocks, made by hand: the first ends on a line of speech, the second begins with the reply.
    const state = (service as unknown as { guided: GuidedState }).guided;
    const block = state.blocks[0]!;
    state.blocks = [
      { ...block, index: 0, text: "花子は待っていた。\n「遅かったね、太郎」と花子は言った。\n「ごめん」と太郎は言った。\n「いいよ」" },
      { ...block, index: 1, text: "「ありがとう」\n\n「どういたしまして」\n\n「じゃあ行こう」" },
    ];
    const one = await service.guidedInterpret(0);
    expect(one.blocks[0]!.interpretation!.lines.map((l) => l.speaker)).toEqual(["花子", "太郎", "花子"]);
    const two = await service.guidedInterpret(1);
    expect(two.blocks[1]!.interpretation!.lines.map((l) => l.speaker)).toEqual(["太郎", "花子", "太郎"]);
    expect(two.blocks[1]!.interpretation!.names.map((n) => n.source).sort()).toEqual(["太郎", "花子"].sort());

    // Set by hand on the first block, the last speaker decides the next block when it is read again.
    service.guidedSave(0, null, ["花子", "太郎", "太郎"]);
    const again = await service.guidedInterpret(1);
    expect(again.blocks[1]!.interpretation!.lines.map((l) => l.speaker)).toEqual(["花子", "太郎", "花子"]);
    // "Guess the speakers" fills the lines still not known, with the same carry.
    service.guidedSave(1, null, [null, "花子", null], true);
    expect(service.guidedGet()!.blocks[1]!.interpretation!.lines.map((l) => l.speaker)).toEqual(["花子", "花子", "太郎"]);
  });

  it("translates a bare 山 as its own word: it gets its own topic, and the request says it applies only when it stands alone", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "ぼくは山田太郎という。\n「山、お待たせしました」", blockSize: "normal" });
    const read = await service.guidedInterpret(0);
    const taro = read.blocks[0]!.interpretation!.names.find((n) => n.source === "山田太郎")!;
    expect(taro.english).toBe("Yamada Taro");
    // 山田 is already a way to write his name; the user still gives it a translation of its own.
    const user = service.knowledgeList({ kind: "term" }).entries.find((e) => e.id === taro.id)!;
    service.knowledgeSave({ id: user.id, kind: "term", source: user.source, target: user.target, hint: user.hint, category: user.category, aliases: ["山"], attrs: user.attrs, text: "", about: null });
    const added = await service.guidedAddName(0, "山");
    const tono = added.blocks[0]!.interpretation!.names.find((n) => n.source === "山")!;
    expect(tono.id).toBeTruthy();
    expect(tono.id).not.toBe(taro.id);
    const topic = service.knowledgeList({ kind: "term" }).entries.find((e) => e.id === tono.id)!;
    service.knowledgeSave({ id: topic.id, kind: "term", source: "山", target: "Yamada", hint: "", category: "term", aliases: [], attrs: {}, text: "", about: null });

    await service.guidedTranslate({ ...model, index: 0 });
    const sent = bodies(lm).at(-1)!.messages[1]!.content;
    expect(sent).toContain("- 山田太郎 => Yamada Taro");
    expect(sent).not.toContain("山田太郎 / 山");
    expect(sent).toContain("- 山 => Yamada — when it stands on its own, not as part of 山田太郎");
  });

  it("ties a topic to the person it stands for, by itself when the word is one of their aliases, and the request says so", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "ぼくは山田太郎という。\n「山、お待たせしました」", blockSize: "normal" });
    const read = await service.guidedInterpret(0);
    const taro = read.blocks[0]!.interpretation!.names.find((n) => n.source === "山田太郎")!;
    const entry = service.knowledgeList({ kind: "term" }).entries.find((e) => e.id === taro.id)!;
    service.knowledgeSave({ id: entry.id, kind: "term", source: entry.source, target: entry.target, hint: "", category: entry.category, aliases: ["山"], attrs: entry.attrs, text: "", about: null });

    // Adding a word that is one of his aliases makes a topic that stands for him.
    const added = await service.guidedAddName(0, "山");
    expect(added.blocks[0]!.interpretation!.names.find((n) => n.source === "山")).toMatchObject({ kind: "term", refersTo: "山田太郎" });
    expect(service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山")!.attrs["refers to"]).toEqual(["山田太郎"]);
    const topic = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山")!;
    service.knowledgeSave({ id: topic.id, kind: "term", source: "山", target: "Yamada", hint: "", category: "term", aliases: [], attrs: topic.attrs, text: "", about: null });
    await service.guidedTranslate({ ...model, index: 0 });
    expect(bodies(lm).at(-1)!.messages[1]!.content).toContain("- 山 => Yamada — a name for Yamada Taro; when it stands on its own, not as part of 山田太郎");

    // It can be tied to someone else, or untied.
    expect(service.guidedSetAttribute("山", "refers to", []).blocks[0]!.interpretation!.names.find((n) => n.source === "山")!.refersTo).toBe(null);
    expect(service.guidedSetAttribute("山", "refers to", ["山田太郎"]).blocks[0]!.interpretation!.names.find((n) => n.source === "山")!.refersTo).toBe("山田太郎");
  });

  it("makes a word the user adds a term, unless it looks like a name", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "田は花子に会った。魔法使いだ。", blockSize: "normal" });
    await service.guidedInterpret(0);
    const kind = async (w: string) => (await service.guidedAddName(0, w)).blocks[0]!.interpretation!.names.find((n) => n.source === w)?.kind;
    expect(await kind("田")).toBe("term"); // one kanji: not a name
    expect(await kind("掃除当番")).toBe("term"); // a word the user adds is a term, even when it could be read as a name
    expect((await service.guidedAddName(0, "掃除当番")).blocks[0]!.interpretation!.names.find((n) => n.source === "掃除当番")!.english).toBe("");
    expect(await kind("魔法使い")).toBe("term");
    expect(await kind("桜台学園")).toBe("organization"); // ends like one
  });

  it("sets the attributes that have options from a choice, as the classes say, and changes the kind of a topic", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "花子は鈴木家の人だ。花子は笑った。", blockSize: "normal" });
    const read = await service.guidedInterpret(0);
    const names = () => service.guidedGet()!.blocks[0]!.interpretation!.names;
    expect(names().map((n) => n.source)).toEqual(expect.arrayContaining(["花子", "鈴木家"]));

    // The class lists what can be chosen: a gender from its list, a family from the topics that are families.
    const files = service.knowledgeFiles();
    expect(files.classes.find((c) => c.name === "character")!.attributes).toEqual(expect.arrayContaining([{ key: "gender", kind: "choice", choices: ["male", "female", "other", "unknown"] }, { key: "family", kind: "link", target: "family" }]));
    service.guidedSetAttribute("花子", "gender", ["female"]);
    service.guidedSetAttribute("花子", "family", ["鈴木家"]);
    expect(names().find((n) => n.source === "花子")).toMatchObject({ gender: "female", attrs: { gender: ["female"], family: ["鈴木家"] } });
    // What is chosen is no longer flagged to check, and the file says so.
    const hanako = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "花子")!;
    expect(hanako.attrFlags).not.toContain("gender");
    expect(service.knowledgeFile(hanako.id).text).toContain("gender: female\n");
    expect(service.knowledgeFile(hanako.id).text).toContain("family: [[鈴木家]]");

    // Only what the class allows.
    expect(() => service.guidedSetAttribute("花子", "gender", ["purple"])).toThrow(/is one of/);
    expect(() => service.guidedSetAttribute("花子", "family", ["花子"])).toThrow(/must be a topic/);
    expect(() => service.guidedSetAttribute("花子", "age", ["9"])).toThrow(/not an attribute with options/);
    expect(() => service.guidedSetAttribute("花子", "gender", ["male", "female"])).toThrow(/takes one value/);

    // Cleared, and the kind changed: attributes the new kind does not have are dropped.
    service.guidedSetAttribute("花子", "family", []);
    expect(names().find((n) => n.source === "花子")!.attrs!["family"]).toBeUndefined();
    service.guidedSetKind("花子", "term");
    expect(names().find((n) => n.source === "花子")).toMatchObject({ kind: "term", attrs: {} });
    expect(() => service.guidedSetKind("花子", "nonsense")).toThrow(/no kind of topic/);
    void read;
  });

  it("clears the English name a person or family got from its reading when it is changed to another kind, but not one the user wrote", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "鈴木花子は山田太郎に会った。", blockSize: "normal" });
    const read = await service.guidedInterpret(0);
    const english = (source: string) => service.guidedGet()!.blocks[0]!.interpretation!.names.find((n) => n.source === source)!.english;
    expect(english("鈴木花子")).toBe("Suzuki Hanako");
    service.guidedSetKind("鈴木花子", "term");
    expect(english("鈴木花子")).toBe(""); // made from a reading, which means nothing for a term
    // Written by the user, it stays.
    const taro = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山田太郎")!;
    service.knowledgeSave({ id: taro.id, kind: "term", source: taro.source, target: "Taro", hint: "", category: "character", aliases: [], attrs: {}, text: "", about: null });
    service.guidedSetKind("山田太郎", "term");
    expect(english("山田太郎")).toBe("Taro");
    void read;
  });

  it("lists every glossary word that stands in a block, also ones added to the glossary later, and lets the user write the English name", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "鈴木花子は魔法の杖を持っていた。", blockSize: "normal" });
    await service.guidedInterpret(0);
    const names = () => service.guidedGet()!.blocks[0]!.interpretation!.names;
    expect(names().some((n) => n.source === "魔法")).toBe(false);

    // A word added to the glossary afterwards, from anywhere, shows up in the block by itself.
    service.knowledgeSave({ kind: "term", source: "魔法", target: "magic", hint: "", category: "term", aliases: [], attrs: {}, text: "", about: null });
    expect(names().find((n) => n.source === "魔法")).toMatchObject({ english: "magic", kind: "term", known: true });
    // A word that is not in this block is not listed.
    service.knowledgeSave({ kind: "term", source: "竜", target: "dragon", hint: "", category: "term", aliases: [], attrs: {}, text: "", about: null });
    expect(names().some((n) => n.source === "竜")).toBe(false);

    // The user writes the English name on the row: the glossary has it, and the topic is accepted.
    const before = names().find((n) => n.source === "鈴木花子")!;
    expect(before.known).toBe(false);
    service.guidedSetEnglish("鈴木花子", "  Hanako Suzuki ");
    expect(names().find((n) => n.source === "鈴木花子")).toMatchObject({ english: "Hanako Suzuki", known: true });
    expect(service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "鈴木花子")).toMatchObject({ target: "Hanako Suzuki", status: "confirmed" });
  });

  it("follows a change in the source: a block whose text is the same keeps what was done, and the others start again", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    const paragraph = (i: number) => `これは${i}番目の長い段落で、少し言葉が多めに書かれています。`;
    const text = Array.from({ length: 40 }, (_, i) => paragraph(i)).join("\n");
    const start = { documentId: docId, text, blockSize: "small" as const };
    const first = service.guidedStart(start);
    expect(first.blocks.length).toBeGreaterThan(2);
    await service.guidedReadAll();
    expect(service.guidedGet()!.blocks.every((b) => b.interpretation)).toBe(true);
    await service.guidedTranslate({ ...model, index: 0 });

    // The same text changes nothing.
    expect(service.guidedSync(start)!.blocks[0]!.status).toBe("translated");
    // Text added at the end: the blocks before it keep their work.
    const longer = service.guidedSync({ ...start, text: `${text}\n${paragraph(99)}` })!;
    expect(longer.blocks[0]).toMatchObject({ status: "translated" });
    expect(longer.blocks.length).toBeGreaterThanOrEqual(first.blocks.length);
    expect(longer.blocks.at(-1)!.status).toBe("new");
    // The first paragraph changed: that block starts again.
    const edited = service.guidedSync({ ...start, text: text.replace(paragraph(0), "全く違う文。") })!;
    expect(edited.blocks[0]).toMatchObject({ status: "new", translation: "", interpretation: null });
    expect(service.guidedSync({ documentId: docId, text: "", blockSize: "small" })!.blocks.length).toBe(edited.blocks.length); // an empty editor leaves it alone
  });

  it("makes the blocks from the text when there are none yet, and a different text replaces them all", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    expect(service.guidedSync({ documentId: docId, text: "", blockSize: "normal" })).toBe(null);
    const one = service.guidedSync({ documentId: docId, text: "太郎は笑った。", blockSize: "normal" })!;
    expect(one.blocks.map((b) => b.text)).toEqual(["太郎は笑った。"]);
    await service.guidedReadAll();
    expect(service.guidedGet()!.blocks[0]!.interpretation).not.toBe(null);
    // Another text: nothing of the old blocks is left, and what was read is read again.
    const two = service.guidedSync({ documentId: docId, text: "花子は泣いた。", blockSize: "normal" })!;
    expect(two.blocks.map((b) => b.text)).toEqual(["花子は泣いた。"]);
    expect(two.blocks[0]).toMatchObject({ status: "new", interpretation: null, translation: "" });
  });

  it("is kept in the project and can be started over", async () => {
    const { service } = setup();
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "短い文。", blockSize: "normal" });
    expect(service.exportProject().guided?.blocks).toHaveLength(1);
    service.guidedClear();
    expect(service.guidedGet()).toBe(null);
  });
});
