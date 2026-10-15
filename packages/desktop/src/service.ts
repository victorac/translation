import {
  allPrompts,
  glossaryFor,
  addressedIn,
  occurrencesOf,
  suggestionsFor,
  nameQuestion,
  copiedWords,
  choiceQuestion,
  chosenOption,
  pronounGender,
  speakerQuestion,
  type Evidence,
  glossaryHits,
  labelDocument,
  readWords,
  syncParagraphs,
  findQuotes,
  nameGuess,
  notesFor,
  STANDARD_PROMPT,
  type Word,
  type Work,
  type WorkLine,
  type KnownWord,
  type ModelInput,
  type NameKind,
  entriesFromLegacy,
  applyFile,
  backlinksOf,
  classLabel,
  DEFAULT_CLASSES_TEXT,
  dropLooseNotes,
  isOldDefaultClasses,
  fileText,
  listFiles,
  newTopic,
  parseClasses,
  resolveName,
  titleOf,
  DEFAULTS,
  estimateTokens,
  newId,
  normalizeSource,
  renderPrompt,
  stripThinking,
  paragraphSystem,
  paragraphMessage,
  type Pair,
  answerOf,
  missingNames,
  targetVariants,
  validatePrompt,
  type Backend,
  type DocumentView,
  type EntryQuery,
  type KnowledgeEntry,
  type FileContext,
  type KnowledgeFile,
  type KnowledgeFiles,
  type KnowledgeList,
  type ProjectDocument,
  type ProjectSettings,
  type ProjectView,
  type SyncSettingsInput,
  type WorkspaceSnapshot,
} from "@ltw/domain";
import {
  findCandidateNames,
  readNames,
} from "./analyzer.js";
import {
  UserError,
} from "./errors.js";
import {
  KnowledgeStore,
} from "./knowledge-store.js";
import type {
  ProviderService,
} from "./provider-service.js";

export { UserError };

export interface ServiceOptions {
  /** Override the practice translator's speed (tests use 0). */
  speedMs?: number;
  /** The saved connection to a real model server. Without it only the practice translator is available. */
  provider?: ProviderService;
  /** Describes the open project for the window. */
  projectView?: () => ProjectView;
}

/** `view`: only how things are shown changed (nothing to save). */
export type ChangeKind = "state" | "view";

const NO_PROJECT: ProjectView = { title: "Untitled", path: null, dirty: false, lastSavedAt: null, recovery: null, openProblem: null, notice: null };

/** One text in the project (a chapter, a scene...). */
interface Doc {
  id: string;
  title: string;
  createdAt: string;
  /** The text in the editor. */
  draft: string;
}

const newDoc = (title: string): Doc => ({ id: newId(), title, createdAt: new Date().toISOString(), draft: "" });


/**
 * The background side of the app for one open project: its documents, the knowledge base, the settings, and for each document the
 * blocks of its text with what was read from each and the translation of each paragraph. Every window action ends up in one of
 * these methods.
 */
export class WorkspaceService {
  private docs: Doc[] = [newDoc("Document 1")];
  private activeDocId = this.docs[0]!.id;
  /** Changes when a project is opened, restored or started, so the window reloads its choices. */
  private epoch = 0;
  /** The project's shared choices (models, styles, languages), or null until the window sends them. */
  private settings: ProjectSettings | null = null;
  /** The project's names, hints and notes. Every translation draws on it. */
  private readonly knowledge = new KnowledgeStore();
  private listeners = new Set<(kind: ChangeKind) => void>();

  constructor(private readonly options: ServiceOptions = {}) {}

  /** The open document. */
  private get doc(): Doc {
    return this.docs.find((d) => d.id === this.activeDocId) ?? this.docs[0]!;
  }

  /** There is something worth saving: text typed in any document, a second document, or something in the knowledge base. */
  get hasContent(): boolean {
    return this.docs.some((d) => d.draft.trim() !== "") || this.docs.length > 1 || this.knowledge.counts().terms + this.knowledge.counts().notes > 0;
  }

  /** A request to a model is running (translating, writing a paragraph again). */
  get busy(): boolean {
    return this.analysisAbort !== null;
  }

