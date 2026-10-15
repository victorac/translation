import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
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
  DEFAULT_CLASSES_TEXT,
  LEGACY_CLASSES_TEXT,
  type ModelSetting,
} from "@ltw/domain";
import {
  createHandler,
} from "./handlers.js";
import {
  ProjectService,
  type FileDialogs,
} from "./project-service.js";

const made: ProjectService[] = [];
afterEach(() => {
  for (const p of made.splice(0)) p.dispose();
});

const model = (name: string): ModelSetting => ({ name, contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2, promptId: "standard", useGlossary: true });
const PARAS = ["最初の段落です。とても短い。", "二番目の段落です。もう少し長い。", "三番目の段落です。さらに続く。"];

function env(opts: { recoveryPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ltw-proj-"));
  const answers: { save?: string | undefined; open?: string | undefined } = {};
  const dialogs: FileDialogs = {
    chooseSavePath: async () => answers.save,
    chooseOpenPath: async () => answers.open,
  };
  const recoveryPath = opts.recoveryPath ?? join(dir, "recovery", "unsaved.ltw.json");
  const make = (over: { recoveryPath?: string } = {}) => {
    const p = new ProjectService({ dialogs, recoveryPath: over.recoveryPath ?? recoveryPath, workspace: { speedMs: 0 }, autosaveMs: 10 });
    made.push(p);
    return p;
  };
  return { dir, answers, recoveryPath, make };
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("timed out");
};

/** Some work to save: the text typed in the open document, cut into blocks, read, and translated paragraph by paragraph. */
const writeSomething = async (p: ProjectService, text = PARAS.join("\n\n")) => {
  const documentId = p.workspace.snapshot().activeDocumentId;
  p.workspace.setDraft(documentId, text);
  p.workspace.guidedSync({ documentId, text, blockSize: "normal" });
  await p.workspace.guidedInterpret(0);
  PARAS.forEach((_, i) => p.workspace.guidedSetPart(0, i, `Translation ${i + 1}`));
};
const partsOf = (p: ProjectService) => p.workspace.guidedGet()?.blocks[0]?.parts;

describe("saving and reopening", () => {
  it("lets the user name the project, keeps that name when it is saved and reopened, and otherwise follows the file's name", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    expect(a.view().title).toBe("Untitled");
    a.rename("  My story  ");
    expect(a.view()).toMatchObject({ title: "My story", dirty: true });
    answers.save = join(dir, "file-name");
    await a.save(false);
    expect(a.view()).toMatchObject({ title: "My story", dirty: false });

    const b = make({ recoveryPath: join(dir, "other-recovery.json") });
    answers.open = join(dir, "file-name.ltw.json");
    await b.open(false);
    expect(b.view().title).toBe("My story");
    // An empty name goes back to the file's name.
    b.rename("   ");
    expect(b.view().title).toBe("file-name");
  });

  it("saves the text and the translation of each paragraph and reopens them exactly as they were", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = join(dir, "My novel");
    await a.save(false);
    expect(existsSync(join(dir, "My novel.ltw.json"))).toBe(true);
    expect(a.view()).toMatchObject({ title: "My novel", dirty: false, path: join(dir, "My novel.ltw.json") });

    const b = make({ recoveryPath: join(dir, "other-recovery.json") });
    answers.open = join(dir, "My novel.ltw.json");
    await b.open(false);
    expect(b.workspace.snapshot().draftText).toBe(PARAS.join("\n\n"));
    expect(partsOf(b)).toEqual(["Translation 1", "Translation 2", "Translation 3"]);
    expect(b.workspace.guidedGet()!.blocks[0]).toMatchObject({ status: "translated", translation: "Translation 1\n\nTranslation 2\n\nTranslation 3" });
    expect(b.view()).toMatchObject({ dirty: false, title: "My novel" });
  });

  it("opens a block saved as one piece of translation, matching it to the paragraphs when their number is the same and keeping all of it otherwise", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = join(dir, "old.ltw.json");
    await a.save(false);
    const file = JSON.parse(readFileSync(join(dir, "old.ltw.json"), "utf8"));
    const open = async (translation: string) => {
      const old = structuredClone(file);
      old.guided[0].blocks[0].translation = translation;
      delete old.guided[0].blocks[0].parts;
      writeFileSync(join(dir, "single.ltw.json"), JSON.stringify(old));
      const b = make({ recoveryPath: join(dir, `r${Math.random()}.json`) });
      answers.open = join(dir, "single.ltw.json");
      await b.open(false);
      return partsOf(b);
    };
    expect(await open("One.\n\nTwo.\n\nThree.")).toEqual(["One.", "Two.", "Three."]);
    expect(await open("The whole translation, as it was written.")).toEqual(["The whole translation, as it was written.", "", ""]);
  });

  it("adds the extension, reuses the path on the next save, and keeps the previous version as .bak", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = join(dir, "book");
    await a.save(false);
    const path = join(dir, "book.ltw.json");
    const first = readFileSync(path, "utf8");
    expect(existsSync(`${path}.bak`)).toBe(false);

    a.workspace.guidedSetPart(0, 0, "changed");
    expect(a.view().dirty).toBe(true);
    answers.save = undefined; // a dialog now would cancel: the second save must not need one
    await a.save(false);
    expect(a.view().dirty).toBe(false);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(first);
    expect(readFileSync(path, "utf8")).not.toBe(first);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("Save As to a new place changes the project's path; cancelling the dialog changes nothing", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = undefined;
    await a.save(true);
    expect(a.view().path).toBeNull();
    expect(a.view().dirty).toBe(true);
    answers.save = join(dir, "x.ltw.json");
    await a.save(true);
    answers.save = join(dir, "y.ltw.json");
    await a.save(true);
    expect(a.view().path).toBe(join(dir, "y.ltw.json"));
    expect(existsSync(join(dir, "x.ltw.json"))).toBe(true);
  });

  it("refuses to save when there is nothing to save", async () => {
    const { make } = env();
    await expect(make().save(false)).rejects.toMatchObject({ code: "nothing_to_save" });
  });

  it("tracks unsaved changes", async () => {
    const { dir, answers, make } = env();
    const a = make();
    expect(a.view().dirty).toBe(false);
    await writeSomething(a);
    expect(a.view().dirty).toBe(true);
    answers.save = join(dir, "d.ltw.json");
    await a.save(false);
    expect(a.view().dirty).toBe(false);
    a.workspace.guidedSetPart(0, 1, "x");
    expect(a.view().dirty).toBe(true);
  });

  it("a failed save leaves the previous file intact, keeps the work open, and says how to recover", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = join(dir, "good.ltw.json");
    await a.save(false);
    const good = readFileSync(join(dir, "good.ltw.json"), "utf8");

    writeFileSync(join(dir, "not-a-folder"), "x");
    a.workspace.guidedSetPart(0, 0, "edited after");
    answers.save = join(dir, "not-a-folder", "nope.ltw.json");
    await expect(a.save(true)).rejects.toMatchObject({ code: "save_failed", message: expect.stringContaining("Save As") });
    expect(a.view()).toMatchObject({ dirty: true, path: join(dir, "good.ltw.json") });
    expect(readFileSync(join(dir, "good.ltw.json"), "utf8")).toBe(good);
    expect(partsOf(a)![0]).toBe("edited after");
  });
});

