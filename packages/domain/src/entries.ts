import { parseKnowledge, serializeNotes, serializeTerm, type BlockMaterial, type KnowledgeNote } from "./knowledge.js";
import type { GlossaryEntry } from "./state.js";

/** What kind of topic a term is. It is the name of a class (character, place, organization, family, term, or one you define). */
export type TermCategory = string;

/**
 * The knowledge base holds four kinds of entry:
 *  - term: a name or word (a character, a place or another special word), how to translate it, and a short summary
 *    that is refined as more text is read
 *  - note: a fact. It is usually about one term ("addresses Taro as Yamada") and then belongs to that term
 *  - scene: what is going on around one block (where, who is present, who speaks to whom)
 *  - summary: an abridged version of a whole document
 */
export type EntryKind = "term" | "note" | "scene" | "summary";
/**
 * `suggested` entries were written by a model and not looked at yet; they are used just like confirmed ones.
 * `rejected` entries are kept only so a model is not allowed to suggest the same thing again; they are used nowhere else.
 */
export type EntryStatus = "suggested" | "confirmed" | "rejected";

/** Where an entry came from. A model's entry says which text it read. */
export interface EntryOrigin {
  by: "user" | "model";
  model?: string;
  documentId?: string;
  documentTitle?: string;
  /** Number of the block (starting at 1) the entry was found in. */
  block?: number;
}

/** What a scene or summary is about. A scene is tied to the text of its blocks, so it follows that text. */
export interface EntryScope {
  documentId: string;
  /** Scenes: the hashes of the text of each block in the scene. */
  blockHashes?: string[];
  /** Scenes: the number of the first block, for showing. */
  block?: number;
  /** Scenes: the number of the last block, when the scene runs over several. */
  blockEnd?: number;
  /** Scenes saved before they could run over several blocks. */
  blockHash?: string;
}

export interface KnowledgeEntry {
  id: string;
  kind: EntryKind;
  /** Terms: the word as written in the source text. */
  source: string;
  /** Terms: how it should be translated. */
  target: string;
  /** Terms: a short summary (who or what it is), refined as more text is read. */
  hint: string;
  /** Terms: a person, a place or another word. */
  category: TermCategory;
  /** Terms: other ways the same word is written in the text. */
  aliases: string[];
  /** Terms: the attributes of its class (gender, family...). Links are written as the name of the topic they point to. */
  attrs: Record<string, string[]>;
  /** Terms: the attributes a model filled in that nobody has checked yet. */
  attrFlags: string[];
  /** Notes, scenes and summaries: the text itself. */
  text: string;
  /** Notes: the term this fact is about, if any. */
  about: string | null;
  /** Scenes: the terms (people) present. */
  related: string[];
  scope: EntryScope | null;
  origin: EntryOrigin;
  status: EntryStatus;
  updatedAt: string;
}

/** What the user fills in to add or change an entry. A scene's block and people are kept as they were. */
export interface EntryInput {
  id?: string;
  kind: EntryKind;
  source: string;
  target: string;
  hint: string;
  category: TermCategory;
  aliases: string[];
  attrs?: Record<string, string[]> | undefined;
  text: string;
  about: string | null;
  /** For a new summary: the document it summarizes. */
  documentId?: string | undefined;
}

export interface EntryQuery {
  /** Matches any part of the source, translation, hint or text, ignoring case. */
  text?: string;
  kind?: EntryKind;
  status?: EntryStatus;
  by?: "user" | "model";
}

export interface EntryCounts {
  terms: number;
  /** Notes and facts. */
  notes: number;
  scenes: number;
  summaries: number;
  suggested: number;
}

const MAX_FIELD = 4000;

/** Plain-language problems with an entry, or an empty list when it can be saved. */
export function entryProblems(e: EntryInput): string[] {
  const out: string[] = [];
  if (e.kind === "term") {
    if (e.source.trim() === "") out.push("Enter the word as written in the text.");
    if (e.target.trim() === "") out.push("Enter how it should be translated.");
  } else if (e.text.trim() === "") out.push("Enter the text.");
  const long = [e.source, e.target, e.hint, e.text].some((s) => s.length > MAX_FIELD);
  if (long) out.push("One of the fields is too long.");
  return out;
}

