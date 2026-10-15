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
async function fakeLmStudio(opts: { apiKey?: string; answer?: (system: string, user: string) => string; paragraph?: (user: string, source: string, model: string) => string } = {}) {
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
        const found = /PARAGRAPH TO TRANSLATE:\n([\s\S]*?)\n\nTranslate that paragraph/.exec(j.messages[1]!.content)?.[1];
        const paragraph = found ?? "";
        res.writeHead(200, { "content-type": "text/event-stream" });
        // A request to translate a paragraph, or a short question about the translation.
        const text = found === undefined ? (opts.answer?.(j.messages[0]!.content, j.messages[1]!.content) ?? "NONE") : opts.paragraph ? opts.paragraph(j.messages[1]!.content, paragraph, j.model) : `EN(${j.model}): ${fakeEnglish(paragraph)}`;
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

describe("translating a document", () => {
  const model = { backend: "provider" as const, modelId: "qwen2.5-7b-instruct", contextLimit: 4096, maxOutputTokens: 512, temperature: 0.2, sourceLanguage: "Japanese", targetLanguage: "English" };
  const bodies = (lm: { seen: Seen[] }) => lm.seen.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as { messages: { content: string }[] });
  const sync = (service: WorkspaceService, text: string) => service.workSync({ documentId: service.snapshot().activeDocumentId, text });
  const words = (service: WorkspaceService) => service.workGet()!.words;
  const translated = (service: WorkspaceService) => service.workGet()!.paragraphs.map((p) => p.translation);

  it("reads the text for words, adds the ones that are used when it is translated, and leaves out the ones that are ignored", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const read = (await sync(service, "花子は笑った。\n\n「おはよう」と太郎は言った。\n\n「おはよう」"))!;
    expect(read.paragraphs.map((p) => p.text)).toEqual(["花子は笑った。", "「おはよう」と太郎は言った。", "「おはよう」"]);
    // The words found are drafts: nothing is in the knowledge base yet.
    expect(words(service).filter((n) => n.source === "花子" || n.source === "太郎")).toMatchObject([{ draft: true }, { draft: true }]);
    expect(service.knowledgeList({ kind: "term" }).entries).toEqual([]);
    // The user writes the English names, and ignores one word.
    service.workSetEnglish("花子", "Hanako");
    service.workSetEnglish("太郎", "Taro");
    service.workSetUse("太郎", false);
    expect(words(service).find((n) => n.source === "太郎")).toMatchObject({ english: "Taro", use: false });
    const done = await service.workTranslate({ ...model });
    expect(done.error).toBeNull();
    expect(done.paragraphs.every((p) => p.translation.startsWith("EN(qwen2.5-7b-instruct)"))).toBe(true);

    const first = bodies(lm)[0]!.messages[1]!.content;
    expect(first).toContain("=> Hanako");
    expect(first).not.toContain("=> Taro"); // ignored
    expect(first).not.toContain("CONTEXT"); // nothing before the first paragraph
    // The word that was used is in the knowledge base now, accepted; the ignored one is not.
    expect(service.knowledgeList({ kind: "term" }).entries.map((e) => `${e.source}:${e.target}:${e.status}`)).toEqual(["花子:Hanako:confirmed"]);
    expect(words(service).find((n) => n.source === "花子")).toMatchObject({ draft: false, known: true });
    expect(words(service).find((n) => n.source === "太郎")).toMatchObject({ draft: true, use: false });
  });

  it("translates paragraph by paragraph, and writes one paragraph again without touching the others", async () => {
    let n = 0;
    const lm = await fakeLmStudio({ paragraph: (_user, source, model) => `EN(${model}): ${fakeEnglish(source)} Hanako Taro ${++n}` });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "花子は笑った。\n\n「おはよう」と太郎は言った。\n\n二人は歩いた。");
    service.workSetEnglish("花子", "Hanako");
    service.workSetHint("太郎", "a boy");
    const done = await service.workTranslate({ ...model });
    const parts = done.paragraphs.map((p) => p.translation);
    // One request for each paragraph, and the paragraph's own words in it.
    const asked = bodies(lm).map((b) => b.messages[1]!.content);
    expect(asked).toHaveLength(3);
    expect(asked[0]).toContain("JAPANESE PARAGRAPH TO TRANSLATE:\n花子は笑った。");
    expect(asked[0]).toContain("- 花子 => Hanako");
    expect(asked[0]!.split("JAPANESE PARAGRAPH")[0]).not.toContain("太郎: a boy"); // its glossary and notes have only its own words
    expect(asked[1]).toContain("- 太郎: a boy");
    // A request has the paragraphs before with their translations, and the ones after, whichever side of an old block edge they are.
    expect(asked[0]).not.toContain("CONTEXT");
    expect(asked[0]).toContain("NEXT (the paragraphs after this one, so that you know where the story goes; reference only, do not translate):\nJAPANESE: 「おはよう」と太郎は言った。\n\nJAPANESE: 二人は歩いた。");
    expect(asked[1]).toContain(`CONTEXT (the paragraphs before this one, with their translations; reference only, do not translate):\nJAPANESE: 花子は笑った。\nENGLISH: ${parts[0]}`);
    expect(asked[2]).not.toContain("NEXT");
    expect(parts.every((p) => p.startsWith("EN(qwen2.5-7b-instruct)"))).toBe(true);
    // The system message is the paragraph task.
    expect(bodies(lm)[0]!.messages[0]!.content).toContain("one paragraph at a time");

    // The user's own text for a paragraph is kept.
    expect(service.workSetPart(2, "  My own version. ").paragraphs[2]!.translation).toBe("My own version.");

    // Writing the second paragraph again: the others stay, the old text is not shown, and the paragraph after it is given with its translation.
    const again = await service.workRetranslate({ ...model, paragraph: 1 });
    const sent = bodies(lm).at(-1)!.messages[1]!.content;
    expect(sent).toContain("NEXT (the paragraphs after this one, so that you know where the story goes; reference only, do not translate):\nJAPANESE: 二人は歩いた。\nENGLISH: My own version.");
    expect(sent).not.toContain(parts[1]!);
    expect(sent).not.toContain("REJECTED");
    expect(again.paragraphs[0]!.translation).toBe(parts[0]);
    expect(again.paragraphs[2]!.translation).toBe("My own version.");
  });

  it("carries on where it stopped, and writes the paragraphs from one on again when asked", async () => {
    let n = 0;
    const lm = await fakeLmStudio({ paragraph: (_user, source) => `${fakeEnglish(source)} ${++n}` });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "一つ目。\n\n二つ目。\n\n三つ目。");
    service.workSetPart(1, "Mine.");
    await service.workTranslate({ ...model });
    expect(bodies(lm)).toHaveLength(2); // the paragraph that has a translation is skipped
    expect(translated(service)[1]).toBe("Mine.");
    await service.workTranslate({ ...model, redo: true, from: 1 });
    expect(bodies(lm)).toHaveLength(4);
    expect(translated(service)[1]).not.toBe("Mine.");
    expect(translated(service)[0]).toMatch(/ 1$/); // the first was not written again
  });

  it("asks again, showing the rejected version, when the model gives the same text back", async () => {
    const lm = await fakeLmStudio({ paragraph: () => "Hanako laughed." });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "花子は笑った。");
    await service.workTranslate({ ...model });
    const before = bodies(lm).length;
    const done = await service.workRetranslate({ ...model, paragraph: 0 });
    const sent = bodies(lm).slice(before).map((b) => b.messages[1]!.content);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toContain("REJECTED VERSION");
    expect(sent[1]).toContain("REJECTED VERSION");
    expect(done.paragraphs[0]!.issue).toMatch(/same text again/);
  });

  it("asks again when the model writes about more than the paragraph, and joins the lines if it still does", async () => {
    let calls = 0;
    const lm = await fakeLmStudio({ paragraph: (user) => (user.includes("was several paragraphs") ? (calls++, "Only the paragraph, Hanako.") : "First. Hanako\n\nSecond.\n\nThird.") });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "花子は笑った。");
    const done = await service.workTranslate({ ...model });
    expect(calls).toBe(1);
    expect(done.paragraphs[0]).toMatchObject({ translation: "Only the paragraph, Hanako." });
    expect(done.paragraphs[0]!.issue ?? null).toBeNull();
    const stubborn = await fakeLmStudio({ paragraph: () => "First. Hanako\n\nSecond." });
    provider.save({ baseUrl: stubborn.baseUrl, allowRemote: false });
    const again = await service.workRetranslate({ ...model, paragraph: 0 });
    expect(again.paragraphs[0]!.translation).toBe("First. Hanako Second.");
    expect(again.paragraphs[0]!.issue).toMatch(/several paragraphs, which were joined/);
  });

  it("asks again when the glossary name of the paragraph is left out, and says so if it still is", async () => {
    let calls = 0;
    const lm = await fakeLmStudio({ paragraph: (user) => (user.includes("does not use these exact names") ? "Hanako laughed." : (calls++, "She laughed.")) });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "花子は笑った。");
    service.workSetEnglish("花子", "Hanako");
    const done = await service.workTranslate({ ...model });
    expect(calls).toBe(1);
    expect(done.paragraphs[0]).toMatchObject({ translation: "Hanako laughed." });
    expect(done.paragraphs[0]!.issue ?? null).toBeNull();
    const stubborn = await fakeLmStudio({ paragraph: () => "She laughed." });
    provider.save({ baseUrl: stubborn.baseUrl, allowRemote: false });
    const again = await service.workRetranslate({ ...model, paragraph: 0 });
    expect(again.paragraphs[0]!.issue).toMatch(/does not use the glossary names: 花子 => Hanako/);
  });

  it("asks for each paragraph once, in order, and gives each as much of what is around it as the context has room for", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const paragraphs = Array.from({ length: 80 }, (_, i) => `これは${i}番目の長い段落で、少し言葉が多めに書かれています。`);
    await sync(service, paragraphs.join("\n"));
    const done = await service.workTranslate({ ...model, contextLimit: 2000, maxOutputTokens: 300 });
    const sent = bodies(lm).map((b) => b.messages[1]!.content);
    expect(sent).toHaveLength(80);
    expect(sent.map((u) => /PARAGRAPH TO TRANSLATE:\n(.*)\n/.exec(u)![1])).toEqual(paragraphs);
    expect(sent.every((u) => u.length < 4000)).toBe(true);
    // In the middle of the text there is context on both sides; there is no edge where a block used to end.
    const middle = sent[40]!;
    expect(middle).toContain(paragraphs[39]!);
    expect(middle).toContain(paragraphs[41]!);
    expect(middle).not.toContain(paragraphs[0]!); // only what fits
    expect(done.paragraphs).toHaveLength(80);
  });

  it("translates a bare 山 as its own word: it has its own entry, and the request says it applies only when it stands alone", async () => {
    const lm = await fakeLmStudio({ paragraph: (_user, source) => `EN ${fakeEnglish(source)} Yamada Taro Yamada` });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "ぼくは山田太郎という。\n「山、お待たせしました」");
    // The dictionary's reading is only suggested: it is the name once the user accepts it.
    expect(words(service).find((n) => n.source === "山田太郎")).toMatchObject({ english: "", suggestions: { english: ["Yamada Taro"] } });
    service.workAcceptSuggestion("山田太郎", "english");
    expect(words(service).find((n) => n.source === "山田太郎")).toMatchObject({ english: "Yamada Taro" });
    expect(words(service).find((n) => n.source === "山田太郎")!.suggestions).toBeUndefined();
    // Using the word puts 山田太郎 in the knowledge base. 山 is already a way to write his name; it still gets a translation of its own.
    await service.workTranslate({ ...model });
    const taro = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山田太郎")!;
    service.knowledgeSetFile(taro.id, service.knowledgeFile(taro.id).text.replace("aliases:", "aliases: 山"));
    const added = await service.workAddWord("山");
    expect(added.words.find((n) => n.source === "山")).toMatchObject({ draft: true, kind: "term" });
    service.workSetEnglish("山", "Yamada");

    await service.workTranslate({ ...model, redo: true });
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
    await sync(service, "ぼくは山田太郎という。\n「山、お待たせしました」");
    service.workAcceptSuggestion("山田太郎", "english");
    await service.workTranslate({ ...model });
    const entry = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山田太郎")!;
    service.knowledgeSetFile(entry.id, service.knowledgeFile(entry.id).text.replace("aliases:", "aliases: 山"));

    // Adding a word that is one of his aliases makes a draft that stands for him.
    await service.workAddWord("山");
    const draft = () => words(service).find((n) => n.source === "山")!;
    expect(draft()).toMatchObject({ draft: true, kind: "term", refersTo: "山田太郎", attrs: { "refers to": ["山田太郎"] } });
    expect(service.knowledgeList({ kind: "term" }).entries.some((e) => e.source === "山")).toBe(false);
    service.workSetEnglish("山", "Yamada");
    await service.workTranslate({ ...model, redo: true });
    expect(bodies(lm).at(-1)!.messages[1]!.content).toContain("- 山: a name for Yamada Taro; when it stands on its own, not as part of 山田太郎");
    // Now it is in the knowledge base, with the link.
    expect(service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "山")!.attrs["refers to"]).toEqual(["山田太郎"]);

    // It can be untied and tied again.
    expect(service.workSetAttribute("山", "refers to", []).words.find((n) => n.source === "山")!.refersTo).toBe(null);
    expect(service.workSetAttribute("山", "refers to", ["山田太郎"]).words.find((n) => n.source === "山")!.refersTo).toBe("山田太郎");
  });

  it("makes a word the user adds a term, unless it looks like a name", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "田は花子に会った。魔法使いだ。");
    const kind = async (w: string) => (await service.workAddWord(w)).words.find((n) => n.source === w)?.kind;
    expect(await kind("田")).toBe("term"); // one kanji: not a name
    expect(await kind("掃除当番")).toBe("term"); // a word the user adds is a term, even when it could be read as a name
    expect(words(service).find((n) => n.source === "掃除当番")!.english).toBe("");
    expect(await kind("魔法使い")).toBe("term");
    expect(await kind("桜台学園")).toBe("organization"); // ends like one
  });

  it("sets the attributes of a word from the choices the classes give, on a draft and on a word of the knowledge base, and changes its kind", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "花子は鈴木家の人だ。花子は笑った。");
    expect(words(service).map((n) => n.source)).toEqual(expect.arrayContaining(["花子", "鈴木家"]));

    // The class lists what can be chosen: a gender from its list, a family from the families.
    const files = service.knowledgeFiles();
    expect(files.classes.find((c) => c.name === "character")!.attributes).toEqual(expect.arrayContaining([{ key: "gender", kind: "choice", choices: ["male", "female", "other", "unknown"] }, { key: "family", kind: "link", target: "family" }]));
    service.workSetAttribute("花子", "gender", ["female"]);
    service.workSetAttribute("花子", "family", ["鈴木家"]);
    service.workSetAttribute("花子", "age", ["15"]); // text
    expect(words(service).find((n) => n.source === "花子")).toMatchObject({ draft: true, gender: "female", attrs: { gender: ["female"], family: ["鈴木家"], age: ["15"] } });
    expect(service.knowledgeList({ kind: "term" }).entries).toEqual([]);

    // Only what the class allows.
    expect(() => service.workSetAttribute("花子", "gender", ["purple"])).toThrow(/is one of/);
    expect(() => service.workSetAttribute("花子", "family", ["花子"])).toThrow(/must be a topic/);
    expect(() => service.workSetAttribute("花子", "nonsense", ["x"])).toThrow(/not an attribute/);
    expect(() => service.workSetAttribute("花子", "gender", ["male", "female"])).toThrow(/takes one value/);

    // Used, the word goes to the knowledge base with its attributes; after that the same choices edit the topic itself.
    await service.workTranslate({ ...model });
    const hanako = service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "花子")!;
    expect(hanako).toMatchObject({ status: "confirmed", attrs: { gender: ["female"], family: ["鈴木家"], age: ["15"] } });
    service.workSetAttribute("花子", "gender", ["male"]);
    expect(service.knowledgeFile(hanako.id).text).toContain("gender: male\n");
    expect(service.knowledgeFile(hanako.id).text).toContain("family: [[鈴木家]]");

    // Cleared, and the kind changed: attributes the new kind does not have are dropped.
    service.workSetAttribute("花子", "family", []);
    expect(words(service).find((n) => n.source === "花子")!.attrs!["family"]).toBeUndefined();
    service.workSetKind("花子", "term");
    expect(words(service).find((n) => n.source === "花子")).toMatchObject({ kind: "term", attrs: {} });
    expect(() => service.workSetKind("花子", "nonsense")).toThrow(/no kind of topic/);
  });

  it("drops the English name a reading suggested for a person when the word is changed to another kind, but not one the user wrote", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "鈴木花子は山田太郎に会った。");
    const word = (source: string) => words(service).find((n) => n.source === source)!;
    expect(word("鈴木花子").suggestions).toEqual({ english: ["Suzuki Hanako"] });
    service.workSetKind("鈴木花子", "term");
    expect(word("鈴木花子").suggestions).toBeUndefined(); // made from a reading, which means nothing for a term
    // Written by the user, it stays; and writing it takes the suggestion away.
    service.workSetEnglish("山田太郎", "Taro");
    expect(word("山田太郎").suggestions?.["english"]).toBeUndefined();
    service.workSetKind("山田太郎", "term");
    expect(word("山田太郎").english).toBe("Taro");
  });

  it("lists every glossary word that stands in the text, also ones added to the glossary later, and lets the user write the English name of a draft", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "鈴木花子は魔法の杖を持っていた。");
    expect(words(service).some((n) => n.source === "魔法")).toBe(false);

    // A word added to the glossary afterwards, from anywhere, shows up by itself.
    const magic = service.knowledgeCreate("term", "魔法").id;
    service.knowledgeSetFile(magic, service.knowledgeFile(magic).text.replace(/english:.*/, "english: magic"));
    expect(words(service).find((n) => n.source === "魔法")).toMatchObject({ english: "magic", kind: "term", known: true, draft: false });
    // A word that is not in the text is not listed.
    const dragon = service.knowledgeCreate("term", "竜").id;
    service.knowledgeSetFile(dragon, service.knowledgeFile(dragon).text.replace(/english:.*/, "english: dragon"));
    expect(words(service).some((n) => n.source === "竜")).toBe(false);

    // The user writes the English name of a draft; it is not in the knowledge base until it is used.
    expect(words(service).find((n) => n.source === "鈴木花子")).toMatchObject({ draft: true, known: false });
    service.workSetEnglish("鈴木花子", "  Hanako Suzuki ");
    expect(words(service).find((n) => n.source === "鈴木花子")).toMatchObject({ english: "Hanako Suzuki", draft: true });
    expect(service.knowledgeList({ kind: "term" }).entries.some((e) => e.source === "鈴木花子")).toBe(false);
    await service.workTranslate({ ...model });
    expect(service.knowledgeList({ kind: "term" }).entries.find((e) => e.source === "鈴木花子")).toMatchObject({ target: "Hanako Suzuki", status: "confirmed" });
  });

  it("suggests who says each line, and a speaker is only told to the model once the user has confirmed it", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "「遅いですよ」と花子は言った。\n\n「ごめん」と太郎は言った。\n\n「いいえ」\n\n「本当に？」");
    // Two people are named; the lines that stand alone are said in turn. The rules only suggest it.
    const lines = () => service.workGet()!.lines;
    expect(lines().map((l) => l.suggested)).toEqual(["花子", "太郎", "花子", "太郎"]);
    expect(lines().map((l) => l.speaker)).toEqual([null, null, null, null]);
    service.workSetEnglish("花子", "Hanako");
    await service.workTranslate({ ...model });
    expect(bodies(lm)[0]!.messages[1]!.content).not.toContain("is said by"); // nothing is confirmed yet

    // The user confirms one, and sets another.
    service.workAcceptSpeaker(0);
    service.workSetSpeaker(2, "太郎");
    expect(lines().map((l) => [l.speaker, l.suggested])).toEqual([["花子", null], [null, "太郎"], ["太郎", null], [null, "太郎"]]);
    // A person of the knowledge base who is not written in the text can be picked, and joins the words.
    const sato = service.knowledgeCreate("character", "佐藤").id;
    service.knowledgeSetFile(sato, service.knowledgeFile(sato).text.replace(/english:.*/, "english: Sato"));
    service.workSetSpeaker(3, "佐藤");
    expect(lines()[3]!.speaker).toBe("佐藤");
    expect(words(service).some((n) => n.source === "佐藤")).toBe(true);
    // Only what is confirmed is sent with the paragraph.
    await service.workTranslate({ ...model, redo: true });
    expect(bodies(lm).at(-4)!.messages[1]!.content).toContain("The line 「遅いですよ」 is said by Hanako.");
    expect(bodies(lm).at(-3)!.messages[1]!.content).not.toContain("is said by");
  });

  it("tells the model the dictionary's names as suggestions, and the names the user confirmed as the names to use", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "鈴木花子は山田太郎に会った。");
    service.workSetEnglish("山田太郎", "Taro Yamada");
    await service.workTranslate({ ...model });
    const sent = bodies(lm)[0]!.messages[1]!.content;
    expect(sent).toContain("GLOSSARY:\n- 山田太郎 => Taro Yamada");
    // The dictionary's reading is only how the name sounds, not a spelling to copy.
    expect(sent).toContain("HOW NAMES SOUND (a rough reading of a name from a dictionary, only for the sound; write the name in English the way it is normally spelled, and the same way every time):\n- 鈴木花子 is read: Suzuki Hanako");
    expect(sent).not.toContain("SUGGESTED NAMES");
    expect(sent.split("HOW NAMES SOUND")[1]!.split("\n\n")[0]).not.toContain("山田太郎"); // confirmed: not a suggestion
    // A name the model wrote itself in an earlier translation is a suggestion to keep writing it the same way.
    const word = service.workGet()!.words.find((n) => n.source === "鈴木花子")!;
    word.suggestions = { english: ["Hanako Suzuki"] };
    delete word.fromReading;
    await service.workTranslate({ ...model, redo: true });
    expect(bodies(lm).at(-1)!.messages[1]!.content).toContain("SUGGESTED NAMES (how the name was written before; use it unless it is clearly wrong, and write the name the same way every time):\n- 鈴木花子 => Hanako Suzuki");
  });

  it("reads the translation for suggestions with short questions, and throws away an answer that does not pass its check", async () => {
    const english = ["Taro Yamada laughed.", "Hanako Suzuki cried. She sat down.", '"Good morning," Taro Yamada said.'];
    let k = 0;
    const questions: string[] = [];
    const lm = await fakeLmStudio({
      paragraph: () => english[k++]!,
      answer: (_system, user) => {
        questions.push(user);
        if (user.includes("stand for 「山田太郎」")) return "Taro Yamada";
        if (user.includes("stand for 「鈴木花子」")) return "Suzuki Hanako"; // not written like that in the translation: dropped
        if (user.includes("what is the gender of 「鈴木花子」")) return "A"; // male: the pronouns say she, so dropped
        if (user.includes("what is the gender of 「山田太郎」")) return "A";
        if (user.includes("Who says it?")) return "A";
        return "NONE";
      },
    });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "山田太郎は笑った。\n\n鈴木花子は泣いた。彼女は座った。\n\n「おはよう」と山田太郎は言った。");
    await service.workTranslate({ ...model });
    const done = await service.workSuggest({ ...model });
    const word = (source: string) => done.words.find((n) => n.source === source)!;
    // The name was copied from the translation, so it is suggested (in place of the dictionary's reading).
    expect(word("山田太郎").suggestions?.["english"]).toEqual(["Taro Yamada"]);
    expect(word("鈴木花子").suggestions?.["english"]).toEqual(["Suzuki Hanako"]); // the dictionary's reading stays: nothing better came back
    expect(word("山田太郎").suggestions?.["gender"]).toEqual(["male"]);
    expect(word("鈴木花子").suggestions?.["gender"]).toEqual(["female"]); // the rules' suggestion from the text, not the model's wrong answer
    expect(done.lines[0]!.suggested).toBe("山田太郎");
    expect(done.reading ?? null).toBeNull();
    // Nothing was confirmed.
    expect(word("山田太郎").english).toBe("");
    expect(done.lines[0]!.speaker).toBeNull();
    // The questions are short: they have the paragraphs that matter, and a letter or copied words as the answer.
    expect(questions.every((q) => q.length < 1500)).toBe(true);
    expect(questions.find((q) => q.includes("Who says it?"))).toContain("A) Taro Yamada\nB) Suzuki Hanako\nC) not stated");
  });

  it("does not suggest, as the speaker of a line, the person the line is spoken to", async () => {
    const lm = await fakeLmStudio({ paragraph: () => '"Taro, you are fired."', answer: (_system, user) => (user.includes("Who says it?") ? "A" : "NONE") });
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    await sync(service, "「太郎、お前はクビだ」\n\n花子は黙った。\n\n太郎は立ち上がった。");
    await service.workTranslate({ ...model });
    const done = await service.workSuggest({ ...model });
    // The first option is 太郎 (written in the paragraph itself), but the line names him as spoken to: the model's answer is thrown away.
    expect(done.lines[0]!.suggested).not.toBe("太郎");
  });

  it("follows a change in the text: a paragraph that is the same keeps its translation, and the others start again", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const text = "一つ目。\n\n二つ目。\n\n三つ目。";
    await sync(service, text);
    await service.workTranslate({ ...model });
    const before = translated(service);

    // The same text changes nothing.
    expect((await sync(service, text))!.paragraphs.map((p) => p.translation)).toEqual(before);
    // A paragraph added in the middle, and one changed: the others keep their translation.
    const next = await sync(service, "一つ目。\n\n新しい。\n\n二つ目。\n\n全く違う。");
    expect(next!.paragraphs.map((p) => p.translation)).toEqual([before[0], "", before[1], ""]);
    // An empty editor leaves the work alone.
    expect((await sync(service, ""))!.paragraphs).toHaveLength(4);
  });

  it("keeps the work on each document, so switching documents loses nothing, and counts it in the document list", async () => {
    const lm = await fakeLmStudio();
    const { provider, service } = setup();
    provider.save({ baseUrl: lm.baseUrl, allowRemote: false });
    const first = service.snapshot().activeDocumentId;
    await service.workSync({ documentId: first, text: "太郎は笑った。" });
    await service.workTranslate({ ...model });

    // Another document has its own work; the first one's work is kept aside.
    const second = service.createDocument("Second").activeDocumentId;
    expect((await service.workSync({ documentId: second, text: "花子は泣いた。\n花子は笑った。" }))!.paragraphs.map((p) => p.text)).toEqual(["花子は泣いた。", "花子は笑った。"]);
    expect(service.snapshot().documents.map((d) => `${d.done}/${d.total}`)).toEqual(["1/1", "0/2"]);

    // Coming back, the translation is there.
    const back = (await service.workSync({ documentId: first, text: "太郎は笑った。" }))!;
    expect(back.paragraphs[0]!.translation).not.toBe("");
    expect(service.exportProject().work.map((g) => g.documentId).sort()).toEqual([first, second].sort());

    // Deleting a document takes its work with it.
    service.deleteDocument(second);
    expect(service.exportProject().work.map((g) => g.documentId)).toEqual([first]);
  });

  it("is kept in the project", async () => {
    const { service } = setup();
    expect(service.workGet()).toBe(null);
    await sync(service, "短い文。");
    expect(service.exportProject().work.map((g) => g.paragraphs.length)).toEqual([1]);
  });
});
