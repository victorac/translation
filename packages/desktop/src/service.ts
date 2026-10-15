import {
  allPrompts,
  glossaryFor,
  glossaryHits,
  labelLines,
  type Carry,
  nameGuess,
  interpretPassage,
  lastLines,
  notesFor,
  STANDARD_PROMPT,
  type GuidedName,
  type GuidedState,
  type GuidedModelInput,
  type GuidedStartInput,
  type Interpretation,
  type KnownName,
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
  BLOCK_SIZES,
  chunkSource,
  DEFAULTS,
  estimateTokens,
  newId,
  normalizeSource,
  renderPrompt,
  stripThinking,
  paragraphSystem,
  paragraphMessage,
  answerOf,
  missingNames,
  joinParts,
  paragraphsOf,
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
      blockSize: input.blockSize,
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
    this.guidedByDoc.delete(documentId);
    if (this.guided?.documentId === documentId) this.guided = null;
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
  exportProject(): { documents: ProjectDocument[]; activeDocumentId: string; settings: ProjectSettings | null; knowledge: { entries: KnowledgeEntry[]; classes: string }; guided: GuidedState[] } {
    return {
      documents: this.docs.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, draft: d.draft })),
      activeDocumentId: this.activeDocId,
      settings: this.settings ? structuredClone(this.settings) : null,
      knowledge: { entries: this.knowledge.everything(), classes: this.classesText },
      guided: [...this.guidedByDoc.values(), ...(this.guided ? [this.guided] : [])].map((g) => structuredClone(g)),
    };
  }

  /** Replaces the open workspace with a saved project (already checked and settled by the caller). */
  restore(project: { documents: ProjectDocument[]; activeDocumentId: string; guided?: GuidedState[] | undefined; settings?: ProjectSettings | undefined; knowledge?: { entries: KnowledgeEntry[]; classes?: string | undefined } | undefined }): void {
    if (this.busy) throw new UserError("busy", "Stop what the model is doing first.");
    this.clear();
    this.docs = project.documents.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, draft: d.draft }));
    this.activeDocId = this.docs.some((d) => d.id === project.activeDocumentId) ? project.activeDocumentId : this.docs[0]!.id;
    this.settings = project.settings ? structuredClone(project.settings) : null;
    this.guided = null;
    this.guidedByDoc = new Map((project.guided ?? []).map((g) => [g.documentId, structuredClone(g)] as const));
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
    this.guided = null;
    this.guidedByDoc.clear();
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

  /** The left rail's list: each document with how far its translation has got (blocks translated, of all its blocks). */
  private documentViews(): DocumentView[] {
    return this.docs.map((d) => {
      const work = this.guided?.documentId === d.id ? this.guided : this.guidedByDoc.get(d.id);
      return { id: d.id, title: d.title, done: work?.blocks.filter((b) => b.status === "translated").length ?? 0, total: work?.blocks.length ?? 0, hasText: d.draft.trim() !== "" };
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

  // ---- step by step translation ----

  /** The block work of the open document. The other documents' work is kept beside it and comes back when they are opened. */
  private guided: GuidedState | null = null;
  private guidedByDoc = new Map<string, GuidedState>();

  /** Makes the block work of this document the one being worked on. */
  private useDocument(documentId: string): void {
    if (this.guided && this.guided.documentId === documentId) return;
    if (this.guided) this.guidedByDoc.set(this.guided.documentId, this.guided);
    this.guided = this.guidedByDoc.get(documentId) ?? null;
    this.guidedByDoc.delete(documentId);
  }

  guidedGet(): GuidedState | null {
    this.useDocument(this.activeDocId);
    return this.guided ? this.guidedView() : null;
  }

  /**
   * The state with every block's names taken from the glossary as it is now, so a topic edited or deleted in the knowledge pane
   * shows right away: its English form, kind, aliases and gender. A name whose topic is gone is no longer listed.
   */
  private guidedView(): GuidedState {
    const g = this.guided!;
    const terms = this.knowledge.all().filter((e) => e.kind === "term");
    for (const b of g.blocks) {
      this.fitParts(b);
      if (!b.interpretation) continue;
      // Every word of the glossary that stands in the block is listed, including ones added to the glossary after the block was read.
      for (const e of glossaryHits(b.text, terms)) {
        if (!b.interpretation.names.some((n) => n.source === e.source)) b.interpretation.names.push({ source: e.source, english: e.target, kind: "term", aliases: [], reading: "", known: e.status === "confirmed", draft: false });
      }
      const kinds: NameKind[] = ["character", "family", "place", "organization", "term"];
      b.interpretation.names = b.interpretation.names.flatMap((n) => {
        const e = terms.find((t) => t.source === n.source);
        if (e) {
          const gender = (e.attrs["gender"] ?? [])[0];
          const nicknames = terms.filter((t) => t.id !== e.id && (t.attrs["refers to"] ?? []).includes(e.source)).map((t) => t.source);
          return [{ ...n, draft: false, id: e.id, hint: e.hint, refersTo: (e.attrs["refers to"] ?? [])[0] ?? null, attrs: e.attrs, english: e.target, kind: (kinds.includes(e.category as NameKind) ? e.category : "term") as NameKind, aliases: [...new Set([...e.aliases, ...nicknames])], gender: gender === "female" || gender === "male" ? gender : null, known: e.status === "confirmed" }];
        }
        // A word that is not in the knowledge base yet is a draft: it stays as the user left it. One that was in it and was deleted is gone.
        if (!n.draft) return [];
        const { id: _id, ...draft } = n;
        const gender = (draft.attrs?.["gender"] ?? [])[0];
        return [{ ...draft, refersTo: (draft.attrs?.["refers to"] ?? [])[0] ?? null, gender: gender === "female" || gender === "male" ? gender : null }];
      });
      const narratorEntry = b.interpretation.narrator ? terms.find((t) => t.source === b.interpretation!.narrator) : undefined;
      if (narratorEntry && narratorEntry.category !== "character") b.interpretation.narrator = null;
      if (b.interpretation.narrator && !b.interpretation.names.some((n) => n.source === b.interpretation!.narrator) && b.interpretation.narratorWord) {
        const e = terms.find((t) => t.source === b.interpretation!.narrator);
        if (!e) b.interpretation.narrator = null;
      }
    }
    return g;
  }

  /**
   * A block's translation is kept paragraph by paragraph: one entry for each paragraph of its source. A block saved as one piece of
   * text (before this) has its paragraphs matched up when their number is the same, and otherwise the whole text is kept in the first.
   */
  private fitParts(b: GuidedState["blocks"][number]): void {
    const n = paragraphsOf(b.text).length;
    if (b.parts.length === n) return;
    const old = b.parts.length === 0 && b.translation.trim() !== "" ? paragraphsOf(b.translation).map((p) => p.text) : b.parts;
    b.parts = Array.from({ length: n }, (_, i) => (old.length === n ? old[i]! : i === 0 ? joinParts(old) : ""));
  }

  private guidedBlock(index: number) {
    const block = this.guided?.blocks[index];
    if (!this.guided || !block) throw new UserError("no_block", "That block does not exist. Start again from the text.");
    return block;
  }

  private guidedChanged(): void {
    this.notify("state");
  }

  /** Splits the text into blocks to go through one at a time. */
  guidedStart(input: GuidedStartInput): GuidedState {
    const text = normalizeSource(input.text);
    if (text.trim() === "") throw new UserError("no_text", "Paste some text first.");
    const limits = BLOCK_SIZES[input.blockSize] ?? BLOCK_SIZES.normal;
    const chunks = chunkSource(text, { targetTokens: limits.targetTokens, maxTokens: limits.maxTokens });
    this.guided = {
      documentId: input.documentId,
      source: text,
      current: 0,
      blocks: chunks.map((c, index) => ({ index, text: text.slice(c.startOffset, c.endOffset), interpretation: null, translation: "", parts: [], status: "new" as const, error: null })),
    };
    this.guidedChanged();
    return this.guidedView();
  }

  /**
   * Makes the blocks from the text in the editor, or brings them up to date with it. Nothing changes when the text is the same. When it is not, the text is
   * split again and a block whose text is unchanged keeps what was read, set and translated; the others start again.
   */
  guidedSync(input: GuidedStartInput): GuidedState | null {
    this.useDocument(input.documentId);
    const text = normalizeSource(input.text);
    if (text.trim() === "") return this.guided ? this.guidedView() : null;
    if (!this.guided) return this.guidedStart(input);
    if (this.guided.source === text) return this.guidedView();
    const old = this.guided;
    const limits = BLOCK_SIZES[input.blockSize] ?? BLOCK_SIZES.normal;
    const chunks = chunkSource(text, { targetTokens: limits.targetTokens, maxTokens: limits.maxTokens });
    const kept = new Map(old.blocks.map((b) => [b.text, b]));
    const blocks = chunks.map((c, index) => {
      const body = text.slice(c.startOffset, c.endOffset);
      const same = kept.get(body);
      return same ? { ...same, index } : { index, text: body, interpretation: null, translation: "", parts: [], status: "new" as const, error: null };
    });
    const here = old.blocks[old.current]?.text;
    this.guided = { documentId: old.documentId, source: text, current: Math.max(0, blocks.findIndex((b) => b.text === here)), blocks };
    this.guidedChanged();
    return this.guidedView();
  }

  /** Reads every block that has not been read yet, in order, so the glossary holds the words of the whole text. */
  async guidedReadAll(): Promise<GuidedState> {
    const g = this.guided;
    if (!g) throw new UserError("no_block", "Start from the text first.");
    const was = g.current;
    for (const b of [...g.blocks]) if (!b.interpretation) await this.guidedInterpret(b.index);
    g.current = was;
    this.guidedChanged();
    return this.guidedView();
  }

  guidedGo(index: number): GuidedState {
    this.guidedBlock(index);
    this.guided!.current = index;
    this.guidedChanged();
    return this.guided!;
  }

  guidedClear(): null {
    this.guided = null;
    this.guidedByDoc.clear();
    this.guidedChanged();
    return null;
  }

  /** The names in the glossary, in the form the reading of a block starts from. */
  private knownNames(): KnownName[] {
    const kinds: NameKind[] = ["character", "family", "place", "organization", "term"];
    const terms = this.knowledge.all().filter((e) => e.kind === "term");
    // A topic that refers to a person (山田 for 山田太郎) is one of that person's names, so the rules that look for who speaks or is spoken to see it.
    const nicknames = (e: KnowledgeEntry) => terms.filter((t) => t.id !== e.id && (t.attrs["refers to"] ?? []).some((r) => r === e.source)).map((t) => t.source);
    return terms
      .map((e) => ({ source: e.source, english: e.target, kind: (kinds.includes(e.category as NameKind) ? e.category : "term") as NameKind, aliases: [...new Set([...e.aliases, ...nicknames(e)])], gender: ((e.attrs["gender"] ?? [])[0] === "female" || (e.attrs["gender"] ?? [])[0] === "male" ? e.attrs["gender"]![0] : null) as "female" | "male" | null }));
  }

  /** The conversation going on where the block before ended: who said its last line, and who they were talking with. */
  private carryFor(index: number): Carry | null {
    const prev = this.guided!.blocks[index - 1];
    const lines = prev?.interpretation?.lines ?? [];
    const lastParagraph = (prev?.text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "").at(-1) ?? "";
    const last = lines.at(-1);
    // Only when that block ended on a line of speech whose speaker is known.
    if (!prev || !lastParagraph.trim().startsWith("「") || !last?.speaker) return null;
    const other = [...lines].reverse().find((l) => l.speaker && l.speaker !== last.speaker)?.speaker ?? null;
    return { before: last.speaker, other };
  }

  /** Reads one block: who is named, who is telling it, who says each line. Words that are not in the knowledge base are drafts, added when they are used. */
  async guidedInterpret(index: number): Promise<GuidedState> {
    const block = this.guidedBlock(index);
    // The glossary, and the draft words of the blocks before this one (still not in the knowledge base), so that the narrator and a
    // conversation can carry on across blocks and what the user fixed on a draft is not lost.
    const glossary = this.knownNames();
    for (const b of this.guided!.blocks.slice(0, index)) {
      for (const n of b.interpretation?.names ?? []) {
        if (n.draft && n.use !== false && !glossary.some((g) => g.source === n.source)) glossary.push({ source: n.source, english: n.english, kind: n.kind, aliases: n.aliases, gender: n.gender ?? null, draft: true, ...(n.attrs ? { attrs: n.attrs } : {}) });
      }
    }
    // A name the user deleted from the glossary is not offered again.
    const rejected = new Set(this.knowledge.rejected().flatMap((e) => [e.source, ...e.aliases]));
    const candidates = (await findCandidateNames(block.text)).filter((c) => !rejected.has(c));
    const readings = await readNames([...new Set([...candidates, ...glossary.map((g) => g.source)])]);
    // The narrator carries on from the nearest block read before this one.
    const earlier = this.guided!.blocks.slice(0, index).reverse().find((b) => b.interpretation);
    const found = interpretPassage({ passage: block.text, candidates, readings, glossary, narrator: earlier?.interpretation?.narrator ?? null, carry: this.carryFor(index) });
    // Given names found alone became aliases of a known person: keep that in the glossary too.
    for (const n of found.names.filter((x) => x.known && x.aliases.length > 0)) {
      const e = this.knowledge.all().find((t) => t.kind === "term" && t.source === n.source);
      if (e && n.aliases.some((a) => !e.aliases.includes(a))) this.knowledge.save({ id: e.id, kind: "term", source: e.source, target: e.target, hint: e.hint, category: e.category, aliases: [...new Set([...e.aliases, ...n.aliases])], attrs: e.attrs, text: "", about: null });
    }
    block.interpretation = found;
    if (block.status === "new") block.status = "interpreted";
    this.guided!.current = index;
    this.knowledgeChanged();
    this.guidedChanged();
    return this.guidedView();
  }

  /**
   * The narrator and who says each line, as the user set them. The names are the glossary's. With `fill`, lines whose speaker is
   * not known yet are worked out from the names, the narrator and the conversation carried on from the block before.
   */
  guidedSave(index: number, narrator: string | null, speakers: (string | null)[], fill = false): GuidedState {
    const block = this.guidedBlock(index);
    this.guidedView();
    const interp = block.interpretation;
    if (interp) {
      // A person the user picks from the knowledge base who is not written in this block joins its glossary, so the model gets their name and details.
      for (const who of [narrator, ...speakers]) {
        if (!who || interp.names.some((n) => n.source === who)) continue;
        const entry = this.knowledge.all().find((t) => t.kind === "term" && t.source === who);
        if (entry) interp.names.push({ source: who, english: entry.target, kind: "character", aliases: [...entry.aliases], reading: "", known: entry.status === "confirmed", draft: false });
      }
      interp.narrator = narrator;
      const fresh = fill ? labelLines(block.text, interp.names, narrator, interp.narratorWord, this.carryFor(index), speakers) : [];
      interp.lines = interp.lines.map((l, i) => ({ ...l, speaker: speakers[i] ?? (fill && fresh[i]?.text === l.text ? (fresh[i]?.speaker ?? null) : null) }));
    }
    this.guidedChanged();
    return this.guidedView();
  }

  /** A word of the block being worked on: its topic when it has one, and the name as listed in the block. */
  private wordOf(source: string): { name: GuidedName; entry: KnowledgeEntry | undefined } {
    this.guidedView();
    const block = this.guided?.blocks[this.guided.current];
    const name = block?.interpretation?.names.find((n) => n.source === source);
    if (!name) throw new UserError("no_entry", "That word is not in this block any more.");
    return { name, entry: this.knowledge.all().find((t) => t.kind === "term" && t.source === source) };
  }

  /** What a value for an attribute must be, as the classes say. Throws a plain message when it is not. */
  private checkAttribute(kind: string, key: string, values: string[]): void {
    const draftsHere = this.guided?.blocks[this.guided.current]?.interpretation?.names.filter((n) => n.draft) ?? [];
    const def = parseClasses(this.classesText).classes.find((c) => c.name === kind)?.attributes.find((a) => a.key === key);
    if (!def) throw new UserError("bad_attribute", `${key} is not an attribute of this kind of topic.`);
    if (def.kind === "choice" && values.some((v) => !(def.choices ?? []).includes(v))) throw new UserError("bad_attribute", `${key} is one of: ${(def.choices ?? []).join(", ")}.`);
    const target = (def.kind === "link" || def.kind === "links") ? def.target : undefined;
    const isTopic = (v: string) => this.knowledge.all().some((t) => t.kind === "term" && t.source === v && (!target || t.category === target)) || draftsHere.some((n) => n.source === v && (!target || n.kind === target));
    if ((def.kind === "link" || def.kind === "links") && values.some((v) => !isTopic(v))) throw new UserError("bad_attribute", `${key} must be a topic of the kind ${def.target ?? "any"}.`);
    if (values.length > 1 && def.kind !== "links") throw new UserError("bad_attribute", `${key} takes one value.`);
  }

  /**
   * Sets one attribute of a word of the block: a value from the list for a choice, a topic of the right class for a link, or text.
   * An empty list clears it. It goes to the knowledge base when the word is in it, and stays with the block's draft when it is not.
   */
  guidedSetAttribute(source: string, key: string, values: string[]): GuidedState {
    const { name, entry } = this.wordOf(source);
    this.checkAttribute(entry?.category ?? name.kind, key, values);
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
    this.guidedChanged();
    return this.guidedView();
  }

  /** The English name of a word, as the user writes it. */
  guidedSetEnglish(source: string, english: string): GuidedState {
    const { name, entry } = this.wordOf(source);
    if (entry) {
      this.knowledge.patch(entry.id, (x) => {
        x.target = english.trim();
        return x;
      });
      this.knowledgeChanged();
    } else {
      name.english = english.trim();
      delete name.guessed;
    }
    this.guidedChanged();
    return this.guidedView();
  }

  /** The note to the model about a word: said next to the glossary line, with or without an English name. */
  guidedSetHint(source: string, hint: string): GuidedState {
    const { name, entry } = this.wordOf(source);
    const text = hint.replace(/\s+/g, " ").trim();
    if (entry) {
      this.knowledge.patch(entry.id, (x) => {
        x.hint = text;
        return x;
      });
      this.knowledgeChanged();
    } else name.hint = text;
    this.guidedChanged();
    return this.guidedView();
  }

  /** Changes what kind of topic a word is. Attributes the new kind does not have are dropped. */
  guidedSetKind(source: string, kind: string): GuidedState {
    const { name, entry } = this.wordOf(source);
    const target = parseClasses(this.classesText).classes.find((c) => c.name === kind);
    if (!target) throw new UserError("bad_kind", `There is no kind of topic called ${kind}.`);
    const wasName = (name.kind === "character" || name.kind === "family") && kind !== "character" && kind !== "family";
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
      if (wasName && name.guessed) {
        name.english = "";
        delete name.guessed;
      }
      name.kind = kind as NameKind;
      const attrs = { ...(name.attrs ?? {}) };
      for (const k of Object.keys(attrs)) if (!target.attributes.some((a) => a.key === k)) delete attrs[k];
      name.attrs = attrs;
    }
    this.guidedChanged();
    return this.guidedView();
  }

  /** Use or ignore a word in this block. An ignored word is not sent with the block and is not added to the knowledge base. */
  guidedSetUse(source: string, use: boolean): GuidedState {
    const { name } = this.wordOf(source);
    if (use) delete name.use;
    else name.use = false;
    this.guidedChanged();
    return this.guidedView();
  }

  /** Adds a word from the text to this block, as a draft unless the knowledge base has it. */
  async guidedAddName(index: number, source: string): Promise<GuidedState> {
    const block = this.guidedBlock(index);
    const word = source.trim();
    if (word === "") throw new UserError("no_name", "Type the word as it is written in the text.");
    if (!block.interpretation) await this.guidedInterpret(index);
    const interp = block.interpretation!;
    // Only a topic of that very word counts: a word that is an alias of another topic can have a translation of its own.
    const existing = this.knowledge.all().find((e) => e.kind === "term" && e.source === word);
    if (!interp.names.some((n) => n.source === word)) {
      if (existing) interp.names.push({ source: word, english: existing.target, kind: "term", aliases: [], reading: "", known: existing.status === "confirmed", draft: false });
      else {
        const readings = await readNames([word]);
        const guess = nameGuess(word, readings[word]);
        // A word that is already another way to write a person's name stands for that person.
        const owner = this.knowledge.all().find((e) => e.kind === "term" && e.category === "character" && e.aliases.includes(word));
        // A word the user adds is a term, unless it ends like a family, a place or an organization. People are found by the dictionary;
        // one it missed is changed to a person from the row. A word that stands for a person is a term as well.
        const asTerm = owner !== undefined || guess.kind === "character";
        interp.names.push({ source: word, english: asTerm ? "" : guess.english, kind: asTerm ? "term" : guess.kind, aliases: [], reading: guess.reading, known: false, draft: true, attrs: owner ? { "refers to": [owner.source] } : {} });
      }
    }
    this.guidedChanged();
    return this.guidedView();
  }

  /** The words the user is using in a block enter the knowledge base: drafts are added, and suggestions are accepted. Ignored words do nothing. */
  private commitWords(interp: Interpretation): void {
    const at = new Date().toISOString();
    for (const n of interp.names) {
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

  /** The user's own correction of the translation of one paragraph of a block. */
  guidedSetPart(index: number, paragraph: number, text: string): GuidedState {
    const block = this.guidedBlock(index);
    this.guidedView();
    if (paragraph < 0 || paragraph >= block.parts.length) throw new UserError("no_paragraph", "That paragraph does not exist.");
    block.parts[paragraph] = text.trim();
    this.afterParts(block, null);
    return this.guidedView();
  }

  /** The block's translation follows its paragraphs' translations; the block is translated when every paragraph has one. */
  private afterParts(block: ReturnType<WorkspaceService["guidedBlock"]>, warning: string | null): void {
    block.translation = joinParts(block.parts);
    if (block.parts.length > 0 && block.parts.every((p) => p.trim() !== "")) block.status = "translated";
    else if (block.status === "translated") block.status = "interpreted";
    block.error = null;
    block.warning = warning;
    this.guidedChanged();
  }

  /** The translation style the model's settings name, filled in with the languages. */
  private styleOf(input: GuidedModelInput): { text: string } {
    const style = allPrompts((this.settings?.prompts ?? []).filter((p) => validatePrompt(p) === null)).find((p) => p.id === input.promptId) ?? STANDARD_PROMPT;
    return { text: renderPrompt(style, input.sourceLanguage, input.targetLanguage) };
  }

  /**
   * Translates one paragraph of a block. The model gets what applies to the paragraph (its glossary words, notes and who speaks),
   * the source around it as far as the context has room, and the translation so far with an empty place for it. The answer is
   * taken from between markers; if it leaves out a glossary name of the paragraph, or gives back the text that was rejected, the
   * model is asked once more.
   */
  private async translateParagraph(input: GuidedModelInput & { index: number }, k: number, system: string, abort: AbortController, old?: string): Promise<{ text: string; issue: string | null } | null> {
    const block = this.guidedBlock(input.index);
    const interp = block.interpretation!;
    const sources = paragraphsOf(block.text).map((p) => p.text);
    const paragraph = sources[k]!;
    const glossary = glossaryFor(interp, paragraph);
    const notes = notesFor(interp, paragraph);
    const previousBlock = input.index > 0 ? this.guided!.blocks[input.index - 1] : undefined;
    const previous = k === 0 && previousBlock && previousBlock.status === "translated" ? { source: lastLines(previousBlock.text, 3, 500), translation: lastLines(previousBlock.translation, 3, 500) } : null;
    const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
    let reject: string | undefined;
    let complaint = "";
    let text = "";
    let issue: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      // As much of the source around the paragraph as fits: the whole block, then fewer paragraphs on each side.
      let user = "";
      for (let radius = Math.max(k, sources.length - 1 - k); radius >= 0; radius--) {
        const lo = Math.max(0, k - radius);
        const hi = Math.min(sources.length - 1, k + radius);
        user =
          paragraphMessage({
            glossary,
            notes,
            sourceLanguage: input.sourceLanguage,
            previous,
            sourceBefore: sources.slice(lo, k),
            paragraph,
            sourceAfter: sources.slice(k + 1, hi + 1),
            translatedBefore: block.parts.slice(lo, k),
            translatedAfter: block.parts.slice(k + 1, hi + 1),
            rejected: reject,
          }) + complaint;
        if (estimateTokens(system) + estimateTokens(user) + input.maxOutputTokens + DEFAULTS.messageOverheadTokens <= input.contextLimit) break;
        if (radius === 0) throw new UserError("context_overflow", `Paragraph ${k + 1} needs about ${estimateTokens(system) + estimateTokens(user)} tokens plus ${input.maxOutputTokens} for the reply, but the context of ${input.modelId} is set to ${input.contextLimit}. Raise the context size, or use smaller blocks.`);
      }
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
          practiceReply: () => [`Practice translation of paragraph ${k + 1} of block ${input.index + 1}.`, ...glossary.map((g) => targetVariants(g.target)[0]).filter((t): t is string => !!t)].join(" "),
        },
        abort,
      );
      if (reply === null) return null; // stopped
      const answer = answerOf(reply);
      if (answer === null) throw new UserError("invalid_response", `The model wrote nothing for paragraph ${k + 1}. If it is a thinking model, raise its reply limit.`);
      text = answer;
      const missing = missingNames(glossary, paragraph, text);
      const unchanged = old !== undefined && sameText(text, old);
      issue = missing.length > 0 ? `Paragraph ${k + 1} does not use the glossary names: ${missing.join("; ")}.` : unchanged ? `Paragraph ${k + 1}: the model wrote the same text again.` : null;
      if (issue === null) break;
      if (unchanged) reject = old;
      complaint = missing.length > 0 ? `\n\nYour last answer was not accepted because it does not use these exact names: ${missing.join("; ")}. Translate again and use them exactly as written.` : "";
    }
    return { text, issue };
  }

  /**
   * Translates a block paragraph by paragraph, each one with what the user confirmed, saving each as it is done so that the
   * paragraphs written so far show while the rest are being written, and so that stopping keeps them.
   */
  async guidedTranslate(input: GuidedModelInput & { index: number }): Promise<GuidedState> {
    const block = this.guidedBlock(input.index);
    if (!block.interpretation) await this.guidedInterpret(input.index);
    this.guidedView();
    const interp = block.interpretation!;
    const abort = this.beginSideRequest();
    const issues: string[] = [];
    try {
      this.commitWords(interp);
      this.guidedView();
      const style = this.styleOf(input);
      const system = paragraphSystem(style.text, input.sourceLanguage, input.targetLanguage);
      block.parts = block.parts.map(() => "");
      block.translation = "";
      block.status = "interpreted";
      block.error = null;
      block.warning = null;
      this.guidedChanged();
      for (let k = 0; k < block.parts.length; k++) {
        const done = await this.translateParagraph(input, k, system, abort);
        if (done === null) break; // stopped: what is written so far stays
        block.parts[k] = done.text;
        if (done.issue) issues.push(done.issue);
        this.afterParts(block, issues.length > 0 ? issues.join(" ") : null);
      }
    } catch (e) {
      this.afterParts(block, issues.length > 0 ? issues.join(" ") : null);
      block.error = e instanceof UserError ? e.message : "The translation failed.";
      throw e;
    } finally {
      this.analysisAbort = null;
    }
    return this.guidedView();
  }

  /** Translates one paragraph of a block again, keeping the others as they are. The old text is not shown to the model unless it is given back. */
  async guidedRetranslate(input: GuidedModelInput & { index: number; paragraph: number }): Promise<GuidedState> {
    const block = this.guidedBlock(input.index);
    if (!block.interpretation) await this.guidedInterpret(input.index);
    this.guidedView();
    if (input.paragraph < 0 || input.paragraph >= block.parts.length) throw new UserError("no_paragraph", "That paragraph does not exist.");
    const abort = this.beginSideRequest();
    try {
      this.commitWords(block.interpretation!);
      this.guidedView();
      const style = this.styleOf(input);
      const system = paragraphSystem(style.text, input.sourceLanguage, input.targetLanguage);
      const old = block.parts[input.paragraph] ?? "";
      const done = await this.translateParagraph(input, input.paragraph, system, abort, old.trim() === "" ? undefined : old);
      if (done === null) return this.guidedView();
      block.parts[input.paragraph] = done.text;
      this.afterParts(block, done.issue);
    } finally {
      this.analysisAbort = null;
    }
    return this.guidedView();
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

