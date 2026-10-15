import {
  describe,
  expect,
  it,
} from "vitest";
import {
  buildProjectFile,
  parseProject,
  serializeProject,
  type ProjectFile,
} from "./project.js";
import type {
  Work,
} from "./work.js";

const work: Work = {
  documentId: "d1",
  source: "一つ目。\n二つ目。",
  words: [{ source: "魔王", english: "Demon King", kind: "character", aliases: [], reading: "maou", known: true, hint: "villain" }],
  lines: [{ paragraph: 1, text: "「はい」", speaker: "魔王" }],
  paragraphs: [{ text: "一つ目。", translation: "One." }, { text: "二つ目。", translation: "Two.", issue: "something to look at" }],
  error: null,
};

const makeFile = (): ProjectFile =>
  structuredClone(
    buildProjectFile({
      id: "p1",
      title: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      version: 3,
      activeDocumentId: "d1",
      documents: [{ id: "d1", title: "Chapter 1", createdAt: "2026-01-01T00:00:00Z", draft: "一つ目。\n二つ目。" }],
      work: [work],
    }),
  );

const load = (f: ProjectFile) => parseProject(serializeProject(f));
const errorOf = (f: unknown) => {
  const r = parseProject(typeof f === "string" ? f : JSON.stringify(f));
  return r.ok ? null : r.error;
};

describe("project file", () => {
  it("round-trips exactly, including Unicode, the words, who says the lines and the translation of each paragraph", () => {
    const f = makeFile();
    const r = load(f);
    expect(r.ok && r.file).toEqual(f);
    expect(r.ok && r.file.work?.[0]?.paragraphs.map((p) => p.translation)).toEqual(["One.", "Two."]);
  });

  it("is plain JSON with the documented fields only", () => {
    const text = serializeProject(makeFile());
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["activeDocumentId", "documents", "format", "project", "schemaVersion", "work"]);
    expect(text).not.toMatch(/apiKey|Bearer|\/Users\//);
  });

  it("rejects things that are not projects, with plain messages", () => {
    expect(errorOf("not json")).toMatchObject({ code: "not_json" });
    expect(errorOf({ a: 1 })).toMatchObject({ code: "not_project" });
    expect(errorOf({ format: "ltw-project", schemaVersion: 99 })).toMatchObject({ code: "newer_schema", message: expect.stringContaining("newer version") });
  });

  it("rejects wrong shapes with details", () => {
    const f = makeFile();
    (f.documents[0] as unknown as { draft: number }).draft = 5;
    const e = errorOf(f)!;
    expect(e.code).toBe("invalid");
    expect(e.details.join(" ")).toMatch(/documents\.0\.draft/);
  });

  it("brings work saved block by block over: the words, the translation of each paragraph and who says the lines", () => {
    const text = "「遅いですよ」と花子は言った。\n\n「ごめん」と太郎は言った。\n\n二人は歩いた。";
    const word = (source: string, english: string) => ({ source, english, kind: "character", aliases: [], reading: "", known: false, draft: true });
    const f = JSON.parse(serializeProject({ ...makeFile(), documents: [{ id: "d1", title: "Chapter 1", createdAt: "2026-01-01T00:00:00Z", draft: text }] }));
    delete f.work;
    f.guided = {
      documentId: "d1",
      source: text,
      current: 0,
      blocks: [
        {
          index: 0,
          text,
          translation: "",
          parts: ["Late, said Hanako.", "Sorry, said Taro.", ""],
          status: "interpreted",
          error: null,
          interpretation: { names: [word("花子", "Hanako"), word("太郎", "Taro")], narrator: "太郎", narratorWord: "ぼく", lines: [{ text: "「遅いですよ」", speaker: "花子" }, { text: "「ごめん」", speaker: "花子" }] },
        },
      ],
    };
    const r = parseProject(JSON.stringify(f));
    const w = r.ok ? r.file.work![0]! : null;
    expect(w?.paragraphs).toEqual([{ text: "「遅いですよ」と花子は言った。", translation: "Late, said Hanako." }, { text: "「ごめん」と太郎は言った。", translation: "Sorry, said Taro." }, { text: "二人は歩いた。", translation: "" }]);
    expect(w?.words.map((x) => `${x.source}=${x.english}`)).toEqual(["花子=Hanako", "太郎=Taro"]);
    // What the user set for a line stays (the second line was set to 花子, whom the rules would not have chosen).
    expect(w?.lines.map((l) => l.speaker)).toEqual(["花子", "花子"]);
    expect(r.ok && "guided" in r.file).toBe(false);
  });

  it("ignores what older files kept about model runs and block sizes", () => {
    const f = JSON.parse(serializeProject(makeFile()));
    f.documents[0].versions = [{ source: { exactText: "x" }, runs: [] }];
    f.providerLabel = "http://localhost:1234/v1";
    f.settings = { sourceLanguage: "Japanese", targetLanguage: "English", blockSize: "large", models: [], glossary: [], prompts: [] };
    const r = parseProject(JSON.stringify(f));
    expect(r.ok && Object.keys(r.file.documents[0]!).sort()).toEqual(["createdAt", "draft", "id", "title"]);
    expect(r.ok && r.file.settings).toEqual({ sourceLanguage: "Japanese", targetLanguage: "English", models: [], glossary: [], prompts: [] });
  });
});