describe("recovery after the app closes unexpectedly", () => {
  it("offers the unsaved work next time, with the translation as it was", async () => {
    const { dir, recoveryPath, make } = env();
    const a = make();
    await writeSomething(a);
    // The app is killed here: whatever is on disk at this moment is all that survives.
    await until(() => existsSync(recoveryPath));
    const crashCopy = join(dir, "crash-copy.ltw.json");
    copyFileSync(recoveryPath, crashCopy);

    const b = make({ recoveryPath: crashCopy });
    expect(b.view().recovery).toMatchObject({ blocks: 1, documents: 1 });
    expect(b.workspace.guidedGet()).toBeNull();
    b.restoreRecovery();
    expect(partsOf(b)).toEqual(["Translation 1", "Translation 2", "Translation 3"]);
    expect(b.view()).toMatchObject({ dirty: true, recovery: null });
  });

  it("keeps a recovery copy while work is unsaved and removes it after Save", async () => {
    const { dir, answers, recoveryPath, make } = env();
    const a = make();
    await writeSomething(a);
    await until(() => existsSync(recoveryPath));
    answers.save = join(dir, "s.ltw.json");
    await a.save(false);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("does not offer a recovery copy that is older than the saved file", async () => {
    const { dir, answers, recoveryPath, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = join(dir, "later.ltw.json");
    await a.save(false);
    a.workspace.guidedSetPart(0, 0, "unsaved edit");
    await until(() => existsSync(recoveryPath));
    const stale = join(dir, "stale.ltw.json");
    copyFileSync(recoveryPath, stale);
    await new Promise((r) => setTimeout(r, 30));
    await a.save(false); // saved after the copy was made
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, "later.ltw.json"), future, future);
    const b = make({ recoveryPath: stale });
    expect(b.view().recovery).toBeNull();
    expect(existsSync(stale)).toBe(false);
  });

  it("blocks Open and New until recovered work is restored or discarded, and Discard removes the copy", async () => {
    const { dir, answers, recoveryPath, make } = env();
    const a = make();
    await writeSomething(a);
    await until(() => existsSync(recoveryPath));
    const b = make({ recoveryPath });
    expect(b.view().recovery).not.toBeNull();
    answers.open = join(dir, "whatever.ltw.json");
    await expect(b.open(false)).rejects.toMatchObject({ code: "recovery_pending" });
    expect(() => b.newProject()).toThrow(/recovered work/);
    b.discardRecovery();
    expect(b.view().recovery).toBeNull();
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("sets aside an unreadable recovery copy instead of deleting it", () => {
    const { recoveryPath, make } = env();
    mkdirSync(join(recoveryPath, ".."), { recursive: true });
    writeFileSync(recoveryPath, "{ broken");
    const p = make();
    expect(p.view().recovery).toBeNull();
    expect(existsSync(`${recoveryPath}.damaged`)).toBe(true);
  });
});

describe("files that cannot be opened safely", () => {
  const twoSaves = async () => {
    const e = env();
    const a = e.make();
    await writeSomething(a);
    e.answers.save = join(e.dir, "p.ltw.json");
    await a.save(false);
    a.workspace.guidedSetPart(0, 0, "second version");
    await a.save(false);
    return { ...e, path: join(e.dir, "p.ltw.json"), a };
  };

  it("refuses a damaged file, and offers the previous saved copy", async () => {
    const { dir, answers, make, path } = await twoSaves();
    const damaged = readFileSync(path, "utf8").replace('"format"', '"format_"');
    writeFileSync(path, damaged);
    const b = make({ recoveryPath: join(dir, "rb.json") });
    answers.open = path;
    await b.open(false);
    expect(b.workspace.guidedGet()).toBeNull();
    expect(b.view().openProblem).toMatchObject({ canOpenBackup: true });

    await b.open(true);
    const view = b.view();
    expect(partsOf(b)![0]).toBe("Translation 1"); // the copy from before the second save
    expect(view).toMatchObject({ path: null, dirty: true, title: "Untitled", openProblem: null });
    expect(view.notice).toMatch(/previous saved copy/);
    expect(readFileSync(path, "utf8")).toBe(damaged); // the damaged file was not touched
  });

  it("saving the recovered copy elsewhere never overwrites the good backup", async () => {
    const { dir, answers, make, path } = await twoSaves();
    const goodBackup = readFileSync(`${path}.bak`, "utf8");
    writeFileSync(path, "garbage");
    const b = make({ recoveryPath: join(dir, "rc.json") });
    answers.open = path;
    await b.open(false);
    await b.open(true);
    answers.save = join(dir, "recovered.ltw.json");
    await b.save(false);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(goodBackup);
    expect(b.view()).toMatchObject({ dirty: false, title: "recovered" });
  });

  it("explains a damaged file with no backup, and files that are not projects or are too new", async () => {
    const { dir, answers, make } = env();
    const b = make();
    const tryOpen = async (content: string) => {
      const p = join(dir, `f${Math.random()}.ltw.json`);
      writeFileSync(p, content);
      answers.open = p;
      await b.open(false);
      return b.view().openProblem;
    };
    expect(await tryOpen("not json")).toMatchObject({ canOpenBackup: false, message: expect.stringContaining("not readable") });
    expect(await tryOpen('{"a":1}')).toMatchObject({ message: expect.stringContaining("not a Local Translation Workbench project") });
    expect(await tryOpen('{"format":"ltw-project","schemaVersion":9}')).toMatchObject({ message: expect.stringContaining("newer version") });
    answers.open = join(dir, "missing.ltw.json");
    await b.open(false);
    expect(b.view().openProblem?.message).toMatch(/could not be read/);
    b.dismissProblem();
    expect(b.view().openProblem).toBeNull();
    expect(b.workspace.guidedGet()).toBeNull();
  });

  it("a failed open leaves the current workspace alone", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = join(dir, "ok.ltw.json");
    await a.save(false);
    const bad = join(dir, "bad.ltw.json");
    writeFileSync(bad, "nope");
    answers.open = bad;
    await a.open(false);
    expect(partsOf(a)).toEqual(["Translation 1", "Translation 2", "Translation 3"]);
    expect(a.view().openProblem).not.toBeNull();
  });
});

describe("other rules", () => {
  it("New project empties the workspace and removes the recovery copy", async () => {
    const { recoveryPath, make } = env();
    const a = make();
    await writeSomething(a);
    await until(() => existsSync(recoveryPath));
    a.newProject();
    expect(a.workspace.snapshot().draftText).toBe("");
    expect(a.workspace.guidedGet()).toBeNull();
    expect(a.view()).toMatchObject({ title: "Untitled", dirty: false, path: null });
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("the window's commands work through the handler and the project info reaches the snapshot", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const h = createHandler(a.workspace, undefined, a);
    const documentId = a.workspace.snapshot().activeDocumentId;
    expect((await h("1", "document.setText", { documentId, text: PARAS.join("\n\n") })).ok).toBe(true);
    answers.save = join(dir, "via-handler.ltw.json");
    const saved = await h("2", "project.save", { saveAs: false });
    expect(saved).toMatchObject({ ok: true, value: { project: { title: "via-handler", dirty: false } } });
    expect(await h("3", "project.save", { saveAs: "yes" })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await h("4", "project.new", undefined)).toMatchObject({ ok: true, value: { draftText: "", project: { title: "Untitled" } } });
    answers.open = join(dir, "via-handler.ltw.json");
    expect(await h("5", "project.open", { useBackup: false })).toMatchObject({ ok: true, value: { draftText: PARAS.join("\n\n"), project: { title: "via-handler" } } });
    expect(await createHandler(a.workspace)("6", "project.new", undefined)).toMatchObject({ ok: false, error: { code: "no_project" } });
    expect(await h("7", "job.start", {})).toMatchObject({ ok: false, error: { code: "unknown_command" } });
  });
});

describe("settings in saved projects", () => {
  const settings = {
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    blockSize: "normal" as const,
    models: [model("alpha")],
    glossary: [],
    notes: "",
    prompts: [],
  };

  it("syncing settings does not mark the project as having unsaved changes, and a change to them does", async () => {
    const { dir, answers, make } = env();
    const a = make();
    a.workspace.syncSettings(settings);
    await writeSomething(a);
    answers.save = join(dir, "s.ltw.json");
    await a.save(false);
    expect(a.view().dirty).toBe(false);
    a.workspace.syncSettings(settings);
    expect(a.view().dirty).toBe(false);
    a.workspace.syncSettings({ ...settings, targetLanguage: "French" });
    expect(a.view().dirty).toBe(true);
  });
});

describe("documents in saved projects", () => {
  it("saves every document with its text and work and the project's shared settings, and reopens them", async () => {
    const { dir, answers, make } = env();
    const a = make();
    a.workspace.syncSettings({ sourceLanguage: "Japanese", targetLanguage: "English", blockSize: "normal", models: [model("alpha")], glossary: [], notes: "", prompts: [] });
    await writeSomething(a);
    const first = a.workspace.snapshot().activeDocumentId;
    a.workspace.createDocument("Chapter 2");
    a.workspace.setDraft(a.workspace.snapshot().activeDocumentId, "まだ訳していない章。");
    a.workspace.selectDocument(first);
    answers.save = join(dir, "book.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "book.ltw.json");
    await b.open(false);
    const snap = b.workspace.snapshot();
    expect(snap.documents.map((d) => [d.title, d.total > 0, d.hasText])).toEqual([["Document 1", true, true], ["Chapter 2", false, true]]);
    expect(snap.documents[0]).toMatchObject({ done: 1, total: 1 });
    expect(snap.activeDocumentId).toBe(first);
    expect(snap.settings?.models.map((m) => m.name)).toEqual(["alpha"]);
    expect(partsOf(b)).toEqual(["Translation 1", "Translation 2", "Translation 3"]);
    expect(b.workspace.selectDocument(snap.documents[1]!.id).draftText).toBe("まだ訳していない章。");
    expect(b.view().dirty).toBe(false);
  });

  it("text typed but not yet cut into blocks counts as work: it can be saved, makes the project unsaved, and survives a crash", async () => {
    const { dir, recoveryPath, answers, make } = env();
    const a = make();
    expect(a.view().dirty).toBe(false);
    a.workspace.setDraft(a.workspace.snapshot().activeDocumentId, "長い文章を書いている途中。");
    expect(a.view().dirty).toBe(true);
    await until(() => existsSync(recoveryPath));
    const crashCopy = join(dir, "crash.ltw.json");
    copyFileSync(recoveryPath, crashCopy);

    const b = make({ recoveryPath: crashCopy });
    expect(b.view().recovery).toMatchObject({ blocks: 0, documents: 1 });
    b.restoreRecovery();
    expect(b.workspace.snapshot().draftText).toBe("長い文章を書いている途中。");

    answers.save = join(dir, "draft.ltw.json");
    await a.save(false); // saving is allowed with only a draft
    expect(existsSync(join(dir, "draft.ltw.json"))).toBe(true);
  });

  it("switching documents is not a change to save, but adding, renaming and typing are", async () => {
    const { dir, answers, make } = env();
    const a = make();
    await writeSomething(a);
    answers.save = join(dir, "d.ltw.json");
    await a.save(false);
    const first = a.workspace.snapshot().activeDocumentId;
    expect(a.view().dirty).toBe(false);
    a.workspace.createDocument();
    expect(a.view().dirty).toBe(true);
    await a.save(false);
    a.workspace.selectDocument(first);
    expect(a.view().dirty).toBe(false);
    a.workspace.renameDocument(first, "Prologue");
    expect(a.view().dirty).toBe(true);
    await a.save(false);
    a.workspace.setDraft(first, "変更。");
    expect(a.view().dirty).toBe(true);
  });

  it("opens a project saved by an earlier release as one document holding its text", async () => {
    const { dir, answers, make } = env();
    const project = { id: "p", title: "Old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", version: 1 };
    // The second release kept several versions of the text; the newest is taken. The first kept just one.
    writeFileSync(join(dir, "v2.ltw.json"), JSON.stringify({ format: "ltw-project", schemaVersion: 2, project, versions: [{ source: { exactText: "古い版。" }, runs: [] }, { source: { exactText: "新しい版。" }, runs: [] }] }));
    writeFileSync(join(dir, "v1.ltw.json"), JSON.stringify({ format: "ltw-project", schemaVersion: 1, project, source: { exactText: "最初の版。" }, runs: [] }));
    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "v2.ltw.json");
    await b.open(false);
    expect(b.view().openProblem).toBeNull();
    expect(b.workspace.snapshot().documents).toHaveLength(1);
    expect(b.workspace.snapshot().draftText).toBe("新しい版。");
    expect(b.workspace.snapshot().settings).toBeNull(); // the window keeps its own choices
    answers.open = join(dir, "v1.ltw.json");
    await b.open(false);
    expect(b.workspace.snapshot().draftText).toBe("最初の版。");
  });

  it("a new project starts with one empty document and forgets the old settings", async () => {
    const { make } = env();
    const a = make();
    a.workspace.syncSettings({ sourceLanguage: "Japanese", targetLanguage: "English", blockSize: "normal", models: [model("alpha")], glossary: [], notes: "", prompts: [] });
    await writeSomething(a);
    a.workspace.createDocument();
    a.newProject();
    const snap = a.workspace.snapshot();
    expect(snap.documents).toHaveLength(1);
    expect(snap.settings).toBeNull();
    expect(a.view().dirty).toBe(false);
  });
});

describe("names, hints and notes in saved projects", () => {
  it("saves the knowledge with the project, reopens it, and brings an older project's glossary over once", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const king = a.workspace.knowledgeCreate("character", "魔王").id;
    a.workspace.knowledgeSetFile(king, a.workspace.knowledgeFile(king).text.replace("english: 魔王", "english: Demon King"));
    answers.save = join(dir, "kb.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "kb.ltw.json");
    await b.open(false);
    expect(b.workspace.knowledgeList({}).entries).toMatchObject([{ source: "魔王", target: "Demon King" }]);
    expect(b.workspace.snapshot().knowledge).toMatchObject({ terms: 1 });

    // An older project kept them in its settings.
    const old = JSON.parse(readFileSync(join(dir, "kb.ltw.json"), "utf8"));
    delete old.knowledge;
    old.settings = { sourceLanguage: "Japanese", targetLanguage: "English", blockSize: "normal", models: [], glossary: [{ source: "勇者", target: "Hero" }], notes: "Keep honorifics.", prompts: [] };
    writeFileSync(join(dir, "old.ltw.json"), JSON.stringify(old));
    const c = make({ recoveryPath: join(dir, "r2.json") });
    answers.open = join(dir, "old.ltw.json");
    await c.open(false);
    expect(c.workspace.knowledgeList({}).entries).toMatchObject([{ kind: "term", source: "勇者" }]);
    expect(c.workspace.knowledgeList({}).entries).toHaveLength(1); // the old loose note was left behind
    expect(c.workspace.snapshot().settings?.glossary).toEqual([]);
  });
});

describe("topics in saved projects", () => {
  it("saves topics with their attributes and links, and the classes, and reopens them", async () => {
    const { dir, answers, make } = env();
    const a = make();
    const school = a.workspace.knowledgeCreate("place", "学園").id;
    const hanako = a.workspace.knowledgeCreate("character", "花子").id;
    a.workspace.knowledgeSetFile(hanako, a.workspace.knowledgeFile(hanako).text.replace("english: 花子", "english: Hanako").replace("gender:", "gender: female").replace("lives in:", "lives in: [[学園]]"));
    a.workspace.knowledgeSetFile("classes", "# item\nowner: link(character)\n");
    answers.save = join(dir, "topics.ltw.json");
    await a.save(false);

    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "topics.ltw.json");
    await b.open(false);
    expect(b.workspace.knowledgeFiles().classes.map((c) => c.name)).toEqual(["item"]);
    expect(b.workspace.knowledgeList({ kind: "term" }).entries.find((e) => e.id === hanako)).toMatchObject({ target: "Hanako", attrs: { gender: ["female"], "lives in": ["学園"] } });
    expect(b.workspace.knowledgeFile(school).backlinks).toEqual([{ id: hanako, title: "花子" }]);
  });

  it("replaces the old default classes text by the explained default when a project still has it", async () => {
    const { dir, answers, make } = env();
    const a = make();
    a.workspace.knowledgeCreate("character", "花子");
    answers.save = join(dir, "old-classes.ltw.json");
    await a.save(false);
    const file = JSON.parse(readFileSync(join(dir, "old-classes.ltw.json"), "utf8"));
    file.knowledge.classes = LEGACY_CLASSES_TEXT;
    writeFileSync(join(dir, "old-classes.ltw.json"), JSON.stringify(file));
    const b = make({ recoveryPath: join(dir, "r.json") });
    answers.open = join(dir, "old-classes.ltw.json");
    await b.open(false);
    expect(b.workspace.knowledgeFile("classes").text).toBe(DEFAULT_CLASSES_TEXT);
  });
});
