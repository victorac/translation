import {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import type {
  AddressInfo,
} from "node:net";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  type ModelSetting,
} from "@ltw/domain";
import {
  createHandler,
} from "./handlers.js";
import {
  ProviderService,
} from "./provider-service.js";
import {
  WorkspaceService,
} from "./service.js";
import {
  EncryptedFileCredentialStore,
  FileSettingsStore,
  MemoryCredentialStore,
  MemorySettingsStore,
  DEFAULT_SETTINGS,
} from "./storage.js";

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

/** A small stand-in for LM Studio: lists two models and "translates" each paragraph it is asked for into something that is not the source. */
async function fakeLmStudio(opts: { apiKey?: string; paragraph?: (user: string, source: string, model: string) => string } = {}) {
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
        const paragraph = /PARAGRAPH TO TRANSLATE:\n([\s\S]*?)\n\nTranslate that paragraph/.exec(j.messages[1]!.content)?.[1] ?? "";
        res.writeHead(200, { "content-type": "text/event-stream" });
        const text = opts.paragraph ? opts.paragraph(j.messages[1]!.content, paragraph, j.model) : `EN(${j.model}): ${fakeEnglish(paragraph)}`;
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

describe("the saved connection through the window's commands", () => {
  it("through the command handler, test and save report plain results", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    const h = createHandler(service, provider);
    expect(await h("1", "provider.save", { baseUrl: lm.baseUrl, allowRemote: false })).toMatchObject({ ok: true, value: { loopback: true } });
    expect(await h("2", "provider.test", undefined)).toMatchObject({ ok: true, value: { ok: true } });
    expect(await h("3", "provider.save", { baseUrl: "http://10.0.0.5:1234/v1", allowRemote: false })).toMatchObject({ ok: false, error: { code: "remote_not_allowed" } });
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

  it("reads a block for the user, adds the words that are used when it is translated, and leaves out the ones that are ignored", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    const text = "花子は笑った。\n\n「おはよう」と太郎は言った。\n\n「おはよう」";
    const started = service.guidedStart({ documentId: docId, text: `${text}\n\n${"あ".repeat(10)}`, blockSize: "small" });
    expect(started.blocks.length).toBeGreaterThan(0);

    const read = await service.guidedInterpret(0);
    expect(read.blocks[0]!.status).toBe("interpreted");
    // The words found are drafts: nothing is in the knowledge base yet.
    const names = () => service.guidedGet()!.blocks[0]!.interpretation!.names;
    expect(names().filter((n) => n.source === "花子" || n.source === "太郎")).toMatchObject([{ draft: true }, { draft: true }]);
    expect(service.knowledgeList({ kind: "term" }).entries).toEqual([]);
    // The user writes the English names, and ignores one word.
    service.guidedSetEnglish("花子", "Hanako");
    service.guidedSetEnglish("太郎", "Taro");
    service.guidedSetUse("太郎", false);
    expect(names().find((n) => n.source === "太郎")).toMatchObject({ english: "Taro", use: false });
    const done = await service.guidedTranslate({ ...model, index: 0 });
    expect(done.blocks[0]).toMatchObject({ status: "translated", error: null });
    expect(done.blocks[0]!.translation).toContain("EN(qwen2.5-7b-instruct)");

    const first = bodies(lm)[0]!.messages[1]!.content;
    expect(first).toContain("=> Hanako");
    expect(first).not.toContain("=> Taro"); // ignored
    expect(first).not.toContain("CONTEXT"); // nothing before the first block
    // The word that was used is in the knowledge base now, accepted; the ignored one is not.
    expect(service.knowledgeList({ kind: "term" }).entries.map((e) => `${e.source}:${e.target}:${e.status}`)).toEqual(["花子:Hanako:confirmed"]);
    expect(names().find((n) => n.source === "花子")).toMatchObject({ draft: false, known: true });
    expect(names().find((n) => n.source === "太郎")).toMatchObject({ draft: true, use: false });
  });

  it("translates a block paragraph by paragraph, and writes one paragraph again without touching the others", async () => {
    let n = 0;
    const lm = await fakeLmStudio({ paragraph: (_user, source, model) => `EN(${model}): ${fakeEnglish(source)} Hanako Taro ${++n}` });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "花子は笑った。\n\n「おはよう」と太郎は言った。\n\n二人は歩いた。", blockSize: "normal" });
    await service.guidedInterpret(0);
    service.guidedSetEnglish("花子", "Hanako");
    service.guidedSetHint("太郎", "a boy");
    const done = await service.guidedTranslate({ ...model, index: 0 });
    const block = done.blocks[0]!;
    // One request for each paragraph, and the paragraph's own words in it.
    const asked = bodies(lm).map((b) => b.messages[1]!.content);
    expect(asked).toHaveLength(3);
    expect(asked[0]).toContain("JAPANESE PARAGRAPH TO TRANSLATE:\n花子は笑った。");
    expect(asked[0]).toContain("- 花子 => Hanako");
    expect(asked[0]!.split("JAPANESE PARAGRAPH")[0]).not.toContain("太郎: a boy"); // its glossary and notes have only its own words
    expect(asked[1]).toContain("- 太郎: a boy");
    // A request has the paragraphs before with their translations, and the one after; never the whole block.
    expect(asked[0]).not.toContain("CONTEXT");
    expect(asked[0]).toContain("NEXT (the paragraph after this one; reference only, do not translate):\nJAPANESE: 「おはよう」と太郎は言った。");
    expect(asked[1]).toContain(`CONTEXT (the paragraphs before this one, with their translations; reference only, do not translate):\nJAPANESE: 花子は笑った。\nENGLISH: ${block.parts[0]}`);
    expect(asked[2]).not.toContain("NEXT");
    expect(block.parts).toHaveLength(3);
    expect(block.parts.every((p) => p.startsWith("EN(qwen2.5-7b-instruct)"))).toBe(true);
    expect(block).toMatchObject({ status: "translated", translation: block.parts.join("\n\n") });
    // The system message is the paragraph task, not the translate-a-block instruction.
    expect(bodies(lm)[0]!.messages[0]!.content).toContain("one paragraph at a time");

    // The user's own text for a paragraph is kept.
    const mine = service.guidedSetPart(0, 2, "  My own version. ");
    expect(mine.blocks[0]!.parts[2]).toBe("My own version.");
    expect(mine.blocks[0]!.translation.endsWith("My own version.")).toBe(true);

    // Writing the second paragraph again: the others stay, the old text is not shown, and the paragraph after it is given with its translation.
    const again = await service.guidedRetranslate({ ...model, index: 0, paragraph: 1 });
    const sent = bodies(lm).at(-1)!.messages[1]!.content;
    expect(sent).toContain("NEXT (the paragraph after this one; reference only, do not translate):\nJAPANESE: 二人は歩いた。\nENGLISH: My own version.");
    expect(sent).not.toContain(block.parts[1]!);
    expect(sent).not.toContain("REJECTED");
    expect(again.blocks[0]!.parts[0]).toBe(block.parts[0]);
    expect(again.blocks[0]!.parts[2]).toBe("My own version.");
  });

  it("asks again, showing the rejected version, when the model gives the same text back", async () => {
    const lm = await fakeLmStudio({ paragraph: () => "Hanako laughed." });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "花子は笑った。", blockSize: "normal" });
    await service.guidedTranslate({ ...model, index: 0 });
    const before = bodies(lm).length;
    const done = await service.guidedRetranslate({ ...model, index: 0, paragraph: 0 });
    const sent = bodies(lm).slice(before).map((b) => b.messages[1]!.content);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toContain("REJECTED VERSION");
    expect(sent[1]).toContain("REJECTED VERSION");
    expect(done.blocks[0]!.warning).toMatch(/same text again/);
  });

  it("asks again when the model writes about more than the paragraph, and joins the lines if it still does", async () => {
    let calls = 0;
    const lm = await fakeLmStudio({ paragraph: (user) => (user.includes("was several paragraphs") ? (calls++, "Only the paragraph, Hanako.") : "First. Hanako\n\nSecond.\n\nThird.") });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "花子は笑った。", blockSize: "normal" });
    const done = await service.guidedTranslate({ ...model, index: 0 });
    expect(calls).toBe(1);
    expect(done.blocks[0]!.parts).toEqual(["Only the paragraph, Hanako."]);
    expect(done.blocks[0]!.warning ?? null).toBeNull();
    const stubborn = await fakeLmStudio({ paragraph: () => "First. Hanako\n\nSecond." });
    provider.save({ baseUrl: stubborn.baseUrl, allowRemote: false });
    const again = await service.guidedRetranslate({ ...model, index: 0, paragraph: 0 });
    expect(again.blocks[0]!.parts).toEqual(["First. Hanako Second."]);
    expect(again.blocks[0]!.warning).toMatch(/several paragraphs, which were joined/);
  });

  it("asks again when the glossary name of the paragraph is left out, and says so if it still is", async () => {
    let calls = 0;
    const lm = await fakeLmStudio({ paragraph: (user) => (user.includes("does not use these exact names") ? "Hanako laughed." : (calls++, "She laughed.")) });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "花子は笑った。", blockSize: "normal" });
    await service.guidedInterpret(0);
    service.guidedSetEnglish("花子", "Hanako");
    const done = await service.guidedTranslate({ ...model, index: 0 });
    expect(calls).toBe(1);
    expect(done.blocks[0]!.parts).toEqual(["Hanako laughed."]);
    expect(done.blocks[0]!.warning ?? null).toBeNull();
    const stubborn = await fakeLmStudio({ paragraph: () => "She laughed." });
    provider.save({ baseUrl: stubborn.baseUrl, allowRemote: false });
    const again = await service.guidedRetranslate({ ...model, index: 0, paragraph: 0 });
    expect(again.blocks[0]!.warning).toMatch(/does not use the glossary names: 花子 => Hanako/);
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
    const asked = bodies(lm).length;
    await service.guidedTranslate({ ...model, index: 1 });
    const prev = service.guidedGet()!.blocks[0]!;
    // The first paragraph of the second block has nothing before it in its own block: it gets the end of the block before.
    const second = bodies(lm)[asked]!.messages[1]!.content;
    expect(second).toContain("CONTEXT");
    expect(second).toContain(prev.text.split("\n").filter(Boolean).at(-1)!);
  });

  it("asks for each paragraph once, in order, even in a long block", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    const paragraphs = Array.from({ length: 30 }, (_, i) => `これは${i}番目の長い段落で、少し言葉が多めに書かれています。`);
    service.guidedStart({ documentId: docId, text: paragraphs.join("\n"), blockSize: "large" });
    const before = bodies(lm).length;
    // The context is small: the source around each paragraph is cut down to what fits.
    const done = await service.guidedTranslate({ ...model, contextLimit: 1800, maxOutputTokens: 300, index: 0 });
    const sent = bodies(lm).slice(before).map((b) => b.messages[1]!.content);
    expect(sent).toHaveLength(30);
    expect(sent.map((u) => /PARAGRAPH TO TRANSLATE:\n(.*)\n/.exec(u)![1])).toEqual(paragraphs);
    expect(sent.every((u) => u.length < 4000)).toBe(true);
    expect(done.blocks[0]!.parts).toHaveLength(30);
    expect(done.blocks[0]!.warning ?? null).toBe(null);
  });

  it("translates a bare 山 as its own word: it has its own entry, and the request says it applies only when it stands alone", async () => {
    const lm = await fakeLmStudio({ paragraph: (_user, source) => `EN ${fakeEnglish(source)} Yamada Taro Yamada` });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "ぼくは山田太郎という。\n「山、お待たせしました」", blockSize: "normal" });
    const read = await service.guidedInterpret(0);
    expect(read.blocks[0]!.interpretation!.names.find((n) => n.source === "山田太郎")!.english).toBe("Yamada Taro");
    // Using the block puts 山田太郎 in the knowledge base. 山 is already a way to write his name; it still gets a translation of its own.
    await service.guidedTranslate({ ...model, index: 0 });
    const taro = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山田太郎")!;
    service.knowledgeSetFile(taro.id, service.knowledgeFile(taro.id).text.replace("aliases:", "aliases: 山"));
    const added = await service.guidedAddName(0, "山");
    expect(added.blocks[0]!.interpretation!.names.find((n) => n.source === "山")).toMatchObject({ draft: true, kind: "term" });
    service.guidedSetEnglish("山", "Yamada");

    await service.guidedTranslate({ ...model, index: 0 });
    const sent = bodies(lm).slice(-2).map((b) => b.messages[1]!.content).join("\n");
    expect(sent).toContain("- 山田太郎 => Yamada Taro");
    expect(sent).not.toContain("山田太郎 / 山");
    expect(sent).toContain("- 山 => Yamada");
    expect(sent).toContain("- 山: a name for Yamada Taro; when it stands on its own, not as part of 山田太郎");
  });

  it("ties a word to the person it stands for, by itself when the word is one of their aliases, and it can be changed on the draft", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "ぼくは山田太郎という。\n「山、お待たせしました」", blockSize: "normal" });
    await service.guidedInterpret(0);
    await service.guidedTranslate({ ...model, index: 0 });
    const entry = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山田太郎")!;
    service.knowledgeSetFile(entry.id, service.knowledgeFile(entry.id).text.replace("aliases:", "aliases: 山"));

    // Adding a word that is one of his aliases makes a draft that stands for him.
    const added = await service.guidedAddName(0, "山");
    const draft = () => service.guidedGet()!.blocks[0]!.interpretation!.names.find((n) => n.source === "山")!;
    expect(draft()).toMatchObject({ draft: true, kind: "term", refersTo: "山田太郎", attrs: { "refers to": ["山田太郎"] } });
    expect(service.knowledgeList({ kind: "term" }).entries.some((e) => e.source === "山")).toBe(false);
    service.guidedSetEnglish("山", "Yamada");
    await service.guidedTranslate({ ...model, index: 0 });
    expect(bodies(lm).at(-1)!.messages[1]!.content).toContain("- 山: a name for Yamada Taro; when it stands on its own, not as part of 山田太郎");
    // Now it is in the knowledge base, with the link.
    expect(service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山")!.attrs["refers to"]).toEqual(["山田太郎"]);

    // It can be untied and tied again.
    expect(service.guidedSetAttribute("山", "refers to", []).blocks[0]!.interpretation!.names.find((n) => n.source === "山")!.refersTo).toBe(null);
    expect(service.guidedSetAttribute("山", "refers to", ["山田太郎"]).blocks[0]!.interpretation!.names.find((n) => n.source === "山")!.refersTo).toBe("山田太郎");
    void added;
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

  it("sets the attributes of a word from the choices the classes give, on a draft and on a word of the knowledge base, and changes its kind", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "花子は鈴木家の人だ。花子は笑った。", blockSize: "normal" });
    await service.guidedInterpret(0);
    const names = () => service.guidedGet()!.blocks[0]!.interpretation!.names;
    expect(names().map((n) => n.source)).toEqual(expect.arrayContaining(["花子", "鈴木家"]));

    // The class lists what can be chosen: a gender from its list, a family from the families.
    const files = service.knowledgeFiles();
    expect(files.classes.find((c) => c.name === "character")!.attributes).toEqual(expect.arrayContaining([{ key: "gender", kind: "choice", choices: ["male", "female", "other", "unknown"] }, { key: "family", kind: "link", target: "family" }]));
    // On the drafts: a family can be a draft of the same block.
    service.guidedSetAttribute("花子", "gender", ["female"]);
    service.guidedSetAttribute("花子", "family", ["鈴木家"]);
    service.guidedSetAttribute("花子", "age", ["15"]); // text
    expect(names().find((n) => n.source === "花子")).toMatchObject({ draft: true, gender: "female", attrs: { gender: ["female"], family: ["鈴木家"], age: ["15"] } });
    expect(service.knowledgeList({ kind: "term" }).entries).toEqual([]);

    // Only what the class allows.
    expect(() => service.guidedSetAttribute("花子", "gender", ["purple"])).toThrow(/is one of/);
    expect(() => service.guidedSetAttribute("花子", "family", ["花子"])).toThrow(/must be a topic/);
    expect(() => service.guidedSetAttribute("花子", "nonsense", ["x"])).toThrow(/not an attribute/);
    expect(() => service.guidedSetAttribute("花子", "gender", ["male", "female"])).toThrow(/takes one value/);

    // Used, the word goes to the knowledge base with its attributes; after that the same choices edit the topic itself.
    await service.guidedTranslate({ ...model, index: 0 });
    const hanako = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "花子")!;
    expect(hanako).toMatchObject({ status: "confirmed", attrs: { gender: ["female"], family: ["鈴木家"], age: ["15"] } });
    service.guidedSetAttribute("花子", "gender", ["male"]);
    expect(service.knowledgeFile(hanako.id).text).toContain("gender: male\n");
    expect(service.knowledgeFile(hanako.id).text).toContain("family: [[鈴木家]]");

    // Cleared, and the kind changed: attributes the new kind does not have are dropped.
    service.guidedSetAttribute("花子", "family", []);
    expect(names().find((n) => n.source === "花子")!.attrs!["family"]).toBeUndefined();
    service.guidedSetKind("花子", "term");
    expect(names().find((n) => n.source === "花子")).toMatchObject({ kind: "term", attrs: {} });
    expect(() => service.guidedSetKind("花子", "nonsense")).toThrow(/no kind of topic/);
  });

  it("clears the English name a person or family got from its reading when it is changed to another kind, but not one the user wrote", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "鈴木花子は山田太郎に会った。", blockSize: "normal" });
    await service.guidedInterpret(0);
    const english = (source: string) => service.guidedGet()!.blocks[0]!.interpretation!.names.find((n) => n.source === source)!.english;
    expect(english("鈴木花子")).toBe("Suzuki Hanako");
    service.guidedSetKind("鈴木花子", "term");
    expect(english("鈴木花子")).toBe(""); // made from a reading, which means nothing for a term
    // Written by the user, it stays.
    service.guidedSetEnglish("山田太郎", "Taro");
    service.guidedSetKind("山田太郎", "term");
    expect(english("山田太郎")).toBe("Taro");
  });

  it("lists every glossary word that stands in a block, also ones added to the glossary later, and lets the user write the English name of a draft", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "鈴木花子は魔法の杖を持っていた。", blockSize: "normal" });
    await service.guidedInterpret(0);
    const names = () => service.guidedGet()!.blocks[0]!.interpretation!.names;
    expect(names().some((n) => n.source === "魔法")).toBe(false);

    // A word added to the glossary afterwards, from anywhere, shows up in the block by itself.
    const magic = service.knowledgeCreate("term", "魔法").id;
    service.knowledgeSetFile(magic, service.knowledgeFile(magic).text.replace(/english:.*/, "english: magic"));
    expect(names().find((n) => n.source === "魔法")).toMatchObject({ english: "magic", kind: "term", known: true, draft: false });
    // A word that is not in this block is not listed.
    const dragon = service.knowledgeCreate("term", "竜").id;
    service.knowledgeSetFile(dragon, service.knowledgeFile(dragon).text.replace(/english:.*/, "english: dragon"));
    expect(names().some((n) => n.source === "竜")).toBe(false);

    // The user writes the English name of a draft; it is not in the knowledge base until it is used.
    expect(names().find((n) => n.source === "鈴木花子")).toMatchObject({ draft: true, known: false });
    service.guidedSetEnglish("鈴木花子", "  Hanako Suzuki ");
    expect(names().find((n) => n.source === "鈴木花子")).toMatchObject({ english: "Hanako Suzuki", draft: true });
    expect(service.knowledgeList({ kind: "term" }).entries.some((e) => e.source === "鈴木花子")).toBe(false);
    await service.guidedTranslate({ ...model, index: 0 });
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

  it("keeps the block work of each document, so switching documents loses nothing, and counts it in the document list", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const first = service.snapshot().activeDocumentId;
    service.guidedSync({ documentId: first, text: "太郎は笑った。", blockSize: "normal" });
    await service.guidedReadAll();
    await service.guidedTranslate({ ...model, index: 0 });

    // Another document has its own blocks; the first one's work is kept aside.
    const second = service.createDocument("Second").activeDocumentId;
    expect(service.guidedSync({ documentId: second, text: "花子は泣いた。", blockSize: "normal" })!.blocks.map((b) => b.text)).toEqual(["花子は泣いた。"]);
    expect(service.snapshot().documents.map((d) => `${d.done}/${d.total}`)).toEqual(["1/1", "0/1"]);

    // Coming back, the translation is there.
    const back = service.guidedSync({ documentId: first, text: "太郎は笑った。", blockSize: "normal" })!;
    expect(back.blocks[0]).toMatchObject({ status: "translated" });
    expect(service.exportProject().guided.map((g) => g.documentId).sort()).toEqual([first, second].sort());

    // Deleting a document takes its work with it.
    service.deleteDocument(second);
    expect(service.exportProject().guided.map((g) => g.documentId)).toEqual([first]);
  });

  it("is kept in the project and can be started over", async () => {
    const { service } = setup();
    const docId = service.snapshot().activeDocumentId;
    service.guidedStart({ documentId: docId, text: "短い文。", blockSize: "normal" });
    expect(service.exportProject().guided.map((g) => g.blocks.length)).toEqual([1]);
    service.guidedClear();
    expect(service.guidedGet()).toBe(null);
  });
});