/** What a term tells the translator about itself: its attributes (gender, speech style...) followed by its summary. */
export function termNote(e: Pick<KnowledgeEntry, "attrs" | "hint">): string {
  const attrs = Object.entries(e.attrs)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}: ${v.join(", ")}`);
  return [...attrs, e.hint.trim()].filter(Boolean).join("; ");
}

/** The terms and notes in the form a translation run keeps (used as a backup when no one has chosen background for a block). */
export function splitEntries(entries: readonly KnowledgeEntry[]): { glossary: GlossaryEntry[]; notes: string } {
  const glossary: GlossaryEntry[] = [];
  const notes: KnowledgeNote[] = [];
  for (const e of entries) {
    if (e.kind === "term") glossary.push({ source: e.source.trim(), target: e.target.trim(), ...(termNote(e) ? { note: termNote(e) } : {}), ...(e.aliases.length > 0 ? { aliases: e.aliases } : {}) });
    else if (e.kind === "note") notes.push({ text: e.text.trim() });
  }
  return { glossary, notes: serializeNotes(notes) };
}

/** One line per term and note, in the format people paste in and copy out. Scenes and summaries are not included. */
export function entriesToText(entries: readonly KnowledgeEntry[]): string {
  const terms = entries.filter((e) => e.kind === "term").map((e) => serializeTerm({ source: e.source, target: e.target, ...(e.hint ? { note: e.hint } : {}), ...(e.aliases.length > 0 ? { aliases: e.aliases } : {}) }));
  const named = new Map(entries.filter((e) => e.kind === "term").map((e) => [e.id, e.target]));
  const notes = entries.filter((e) => e.kind === "note").map((e) => `> ${e.about && named.has(e.about) ? `${named.get(e.about)}: ` : ""}${e.text}`);
  return [...terms, ...(terms.length > 0 && notes.length > 0 ? [""] : []), ...notes].join("\n");
}

export interface EntryDeps {
  newId: () => string;
  now: () => string;
}

const base = (origin: EntryOrigin, status: EntryStatus, at: string) => ({ category: "term" as TermCategory, aliases: [] as string[], attrs: {} as Record<string, string[]>, attrFlags: [] as string[], about: null, related: [] as string[], scope: null, origin, status, updatedAt: at });

/** Reads pasted lines into topics. Lines that cannot be used (including notes, which belong in a topic's file) are counted so the user can be told. */
export function entriesFromText(text: string, origin: EntryOrigin, status: EntryStatus, deps: EntryDeps): { entries: KnowledgeEntry[]; unreadable: number } {
  const parsed = parseKnowledge(text);
  const at = deps.now();
  const entries: KnowledgeEntry[] = [
    ...parsed.glossary.map((g): KnowledgeEntry => ({ id: deps.newId(), kind: "term", source: g.source, target: g.target, hint: g.note ?? "", text: "", ...base(origin, status, at), aliases: g.aliases ?? [] })),
  ];
  // A note that is not about one topic has nowhere to live, so it counts as something that could not be used.
  return { entries, unreadable: parsed.lines.filter((l) => l.kind === "problem" || l.kind === "note").length };
}

/** The entries for a project saved before there was a knowledge store (a glossary and notes written as text). */
export function entriesFromLegacy(glossary: readonly GlossaryEntry[], legacyNotes: string | undefined, knowledge: string | undefined, deps: EntryDeps): KnowledgeEntry[] {
  const text = knowledge !== undefined && knowledge.trim() !== "" ? knowledge : [glossary.map(serializeTerm).join("\n"), ...(legacyNotes ?? "").split("\n").filter((l) => l.trim() !== "").map((l) => (l.trim().startsWith(">") ? l.trim() : `> ${l.trim().replace(/^[-*]\s+/, "")}`))].filter((s) => s !== "").join("\n");
  return entriesFromText(text, { by: "user" }, "confirmed", deps).entries;
}

/** A scene saved with one block hash is a scene of one block. */
function normalizeScope(s: EntryScope | null): EntryScope | null {
  if (!s || s.blockHashes || !s.blockHash) return s;
  const { blockHash, ...rest } = s;
  return { ...rest, blockHashes: [blockHash] };
}

/** Entries from an older file lack the newer fields; fill them in. */
export function normalizeEntry(e: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, "id" | "kind" | "origin" | "status" | "updatedAt">): KnowledgeEntry {
  return {
    id: e.id,
    kind: e.kind,
    source: e.source ?? "",
    target: e.target ?? "",
    hint: e.hint ?? "",
    category: e.category ?? "term",
    aliases: e.aliases ?? [],
    attrs: e.attrs ?? {},
    attrFlags: e.attrFlags ?? [],
    text: e.text ?? "",
    about: e.about ?? null,
    related: e.related ?? [],
    scope: normalizeScope(e.scope ?? null),
    origin: e.origin,
    status: e.status,
    updatedAt: e.updatedAt,
  };
}

/**
 * The background that goes with one block, worked out from what the researcher chose for it:
 *  - the block's own scene, and the summary of its document
 *  - the terms the researcher chose, plus the people present in the scene
 *  - the facts about those terms, and any plain notes the researcher chose
 * Returns null if no one has looked at this block yet (then a backup is used).
 */
export function blockMaterial(entries: readonly KnowledgeEntry[], chosenIds: readonly string[] | null, blockHash: string, documentId: string | null): BlockMaterial | null {
  if (entries.length === 0) return null;
  const scene = entries.find((e) => e.kind === "scene" && (e.scope?.blockHashes?.includes(blockHash) || e.scope?.blockHash === blockHash));
  const summary = documentId ? entries.find((e) => e.kind === "summary" && e.scope?.documentId === documentId) : undefined;
  if (chosenIds === null && !scene) return null;
  const chosen = new Set([...(chosenIds ?? []), ...(scene?.related ?? [])]);
  const terms = entries.filter((e) => e.kind === "term" && chosen.has(e.id));
  const termIds = new Set(terms.map((t) => t.id));
  const facts = entries.filter((e) => e.kind === "note" && e.about !== null && termIds.has(e.about)).map((e) => `${terms.find((t) => t.id === e.about)!.target}: ${e.text.trim()}`);
  return {
    glossary: splitEntries(terms).glossary,
    notes: facts,
    ...(scene ? { scene: scene.text.trim() } : {}),
    ...(summary ? { summary: summary.text.trim() } : {}),
  };
}

/** Notes belong to a topic. A note that is about nothing (from an older project) is dropped. */
export function dropLooseNotes(entries: readonly KnowledgeEntry[]): KnowledgeEntry[] {
  const topics = new Set(entries.filter((e) => e.kind === "term").map((e) => e.id));
  return entries.filter((e) => !(e.kind === "note" && (e.about === null || !topics.has(e.about))));
}
