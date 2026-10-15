import { describe, expect, it } from "vitest";
import { buildProjectFile, parseProject, serializeProject, type ProjectFile } from "./project.js";
import type { GuidedState } from "./guided.js";

const guided: GuidedState = {
  documentId: "d1",
  source: "一つ目。\n二つ目。",
  current: 0,
  blocks: [
    {
      index: 0,
      text: "一つ目。\n二つ目。",
      interpretation: { names: [{ source: "魔王", english: "Demon King", kind: "character", aliases: [], reading: "maou", known: true, hint: "villain" }], narrator: null, narratorWord: null, lines: [] },
      translation: "One.\n\nTwo.",
      parts: ["One.", "Two."],
      status: "translated",
      error: null,
    },
  ],
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
      guided: [guided],
    }),
  );

const load = (f: ProjectFile) => parseProject(serializeProject(f));
const errorOf = (f: unknown) => {
  const r = parseProject(typeof f === "string" ? f : JSON.stringify(f));
  return r.ok ? null : r.error;
};

describe("project file", () => {
  it("round-trips exactly, including Unicode and the translation of each paragraph", () => {
    const f = makeFile();
    const r = load(f);
    expect(r.ok && r.file).toEqual(f);
    expect(r.ok && r.file.guided?.[0]?.blocks[0]?.parts).toEqual(["One.", "Two."]);
  });

  it("is plain JSON with the documented fields only", () => {
    const text = serializeProject(makeFile());
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["activeDocumentId", "documents", "format", "guided", "project", "schemaVersion"]);
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

  it("reads a block saved before its paragraphs were translated one by one as one with no paragraphs yet", () => {
    const f = JSON.parse(serializeProject(makeFile()));
    delete f.guided[0].blocks[0].parts;
    const r = parseProject(JSON.stringify(f));
    expect(r.ok && r.file.guided?.[0]?.blocks[0]?.parts).toEqual([]);
  });

  it("reads a single block record (older files) as a list", () => {
    const f = JSON.parse(serializeProject(makeFile()));
    f.guided = f.guided[0];
    const r = parseProject(JSON.stringify(f));
    expect(r.ok && r.file.guided).toHaveLength(1);
  });

  it("ignores what older files kept about model runs", () => {
    const f = JSON.parse(serializeProject(makeFile()));
    f.documents[0].versions = [{ source: { exactText: "x" }, runs: [] }];
    f.providerLabel = "http://localhost:1234/v1";
    const r = parseProject(JSON.stringify(f));
    expect(r.ok && Object.keys(r.file.documents[0]!).sort()).toEqual(["createdAt", "draft", "id", "title"]);
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
      blockSize: "large",
      models: [{ name: "qwen", contextLimit: 4096, maxOutputTokens: 1536, temperature: 0.2, promptId: "standard", useGlossary: true }],
      glossary: [{ source: "魔王", target: "Demon King", note: "villain" }],
      prompts: [{ id: "mine", name: "Mine", description: "", template: "Translate." }],
    };
    const r = load(f);
    expect(r.ok && r.file.settings).toEqual(f.settings);
    const bad = structuredClone(f);
    (bad.settings as { blockSize: string }).blockSize = "huge";
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