  onChange(listener: (kind: ChangeKind) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- running ----

  /**
   * The window tells the service about the choices that decide how blocks are translated, whenever they change.
   * Retries then use them, and blocks translated under older choices are marked out of date.
   * Choices that cannot be used yet (for example a half-typed glossary row) are ignored until fixed.
   */
  syncSettings(input: SyncSettingsInput): WorkspaceSnapshot {
    // The choices are part of the project. Only a real change counts as something to save.
    const next: ProjectSettings = {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      models: input.models,
      glossary: input.glossary,
      notes: input.notes ?? "",
      ...(input.knowledge !== undefined ? { knowledge: input.knowledge } : {}),
      prompts: input.prompts,
    };
    const changed = this.settings !== null && JSON.stringify(this.settings) !== JSON.stringify(next);
    this.settings = next;
    this.notify(changed ? "state" : "view");
    return this.snapshot();
  }

  createDocument(title?: string): WorkspaceSnapshot {
    const name = title?.trim() || `Document ${this.docs.length + 1}`;
    const doc = newDoc(name.slice(0, 200));
    this.docs.push(doc);
    this.activeDocId = doc.id;
    this.notify("state");
    return this.snapshot();
  }

  /** Switching documents only changes what is shown. It never stops work that is running. */
  selectDocument(documentId: string): WorkspaceSnapshot {
    this.findDoc(documentId);
    this.activeDocId = documentId;
    this.notify("view");
    return this.snapshot();
  }

  renameDocument(documentId: string, title: string): WorkspaceSnapshot {
    const doc = this.findDoc(documentId);
    const name = title.trim();
    if (name === "") throw new UserError("bad_title", "A document needs a name.");
    doc.title = name.slice(0, 200);
    this.notify("state");
    return this.snapshot();
  }

  /** Removes a document and the work on it. The last document is emptied instead of removed. */
  deleteDocument(documentId: string): WorkspaceSnapshot {
    const doc = this.findDoc(documentId);
    if (this.busy) throw new UserError("busy", "Stop what the model is doing before deleting a document.");
    const index = this.docs.indexOf(doc);
    if (this.docs.length === 1) {
      const empty = newDoc("Document 1");
      this.docs = [empty];
      this.activeDocId = empty.id;
    } else {
      this.docs.splice(index, 1);
      if (this.activeDocId === documentId) this.activeDocId = this.docs[Math.min(index, this.docs.length - 1)]!.id;
    }
    this.workByDoc.delete(documentId);
    if (this.work?.documentId === documentId) this.work = null;
    this.notify("state");
    return this.snapshot();
  }

  /** The text in a document's editor. It is saved with the project. */
  setDraft(documentId: string, text: string): WorkspaceSnapshot {
    const doc = this.findDoc(documentId);
    if (text.length > 5_000_000) throw new UserError("too_large", "That text is too long.");
    if (doc.draft !== text) {
      doc.draft = text;
      this.notify("state");
    }
    return this.snapshot();
  }

  private findDoc(documentId: string): Doc {
    const doc = this.docs.find((d) => d.id === documentId);
    if (!doc) throw new UserError("unknown_document", "That document does not exist.");
    return doc;
  }

  // ---- saving and loading ----

  /** Everything a project file needs: every document, the shared settings, the knowledge base and the work on each document. */
  exportProject(): { documents: ProjectDocument[]; activeDocumentId: string; settings: ProjectSettings | null; knowledge: { entries: KnowledgeEntry[]; classes: string }; work: Work[] } {
    return {
      documents: this.docs.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, draft: d.draft })),
      activeDocumentId: this.activeDocId,
      settings: this.settings ? structuredClone(this.settings) : null,
      knowledge: { entries: this.knowledge.everything(), classes: this.classesText },
      work: [...this.workByDoc.values(), ...(this.work ? [this.work] : [])].map((g) => {
        const { reading: _reading, ...saved } = structuredClone(g);
        return saved;
      }),
    };
  }

  /** Replaces the open workspace with a saved project (already checked and settled by the caller). */
  restore(project: { documents: ProjectDocument[]; activeDocumentId: string; work?: Work[] | undefined; settings?: ProjectSettings | undefined; knowledge?: { entries: KnowledgeEntry[]; classes?: string | undefined } | undefined }): void {
    if (this.busy) throw new UserError("busy", "Stop what the model is doing first.");
    this.clear();
    this.docs = project.documents.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, draft: d.draft }));
    this.activeDocId = this.docs.some((d) => d.id === project.activeDocumentId) ? project.activeDocumentId : this.docs[0]!.id;
    this.settings = project.settings ? structuredClone(project.settings) : null;
    this.work = null;
    this.workByDoc = new Map((project.work ?? []).map((g) => [g.documentId, structuredClone(g)] as const));
    this.classesText = project.knowledge?.classes === undefined || isOldDefaultClasses(project.knowledge.classes) ? DEFAULT_CLASSES_TEXT : project.knowledge.classes;
    if (project.knowledge) this.knowledge.load(dropLooseNotes(project.knowledge.entries as KnowledgeEntry[]));
    else if (this.settings && (this.settings.glossary.length > 0 || this.settings.notes || this.settings.knowledge)) {
      // A project from before the knowledge store: bring its glossary and notes over once.
      this.knowledge.load(entriesFromLegacy(this.settings.glossary, this.settings.notes, this.settings.knowledge, { newId, now: () => new Date().toISOString() }));
      this.settings = { ...this.settings, glossary: [], notes: "" };
      delete this.settings.knowledge;
    } else this.knowledge.load([]);
    this.epoch++;
    this.notify("state");
  }

  /** Starts over with an empty workspace. */
  reset(): void {
    this.clear();
    this.notify("state");
  }

  private clear(): void {
    this.docs = [newDoc("Document 1")];
    this.activeDocId = this.docs[0]!.id;
    this.settings = null;
    this.work = null;
    this.workByDoc.clear();
    this.knowledge.load([]);
    this.classesText = DEFAULT_CLASSES_TEXT;
    this.epoch++;
  }

  // ---- what the window sees ----

  snapshot(): WorkspaceSnapshot {
    return {
      documents: this.documentViews(),
      activeDocumentId: this.activeDocId,
      draftText: this.doc.draft,
      epoch: this.epoch,
      settings: this.settings,
      knowledge: { ...this.knowledge.counts(), rev: this.knowledge.rev },
      project: this.options.projectView?.() ?? NO_PROJECT,
    };
  }

  // ---- internals ----

  /** The left rail's list: each document with how far its translation has got (paragraphs translated, of all its paragraphs). */
  private documentViews(): DocumentView[] {
    return this.docs.map((d) => {
      const work = this.work?.documentId === d.id ? this.work : this.workByDoc.get(d.id);
      return { id: d.id, title: d.title, done: work?.paragraphs.filter((p) => p.translation.trim() !== "").length ?? 0, total: work?.paragraphs.length ?? 0, hasText: d.draft.trim() !== "" };
    });
  }

  private notify(kind: ChangeKind = "state"): void {
    for (const l of this.listeners) l(kind);
  }

  // ---- names, hints and notes ----

  private documentRefs() {
    return this.docs.map((d) => ({ id: d.id, title: d.title }));
  }

  /** The kinds of topic and their attributes, as the user last wrote them. */
  private classesText = DEFAULT_CLASSES_TEXT;

  private fileContext(): FileContext {
    return { entries: this.knowledge.all(), classes: parseClasses(this.classesText).classes, classesText: this.classesText, docs: this.documentRefs() };
  }

  /** The files of the knowledge base: topics, scenes, summaries, the notes and the classes. */
  knowledgeFiles(): KnowledgeFiles {
    const ctx = this.fileContext();
    return { files: listFiles(ctx), classes: ctx.classes.map((c) => ({ name: c.name, label: classLabel(c.name), attributes: c.attributes })), rev: this.knowledge.rev };
  }

  knowledgeFile(id: string, problems: { line: number; message: string }[] = []): KnowledgeFile {
    const ctx = this.fileContext();
    const text = fileText(id, ctx);
    if (text === null) throw new UserError("no_file", "That file no longer exists.");
    return { id, title: titleOf(id, ctx), text, problems, backlinks: backlinksOf(id, ctx), rev: this.knowledge.rev };
  }

  /**
   * Applies an edited file. Lines that could not be understood are reported and leave their entries as they were;
   * the text that comes back is the file in its tidy form.
   */
  knowledgeSetFile(id: string, text: string): KnowledgeFile {
    const result = applyFile(this.knowledge.everything(), id, text, this.fileContext(), { newId, now: () => new Date().toISOString() });
    const before = this.knowledge.rev;
    if (result.classesText !== undefined) {
      if (result.classesText !== this.classesText) {
        this.classesText = result.classesText;
        this.knowledge.touch();
      }
    } else this.knowledge.replaceWith(result.entries);
    if (this.knowledge.rev !== before) this.knowledgeChanged();
    const exists = id === "classes" || this.knowledge.all().some((e) => e.id === id);
    if (!exists) throw new UserError("no_file", "That file no longer exists.");
    const file = this.knowledgeFile(id, result.problems);
    // The same checks on the tidied text, so the window can show the problems where the lines now are.
    const again = applyFile(this.knowledge.everything(), id, file.text, this.fileContext(), { newId, now: () => new Date().toISOString() });
    return { ...file, tidyProblems: again.problems };
  }

  /** Makes a new, empty topic of a class and returns its file. */
  knowledgeCreate(type: string, name: string): { id: string } {
    const clean = name.trim();
    if (clean === "") throw new UserError("bad_name", "Enter a name.");
    const existing = resolveName(clean, this.knowledge.all());
    if (existing) throw new UserError("duplicate_topic", `There is already a topic called "${existing.source}".`);
    const topic = newTopic(type, clean, { newId, now: () => new Date().toISOString() });
    this.knowledge.replaceWith([...this.knowledge.everything(), topic]);
    this.knowledgeChanged();
    return { id: topic.id };
  }

  /**
   * Deletes a file. A topic a model suggested is remembered as rejected so it is not suggested again;
   * anything else is removed for good. The notes and classes files cannot be deleted.
   */
  knowledgeDelete(id: string): { removed: boolean } {
    const entry = this.knowledge.all().find((e) => e.id === id);
    if (!entry) return { removed: false };
    if (entry.kind === "term" && entry.status === "suggested") {
      const all = this.knowledge.everything();
      this.knowledge.replaceWith(
        all
          .filter((e) => !(e.kind === "note" && e.about === id && e.status === "confirmed"))
          .map((e) => (e.id === id || (e.kind === "note" && e.about === id) ? { ...e, status: "rejected" as const } : e.kind === "scene" ? { ...e, related: e.related.filter((r) => r !== id) } : e)),
      );
    } else this.knowledge.remove([id]);
    this.knowledgeChanged();
    return { removed: true };
  }

  knowledgeResolve(name: string): { id: string | null; title: string | null } {
    const hit = resolveName(name, this.knowledge.all());
    return { id: hit?.id ?? null, title: hit?.source ?? null };
  }

  knowledgeList(query: EntryQuery): KnowledgeList {
    const { entries, total } = this.knowledge.list(query);
    return { entries, total, counts: this.knowledge.counts(), rev: this.knowledge.rev };
  }

  knowledgeConfirm(ids?: string[]): { confirmed: number } {
    const confirmed = this.knowledge.confirm(ids);
    if (confirmed > 0) this.knowledgeChanged();
    return { confirmed };
  }

  /** The names, hints or notes changed: the window is told to ask again. */
  private knowledgeChanged(): void {
    this.notify("state");
  }

  // ---- the work on a document ----

  /** The work on the open document. The other documents' work is kept beside it and comes back when they are opened. */
  private work: Work | null = null;
  private workByDoc = new Map<string, Work>();
  /** Counts the readings of the text, so that one that finishes after a newer one started is dropped. */
  private readings = 0;

  /** Makes the work of this document the one being worked on. */
  private useDocument(documentId: string): void {
    if (this.work && this.work.documentId === documentId) return;
    if (this.work) this.workByDoc.set(this.work.documentId, this.work);
    this.work = this.workByDoc.get(documentId) ?? null;
    this.workByDoc.delete(documentId);
  }

  workGet(): Work | null {
    this.useDocument(this.activeDocId);
    return this.work ? this.workView() : null;
  }

  /**
   * The work with every word taken from the glossary as it is now, so a topic edited or deleted in the knowledge pane shows right
   * away: its English form, kind, aliases and gender. A word whose topic is gone is no longer listed.
   */
  private workView(): Work {
    const w = this.work!;
    const terms = this.knowledge.all().filter((e) => e.kind === "term");
    // Every word of the glossary that stands in the text is listed, including ones added to the glossary after the text was read.
    for (const e of glossaryHits(w.source, terms)) {
      if (!w.words.some((n) => n.source === e.source)) w.words.push({ source: e.source, english: e.target, kind: "term", aliases: [], reading: "", known: e.status === "confirmed", draft: false });
    }
    const kinds: NameKind[] = ["character", "family", "place", "organization", "term"];
    w.words = w.words.flatMap((n) => {
      const e = terms.find((t) => t.source === n.source);
      if (e) {
        const gender = (e.attrs["gender"] ?? [])[0];
        const nicknames = terms.filter((t) => t.id !== e.id && (t.attrs["refers to"] ?? []).includes(e.source)).map((t) => t.source);
        // A suggestion is dropped once the topic has that field itself.
        const suggestions = Object.fromEntries(Object.entries(n.suggestions ?? {}).filter(([key]) => (key === "english" ? e.target.trim() === "" : !(e.attrs[key] ?? []).length)));
        const { suggestions: _old, fromReading, ...rest } = n;
        return [{ ...rest, ...(fromReading && suggestions["english"] ? { fromReading } : {}), ...(Object.keys(suggestions).length > 0 ? { suggestions } : {}), draft: false, id: e.id, hint: e.hint, refersTo: (e.attrs["refers to"] ?? [])[0] ?? null, attrs: e.attrs, english: e.target, kind: (kinds.includes(e.category as NameKind) ? e.category : "term") as NameKind, aliases: [...new Set([...e.aliases, ...nicknames])], gender: gender === "female" || gender === "male" ? gender : null, known: e.status === "confirmed" }];
      }
      // A word that is not in the knowledge base yet is a draft: it stays as the user left it. One that was in it and was deleted is gone.
      if (!n.draft) return [];
      const { id: _id, ...draft } = n;
      const gender = (draft.attrs?.["gender"] ?? [])[0];
      return [{ ...draft, refersTo: (draft.attrs?.["refers to"] ?? [])[0] ?? null, gender: gender === "female" || gender === "male" ? gender : null }];
    });
    for (const l of w.lines) {
      if (l.speaker && !w.words.some((n) => n.source === l.speaker)) l.speaker = null;
      if (l.suggested && !w.words.some((n) => n.source === l.suggested)) l.suggested = null;
    }
    return w;
  }

  private workChanged(): void {
    this.notify("state");
  }

  /** The words of the glossary, and the draft words of the work so far (still not in the knowledge base), as reading starts from them. */
  private knownWords(): KnownWord[] {
    const kinds: NameKind[] = ["character", "family", "place", "organization", "term"];
    const terms = this.knowledge.all().filter((e) => e.kind === "term");
    // A topic that refers to a person (山田 for 山田太郎) is one of that person's names, so the rules that look for who speaks or is spoken to see it.
    const nicknames = (e: KnowledgeEntry) => terms.filter((t) => t.id !== e.id && (t.attrs["refers to"] ?? []).some((r) => r === e.source)).map((t) => t.source);
    const known: KnownWord[] = terms.map((e) => ({ source: e.source, english: e.target, kind: (kinds.includes(e.category as NameKind) ? e.category : "term") as NameKind, aliases: [...new Set([...e.aliases, ...nicknames(e)])], gender: ((e.attrs["gender"] ?? [])[0] === "female" || (e.attrs["gender"] ?? [])[0] === "male" ? e.attrs["gender"]![0] : null) as "female" | "male" | null }));
    for (const n of this.work?.words ?? []) {
      if (n.draft && !known.some((g) => g.source === n.source)) known.push({ source: n.source, english: n.english, kind: n.kind, aliases: n.aliases, gender: n.gender ?? null, draft: true, ...(n.attrs ? { attrs: n.attrs } : {}), ...(n.hint ? { hint: n.hint } : {}), ...(n.use === false ? { use: false } : {}), ...(n.suggestions ? { suggestions: n.suggestions } : {}), ...(n.fromReading ? { fromReading: true } : {}) });
    }
    return known;
  }

  /** What was set or suggested for the lines of the work so far, for a text: a line keeps it when its words are the same and it is the same time they are said. */
  private carryLines(old: readonly WorkLine[], text: string): { confirmed: (string | null)[]; suggested: (string | null)[] } {
    const before = new Map<string, WorkLine>();
    const seen = new Map<string, number>();
    for (const l of old) {
      const n = seen.get(l.text) ?? 0;
      seen.set(l.text, n + 1);
      before.set(`${l.text}#${n}`, l);
    }
    const counted = new Map<string, number>();
    const found = findQuotes(text).map((q) => {
      const n = counted.get(q.text) ?? 0;
      counted.set(q.text, n + 1);
      return before.get(`${q.text}#${n}`);
    });
    return { confirmed: found.map((l) => l?.speaker ?? null), suggested: found.map((l) => l?.suggested ?? null) };
  }

  /**
   * Brings the work on a document up to date with its text: the paragraphs (one whose text is unchanged keeps its translation, the others
   * start again), the words found in it (what was set on a draft word stays) and who says each line (what was set stays).
   * Nothing changes when the text is the same.
   */
  async workSync(input: { documentId: string; text: string }): Promise<Work | null> {
    this.useDocument(input.documentId);
    const text = normalizeSource(input.text);
    if (text.trim() === "") return this.work ? this.workView() : null;
    if (this.work && this.work.source === text) return this.workView();
    const token = ++this.readings;
    const glossary = this.knownWords();
    // A word the user deleted from the glossary is not offered again.
    const rejected = new Set(this.knowledge.rejected().flatMap((e) => [e.source, ...e.aliases]));
    const candidates = (await findCandidateNames(text)).filter((c) => !rejected.has(c));
    const readings = await readNames([...new Set([...candidates, ...glossary.map((g) => g.source)])]);
    this.useDocument(input.documentId);
    if (token !== this.readings) return this.work ? this.workView() : null; // the text changed again while it was being read
    const old = this.work;
    const words = readWords({ text, candidates, readings, glossary });
    for (const w of words) if (old?.words.find((o) => o.source === w.source)?.use === false) w.use = false;
    // Given names found alone became aliases of a known person: keep that in the glossary too.
    for (const n of words.filter((x) => x.known && x.aliases.length > 0)) {
      const e = this.knowledge.all().find((t) => t.kind === "term" && t.source === n.source);
      if (e && n.aliases.some((a) => !e.aliases.includes(a))) this.knowledge.save({ id: e.id, kind: "term", source: e.source, target: e.target, hint: e.hint, category: e.category, aliases: [...new Set([...e.aliases, ...n.aliases])], attrs: e.attrs, text: "", about: null });
    }
    // What was suggested before (by the model, from the translation) is kept for a word and a line that are still there.
    for (const w of words) {
      const before = old?.words.find((o) => o.source === w.source)?.suggestions;
      if (before) w.suggestions = { ...(w.suggestions ?? {}), ...before };
    }
    const carried = this.carryLines(old?.lines ?? [], text);
    const lines = labelDocument(text, words, carried.confirmed);
    this.work = {
      documentId: input.documentId,
      source: text,
      words,
      lines: lines.map((l, i) => (l.speaker === null && carried.suggested[i] ? { ...l, suggested: carried.suggested[i]! } : l)),
      paragraphs: syncParagraphs(old?.paragraphs ?? [], text),
      error: null,
    };
    this.knowledgeChanged();
    this.workChanged();
    return this.workView();
  }

  private need(): Work {
    this.useDocument(this.activeDocId);
    if (!this.work) throw new UserError("no_text", "Paste some text first.");
    return this.work;
  }

  /** Says who says a line. A person picked from the knowledge base who is not written in the text joins its words, so the model gets their name and details. */
  workSetSpeaker(line: number, speaker: string | null): Work {
    const w = this.need();
    this.workView();
    if (!w.lines[line]) throw new UserError("no_line", "That line does not exist.");
    if (speaker && !w.words.some((n) => n.source === speaker)) {
      const entry = this.knowledge.all().find((t) => t.kind === "term" && t.source === speaker);
      if (!entry) throw new UserError("no_entry", "That person is not in the glossary.");
      w.words.push({ source: speaker, english: entry.target, kind: "character", aliases: [...entry.aliases], reading: "", known: entry.status === "confirmed", draft: false });
    }
    w.lines[line]!.speaker = speaker;
    if (speaker !== null) w.lines[line]!.suggested = null;
    this.workChanged();
    return this.workView();
  }

  /** Confirms the suggested speaker of a line. */
  workAcceptSpeaker(line: number): Work {
    const w = this.need();
    const l = w.lines[line];
    if (!l?.suggested) throw new UserError("no_suggestion", "There is nothing suggested for that line.");
    return this.workSetSpeaker(line, l.suggested);
  }

  /** Confirms a suggestion of a word (its English name, its gender, another attribute): it becomes the value, as if the user had written it. */
  workAcceptSuggestion(source: string, key: string): Work {
    const { name } = this.wordOf(source);
    const value = name.suggestions?.[key]?.[0];
    if (value === undefined) throw new UserError("no_suggestion", "There is nothing suggested for that.");
    if (key === "english") return this.workSetEnglish(source, value);
    return this.workSetAttribute(source, key, [value]);
  }

  /** Drops a suggestion of a word. */
  workDismissSuggestion(source: string, key: string): Work {
    const { name } = this.wordOf(source);
    this.dropSuggestion(name, key);
    this.workChanged();
    return this.workView();
  }

  private dropSuggestion(name: Word, key: string): void {
    if (!name.suggestions) return;
    delete name.suggestions[key];
    if (key === "english") delete name.fromReading;
    if (Object.keys(name.suggestions).length === 0) delete name.suggestions;
  }

  /** A word of the work: its topic when it has one, and the word as listed. */
  private wordOf(source: string): { name: Word; entry: KnowledgeEntry | undefined } {
    const w = this.need();
    this.workView();
    const name = w.words.find((n) => n.source === source);
    if (!name) throw new UserError("no_entry", "That word is not in the text any more.");
    return { name, entry: this.knowledge.all().find((t) => t.kind === "term" && t.source === source) };
  }

  /** What a value for an attribute must be, as the classes say. Throws a plain message when it is not. */
  private checkAttribute(kind: string, key: string, values: string[]): void {
    const drafts = this.work?.words.filter((n) => n.draft) ?? [];
    const def = parseClasses(this.classesText).classes.find((c) => c.name === kind)?.attributes.find((a) => a.key === key);
    if (!def) throw new UserError("bad_attribute", `${key} is not an attribute of this kind of topic.`);
    if (def.kind === "choice" && values.some((v) => !(def.choices ?? []).includes(v))) throw new UserError("bad_attribute", `${key} is one of: ${(def.choices ?? []).join(", ")}.`);
    const target = (def.kind === "link" || def.kind === "links") ? def.target : undefined;
    const isTopic = (v: string) => this.knowledge.all().some((t) => t.kind === "term" && t.source === v && (!target || t.category === target)) || drafts.some((n) => n.source === v && (!target || n.kind === target));
    if ((def.kind === "link" || def.kind === "links") && values.some((v) => !isTopic(v))) throw new UserError("bad_attribute", `${key} must be a topic of the kind ${def.target ?? "any"}.`);
    if (values.length > 1 && def.kind !== "links") throw new UserError("bad_attribute", `${key} takes one value.`);
  }

  /**
   * Sets one attribute of a word: a value from the list for a choice, a topic of the right class for a link, or text.
   * An empty list clears it. It goes to the knowledge base when the word is in it, and stays with the draft when it is not.
   */
  workSetAttribute(source: string, key: string, values: string[]): Work {
    const { name, entry } = this.wordOf(source);
    this.checkAttribute(entry?.category ?? name.kind, key, values);
    this.dropSuggestion(name, key);
    if (entry) {
      this.knowledge.patch(entry.id, (x) => {
        if (values.length === 0) delete x.attrs[key];
        else x.attrs[key] = values;
        return x;
      }, [key]);
      this.knowledgeChanged();
    } else {
      const attrs = { ...(name.attrs ?? {}) };
      if (values.length === 0) delete attrs[key];
      else attrs[key] = values;
      name.attrs = attrs;
    }
    this.workChanged();
    return this.workView();
  }

  /** The English name of a word, as the user writes it. */
  workSetEnglish(source: string, english: string): Work {
    const { name, entry } = this.wordOf(source);
    if (english.trim() !== "") this.dropSuggestion(name, "english");
    if (entry) {
      this.knowledge.patch(entry.id, (x) => {
        x.target = english.trim();
        return x;
      });
      this.knowledgeChanged();
    } else {
      name.english = english.trim();
    }
    this.workChanged();
    return this.workView();
  }

  /** The note to the model about a word: said next to the glossary line, with or without an English name. */
  workSetHint(source: string, hint: string): Work {
    const { name, entry } = this.wordOf(source);
    const text = hint.replace(/\s+/g, " ").trim();
    if (entry) {
      this.knowledge.patch(entry.id, (x) => {
        x.hint = text;
        return x;
      });
      this.knowledgeChanged();
    } else name.hint = text;
    this.workChanged();
    return this.workView();
  }

  /** Changes what kind of topic a word is. Attributes the new kind does not have are dropped. */
  workSetKind(source: string, kind: string): Work {
    const { name, entry } = this.wordOf(source);
    const target = parseClasses(this.classesText).classes.find((c) => c.name === kind);
    if (!target) throw new UserError("bad_kind", `There is no kind of topic called ${kind}.`);
    const wasName = (name.kind === "character" || name.kind === "family") && kind !== "character" && kind !== "family";
    // What a reading suggested as the name of a person means nothing for anything else.
    if (wasName) this.dropSuggestion(name, "english");
    if (entry) {
      this.knowledge.patch(entry.id, (x) => {
        // The English name of a suggested person or family was made from how the dictionary reads it, which means nothing for anything else.
        if (x.status === "suggested" && x.origin.by === "model" && wasName) x.target = "";
        x.category = kind;
        for (const k of Object.keys(x.attrs)) if (!target.attributes.some((a) => a.key === k)) delete x.attrs[k];
        x.attrFlags = x.attrFlags.filter((k) => k in x.attrs);
        return x;
      });
      this.knowledgeChanged();
    } else {
      name.kind = kind as NameKind;
      const attrs = { ...(name.attrs ?? {}) };
      for (const k of Object.keys(attrs)) if (!target.attributes.some((a) => a.key === k)) delete attrs[k];
      name.attrs = attrs;
    }
    this.workChanged();
    return this.workView();
  }

  /** Use or ignore a word. An ignored word is not sent and is not added to the knowledge base. */
  workSetUse(source: string, use: boolean): Work {
    const { name } = this.wordOf(source);
    if (use) delete name.use;
    else name.use = false;
    this.workChanged();
    return this.workView();
  }

  /** Adds a word from the text, as a draft unless the knowledge base has it. */
  async workAddWord(source: string): Promise<Work> {
    const w = this.need();
    const word = source.trim();
    if (word === "") throw new UserError("no_name", "Type the word as it is written in the text.");
    // Only a topic of that very word counts: a word that is an alias of another topic can have a translation of its own.
    const existing = this.knowledge.all().find((e) => e.kind === "term" && e.source === word);
    if (!w.words.some((n) => n.source === word)) {
      if (existing) w.words.push({ source: word, english: existing.target, kind: "term", aliases: [], reading: "", known: existing.status === "confirmed", draft: false });
      else {
        const readings = await readNames([word]);
        const guess = nameGuess(word, readings[word]);
        // A word that is already another way to write a person's name stands for that person.
        const owner = this.knowledge.all().find((e) => e.kind === "term" && e.category === "character" && e.aliases.includes(word));
        // A word the user adds is a term, unless it ends like a family, a place or an organization. People are found by the dictionary;
        // one it missed is changed to a person from the row. A word that stands for a person is a term as well.
        const asTerm = owner !== undefined || guess.kind === "character";
        w.words.push({ source: word, english: asTerm ? "" : guess.english, kind: asTerm ? "term" : guess.kind, aliases: [], reading: guess.reading, known: false, draft: true, attrs: owner ? { "refers to": [owner.source] } : {} });
      }
    }
    this.workChanged();
    return this.workView();
  }

  /** The words the user is using enter the knowledge base: drafts are added, and suggestions are accepted. Ignored words do nothing. */
  private commitWords(words: Word[]): void {
    const at = new Date().toISOString();
    for (const n of words) {
      if (n.use === false) continue;
      const entry = this.knowledge.all().find((t) => t.kind === "term" && t.source === n.source);
      if (entry) {
        if (entry.status !== "confirmed") this.knowledge.confirm([entry.id]);
        continue;
      }
      this.knowledge.addMany([
        { id: newId(), kind: "term", source: n.source, target: n.english.trim(), hint: n.hint ?? "", category: n.kind, aliases: n.aliases, attrs: n.attrs ?? {}, attrFlags: [], text: "", about: null, related: [], scope: null, origin: { by: "user" }, status: "confirmed", updatedAt: at },
      ]);
      n.draft = false;
    }
    this.knowledgeChanged();
  }

  /** The user's own text for the translation of one paragraph. */
  workSetPart(paragraph: number, text: string): Work {
    const w = this.need();
    if (!w.paragraphs[paragraph]) throw new UserError("no_paragraph", "That paragraph does not exist.");
    w.paragraphs[paragraph]!.translation = text.trim();
    w.paragraphs[paragraph]!.issue = null;
    this.workChanged();
    return this.workView();
  }

  /** The translation style the model's settings name, filled in with the languages. */
  private styleOf(input: ModelInput): { text: string } {
    const style = allPrompts((this.settings?.prompts ?? []).filter((p) => validatePrompt(p) === null)).find((p) => p.id === input.promptId) ?? STANDARD_PROMPT;
    return { text: renderPrompt(style, input.sourceLanguage, input.targetLanguage) };
  }

  /**
   * Translates one paragraph. The model gets what applies to the paragraph (its glossary words, notes and who says its lines), the
   * paragraphs around it as far as the context has room (the ones before with their translations, the ones after so that it knows where
   * the story goes), and the paragraph. The answer is checked: if it leaves out a glossary name of the paragraph, gives back the text that was
   * rejected, or is several paragraphs, the model is asked once more.
   */
  private async translateParagraph(input: ModelInput, k: number, system: string, abort: AbortController, old?: string): Promise<{ text: string; issue: string | null } | null> {
    const w = this.work!;
    const paragraph = w.paragraphs[k]!.text;
    const glossary = glossaryFor(w.words, paragraph);
    const notes = notesFor(w.words, w.lines, { index: k, text: paragraph });
    const suggestions = suggestionsFor(w.words, paragraph);
    const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
    let reject: string | undefined;
    let complaint = "";
    let text = "";
    let issue: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const bare = { glossary, notes, suggestions, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, paragraph, rejected: reject };
      let left = input.contextLimit - estimateTokens(system) - estimateTokens(paragraphMessage({ ...bare, before: [], next: [] }) + complaint) - input.maxOutputTokens - DEFAULTS.messageOverheadTokens;
      if (left < 0) throw new UserError("context_overflow", `Paragraph ${k + 1} needs about ${input.contextLimit - left - input.maxOutputTokens} tokens plus ${input.maxOutputTokens} for the reply, but the context of ${input.modelId} is set to ${input.contextLimit}. Raise the context size.`);
      // As much context as fits, nearest first, one before and one after in turn: the translated paragraphs before, and the ones after.
      const before: Pair[] = [];
      const next: { source: string; translation: string | null }[] = [];
      let b = k - 1;
      let a = k + 1;
      for (let turn = 0; (b >= 0 || a < w.paragraphs.length) && left > 0; turn++) {
        if (turn % 2 === 0 && b >= 0) {
          const p = w.paragraphs[b--]!;
          if (p.translation.trim() === "") continue;
          const cost = estimateTokens(p.text) + estimateTokens(p.translation) + 8;
          if (cost > left) break;
          left -= cost;
          before.unshift({ source: p.text, translation: p.translation.trim() });
        } else if (a < w.paragraphs.length) {
          const p = w.paragraphs[a++]!;
          const cost = estimateTokens(p.text) + estimateTokens(p.translation) + 8;
          if (cost > left) break;
          left -= cost;
          next.push({ source: p.text, translation: p.translation.trim() || null });
        }
      }
      const user = paragraphMessage({ ...bare, before, next }) + complaint;
      const reply = await this.askModel(
        {
          backend: input.backend,
          modelId: input.modelId,
          maxOutputTokens: input.maxOutputTokens,
          temperature: input.temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          practiceReply: () => [`Practice translation of paragraph ${k + 1}.`, ...glossary.map((g) => targetVariants(g.target)[0]).filter((t): t is string => !!t)].join(" "),
        },
        abort,
      );
      if (reply === null) return null; // stopped
      const answer = answerOf(reply, input.targetLanguage);
      if (answer === null) throw new UserError("invalid_response", `The model wrote nothing for paragraph ${k + 1}. If it is a thinking model, raise its reply limit.`);
      // A paragraph of the source is one line, so its translation is one line: several mean the model wrote about more than the paragraph.
      const lines = answer.split(/\n+/).filter((l) => l.trim() !== "");
      text = lines.join(" ");
      const several = lines.length > 1;
      const missing = missingNames(glossary, paragraph, text);
      const unchanged = old !== undefined && sameText(text, old);
      issue = missing.length > 0 ? `Paragraph ${k + 1} does not use the glossary names: ${missing.join("; ")}.` : unchanged ? `Paragraph ${k + 1}: the model wrote the same text again.` : several ? `Paragraph ${k + 1}: the model wrote several paragraphs, which were joined.` : null;
      if (issue === null) break;
      if (unchanged) reject = old;
      complaint = [
        several ? "Your last answer was not accepted because it was several paragraphs. Translate only the paragraph above, as one paragraph." : "",
        missing.length > 0 ? `Your last answer was not accepted because it does not use these exact names: ${missing.join("; ")}. Translate again and use them exactly as written.` : "",
      ]
        .filter((x) => x !== "")
        .map((x) => `\n\n${x}`)
        .join("");
    }
    return { text, issue };
  }

  /**
   * Reads the translation for suggestions, with short questions to the model that each have one answer that can be checked in code:
   * how each word was written in the translation (words copied from it), what gender a person is (a letter, checked against the
   * pronouns), other attributes with a list of choices (a letter), and who says each line (a letter from the people nearby).
   * An answer that does not pass its check is thrown away. Nothing is confirmed: a suggestion becomes a value only when the user accepts it.
   */
  async workSuggest(input: ModelInput): Promise<Work> {
    const w = this.need();
    this.workView();
    const abort = this.beginSideRequest();
    const classes = parseClasses(this.classesText).classes;
    const sources = w.words.map((n) => n.source);
    const namesOf = (n: Word) => [n.source, ...n.aliases];
    const translated = (k: number) => w.paragraphs[k]!.translation.trim() !== "";
    // The paragraphs a word stands in, that have a translation: the first three are the evidence.
    const evidenceFor = (n: Word): { at: number; pair: Evidence }[] =>
      w.paragraphs.flatMap((p, k) => (translated(k) && occurrencesOf(p.text, namesOf(n), sources).length > 0 ? [{ at: k, pair: { source: p.text, translation: p.translation.trim() } }] : [])).slice(0, 3);
    const label = (n: Word) => n.english.trim() || n.suggestions?.["english"]?.[0] || n.source;
    type Task = { count: number; run: () => Promise<void> };
    const tasks: Task[] = [];
    const ask = async (q: { system: string; user: string }): Promise<string | null> => {
      // As many of the paragraphs as fit: a question that does not fit the context is skipped.
      if (estimateTokens(q.system) + estimateTokens(q.user) + 32 + DEFAULTS.messageOverheadTokens > input.contextLimit) return null;
      const reply = await this.askModel({ backend: input.backend, modelId: input.modelId, maxOutputTokens: 32, temperature: 0, messages: [{ role: "system", content: q.system }, { role: "user", content: q.user }], practiceReply: () => "NONE", allowEmpty: true }, abort);
      return reply === null ? null : reply.trim();
    };

    // How each word was written in the translation.
    for (const n of w.words) {
      if (n.use === false || n.english.trim() !== "") continue;
      const ev = evidenceFor(n);
      if (ev.length === 0) continue;
      tasks.push({
        count: 1,
        run: async () => {
          const reply = await ask(nameQuestion(n.source, ev.map((e) => e.pair), input.sourceLanguage, input.targetLanguage));
          const copied = reply === null ? null : copiedWords(reply, ev.map((e) => e.pair.translation));
          if (copied) {
            n.suggestions = { ...(n.suggestions ?? {}), english: [copied] };
            delete n.fromReading; // now it is how the name was written, not how it sounds
          }
        },
      });
    }
    // The gender of a person, and the other attributes that are chosen from a list.
    for (const n of w.words) {
      if (n.use === false) continue;
      const ev = evidenceFor(n);
      if (ev.length === 0) continue;
      for (const def of classes.find((c) => c.name === n.kind)?.attributes ?? []) {
        if (def.kind !== "choice" || !def.choices || (n.attrs?.[def.key] ?? []).length > 0 || n.suggestions?.[def.key]) continue;
        const options = def.key === "gender" ? def.choices.filter((c) => c === "male" || c === "female") : def.choices;
        if (options.length === 0) continue;
        tasks.push({
          count: 1,
          run: async () => {
            const reply = await ask(choiceQuestion(`According to the text, what is the ${def.key} of 「${n.source}」${label(n) !== n.source ? ` (${label(n)})` : ""}?`, options, ev.map((e) => e.pair), input.sourceLanguage, input.targetLanguage));
            const at = reply === null ? null : chosenOption(reply, options);
            if (at === null) return;
            const value = options[at]!;
            // The pronouns of the translation must not say otherwise.
            if (def.key === "gender") {
              const by = pronounGender(ev.map((e) => e.pair.translation));
              if (by !== null && by !== value) return;
            }
            n.suggestions = { ...(n.suggestions ?? {}), [def.key]: [value] };
          },
        });
      }
    }
    // Who says each line that the user has not set: one of the people written in the paragraphs around it.
    const people = w.words.filter((n) => n.kind === "character" && n.use !== false);
    w.lines.forEach((l) => {
      if (l.speaker !== null || !translated(l.paragraph)) return;
      const near = people
        .map((n) => ({ n, distance: Math.min(...[l.paragraph - 2, l.paragraph - 1, l.paragraph, l.paragraph + 1].filter((k) => w.paragraphs[k] && occurrencesOf(w.paragraphs[k]!.text, namesOf(n), sources).length > 0).map((k) => Math.abs(k - l.paragraph)), Infinity) }))
        .filter((x) => x.distance !== Infinity)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 6)
        .map((x) => x.n);
      if (near.length === 0) return;
      const context = [l.paragraph - 1, l.paragraph].filter((k) => k >= 0 && translated(k)).map((k) => w.paragraphs[k]!.translation.trim());
      tasks.push({
        count: 1,
        run: async () => {
          const reply = await ask(speakerQuestion(l.text, near.map(label), context, input.sourceLanguage, input.targetLanguage));
          const at = reply === null ? null : chosenOption(reply, near.map(label));
          if (at === null) return;
          // A person named in the line as spoken to does not say it.
          const spokenTo = addressedIn(l.text, near.map((n) => ({ id: n.source, label: label(n), names: namesOf(n) })));
          if (!spokenTo.has(near[at]!.source)) l.suggested = near[at]!.source;
        },
      });
    });

    try {
      w.reading = { done: 0, total: tasks.length };
      this.workChanged();
      for (const task of tasks) {
        await task.run();
        if (abort.signal.aborted) break; // stopped: what was found so far stays
        w.reading = { done: w.reading.done + task.count, total: tasks.length };
        this.workChanged();
      }
    } catch (e) {
      w.error = e instanceof UserError ? e.message : "Reading the translation failed.";
      throw e;
    } finally {
      w.reading = null;
      this.analysisAbort = null;
      this.workChanged();
    }
    return this.workView();
  }

  /**
   * Translates the paragraphs one after the other, each with what the user confirmed, saving each as it is done so that the paragraphs written
   * so far show while the rest are being written, and so that stopping keeps them. Without `redo` the paragraphs that have a translation are skipped,
   * so translating again carries on where it stopped; with `redo` the ones from `from` on are written again.
   */
  async workTranslate(input: ModelInput & { from?: number; redo?: boolean }): Promise<Work> {
    const w = this.need();
    this.workView();
    const abort = this.beginSideRequest();
    try {
      this.commitWords(w.words);
      this.workView();
      const system = paragraphSystem(this.styleOf(input).text, input.sourceLanguage, input.targetLanguage);
      const start = Math.max(0, input.from ?? 0);
      w.error = null;
      if (input.redo) for (let k = start; k < w.paragraphs.length; k++) w.paragraphs[k] = { text: w.paragraphs[k]!.text, translation: "" };
      this.workChanged();
      for (let k = start; k < w.paragraphs.length; k++) {
        if (w.paragraphs[k]!.translation.trim() !== "") continue;
        const done = await this.translateParagraph(input, k, system, abort);
        if (done === null) break; // stopped: what is written so far stays
        w.paragraphs[k] = { text: w.paragraphs[k]!.text, translation: done.text, issue: done.issue };
        this.workChanged();
      }
    } catch (e) {
      w.error = e instanceof UserError ? e.message : "The translation failed.";
      this.workChanged();
      throw e;
    } finally {
      this.analysisAbort = null;
    }
    return this.workView();
  }

  /** Translates one paragraph again, keeping the others as they are. The old text is not shown to the model unless it is given back. */
  async workRetranslate(input: ModelInput & { paragraph: number }): Promise<Work> {
    const w = this.need();
    this.workView();
    if (!w.paragraphs[input.paragraph]) throw new UserError("no_paragraph", "That paragraph does not exist.");
    const abort = this.beginSideRequest();
    try {
      this.commitWords(w.words);
      this.workView();
      const system = paragraphSystem(this.styleOf(input).text, input.sourceLanguage, input.targetLanguage);
      const old = w.paragraphs[input.paragraph]!.translation;
      const done = await this.translateParagraph(input, input.paragraph, system, abort, old.trim() === "" ? undefined : old);
      if (done === null) return this.workView();
      w.paragraphs[input.paragraph] = { text: w.paragraphs[input.paragraph]!.text, translation: done.text, issue: done.issue };
      w.error = null;
      this.workChanged();
    } finally {
      this.analysisAbort = null;
    }
    return this.workView();
  }

  // ---- suggested notes ----

  private analysisAbort: AbortController | null = null;

  /** Only one request to a model at a time (the model server handles one thing at a time). */
  private beginSideRequest(): AbortController {
    if (this.analysisAbort) throw new UserError("busy", "Already working on the text.");
    const abort = new AbortController();
    this.analysisAbort = abort;
    return abort;
  }

  /** One request to a model, answered in full. Returns null if the user stopped it. */
  private async askModel(
    ask: { backend: Backend; modelId: string; maxOutputTokens: number; messages: { role: "system" | "user"; content: string }[]; practiceReply: () => string; temperature?: number; allowEmpty?: boolean },
    abort: AbortController,
  ): Promise<string | null> {
    let reply = "";
    if (ask.backend === "practice") {
      await new Promise((r) => setTimeout(r, this.options.speedMs ?? 150));
      reply = ask.practiceReply();
    } else {
      const provider = this.options.provider;
      if (!provider) throw new UserError("no_provider", "No model server connection is set up.");
      const stream = provider.adapter().generate(
        provider.config(),
        { requestId: newId(), modelId: ask.modelId, messages: ask.messages, temperature: ask.temperature ?? 0.2, maxOutputTokens: ask.maxOutputTokens, stream: true },
        abort.signal,
      );
      const it = stream[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await it.next();
          if (next.done) break;
          const ev = next.value;
          if (ev.type === "delta") reply += ev.text;
          else if (ev.type === "error") {
            if (abort.signal.aborted) break;
            throw new UserError(ev.error.code, ev.error.message);
          } else break;
        }
      } catch (e) {
        if (!abort.signal.aborted) throw e;
      } finally {
        void it.return?.(undefined).catch(() => {});
      }
    }
    if (abort.signal.aborted) return null;
    reply = stripThinking(reply);
    if (reply.trim() === "" && !ask.allowEmpty) throw new UserError("invalid_response", "The model returned no text. If it is a thinking model, raise its reply limit.");
    return reply;
  }

  // ---- choosing the background for each block ----

  cancelAnalysis(): { canceled: boolean } {
    const was = this.analysisAbort !== null;
    this.analysisAbort?.abort();
    return { canceled: was };
  }

}