describe("files from earlier releases", () => {
  const project = { id: "p", title: "Old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", version: 1 };

  it("turns a file from the first release into one document with its text in the editor", () => {
    const r = parseProject(JSON.stringify({ format: "ltw-project", schemaVersion: 1, project, source: { exactText: "最初。" }, runs: [] }));
    expect(r.ok && r.file.documents).toMatchObject([{ title: "Document 1", draft: "最初。" }]);
  });

  it("turns a file from the second release into one document holding the newest text", () => {
    const versions = [{ source: { exactText: "古い。" } }, { source: { exactText: "新しい。" } }];
    const r = parseProject(JSON.stringify({ format: "ltw-project", schemaVersion: 2, project, versions }));
    expect(r.ok && r.file.documents).toMatchObject([{ draft: "新しい。" }]);
    expect(errorOf({ format: "ltw-project", schemaVersion: 2, project, versions: [] })?.code).toBe("invalid");
  });
});

describe("documents and settings", () => {
  it("holds several documents, one of them only a draft", () => {
    const f = makeFile();
    f.documents.push({ id: "d2", title: "Chapter 2", createdAt: "2026-01-01T00:00:00Z", draft: "まだ。" });
    const r = load(f);
    expect(r.ok && r.file.documents.map((d) => d.title)).toEqual(["Chapter 1", "Chapter 2"]);
  });

  it("keeps the project's settings", () => {
    const f = makeFile();
    f.settings = {
      sourceLanguage: "Japanese",
      targetLanguage: "English",
      models: [{ name: "qwen", contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2, promptId: "standard", useGlossary: true }],
      glossary: [{ source: "魔王", target: "Demon King", note: "villain" }],
      prompts: [{ id: "mine", name: "Mine", description: "", template: "Translate." }],
    };
    const r = load(f);
    expect(r.ok && r.file.settings).toEqual(f.settings);
    const bad = structuredClone(f);
    (bad.settings as unknown as { sourceLanguage: number }).sourceLanguage = 5;
    expect(errorOf(bad)?.code).toBe("invalid");
  });

  it("rejects ids that are shared between documents", () => {
    const f = makeFile();
    f.documents.push({ ...structuredClone(f.documents[0]!) });
    const e = errorOf(f)!;
    expect(e.code).toBe("corrupt");
    expect(e.details.join(" ")).toMatch(/used more than once/);
  });

  it("needs at least one document and an open document that exists", () => {
    expect(errorOf({ ...makeFile(), documents: [] })?.code).toBe("invalid");
    const f = makeFile();
    f.activeDocumentId = "ghost";
    expect(errorOf(f)).toMatchObject({ code: "corrupt", message: expect.stringContaining("no longer exists") });
  });
});
