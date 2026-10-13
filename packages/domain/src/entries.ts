import { parseKnowledge, serializeNotes, serializeTerm, type BlockMaterial, type KnowledgeNote } from "./knowledge.js";
import type { GlossaryEntry } from "./state.js";

/** A term is a name or word with its translation and a hint. A note is a fact about the story, tied to words that make it relevant. */
export type EntryKind = "term" | "note";
/** `suggested` entries were written by a model and not looked at yet; they are used just like confirmed ones. */
export type EntryStatus = "suggested" | "confirmed";

/** Where an entry came from. A model's entry says which text it read. */
export interface EntryOrigin {
  by: "user" | "model";
  model?: string;
  documentTitle?: string;
  /** Number of the block (starting at 1) the entry was found in. */
  block?: number;
}

export interface KnowledgeEntry {
  id: string;
  kind: EntryKind;
  /** Terms: the word as written in the source text. */
  source: string;
  /** Terms: how it should be translated. */
  target: string;
  /** Terms: a short hint (gender, how they speak...). */
  hint: string;
  /** Notes: the fact itself. */
  text: string;
  /** Sent with every block, without a model deciding whether it is relevant (for example a rule about honorifics). */
  pinned: boolean;
  origin: EntryOrigin;
  status: EntryStatus;
  updatedAt: string;
}

/** What the user fills in to add or change an entry. */
export interface EntryInput {
  id?: string;
  kind: EntryKind;
  source: string;
  target: string;
  hint: string;
  text: string;
  pinned: boolean;
}

export interface EntryQuery {
  /** Matches any part of the source, translation, hint or note, ignoring case. */
  text?: string;
  kind?: EntryKind;
  status?: EntryStatus;
  by?: "user" | "model";
}

export interface EntryCounts {
  terms: number;
  notes: number;
  suggested: number;
}

const MAX_FIELD = 2000;

/** Plain-language problems with an entry, or an empty list when it can be saved. */
export function entryProblems(e: EntryInput): string[] {
  const out: string[] = [];
  if (e.kind === "term") {
    if (e.source.trim() === "") out.push("Enter the word as written in the text.");
    if (e.target.trim() === "") out.push("Enter how it should be translated.");
  } else if (e.text.trim() === "") out.push("Enter the note.");
  const long = [e.source, e.target, e.hint, e.text].some((s) => s.length > MAX_FIELD);
  if (long) out.push("One of the fields is too long.");
  return out;
}

/** The terms and notes in the form a translation run uses. */
export function splitEntries(entries: readonly KnowledgeEntry[]): { glossary: GlossaryEntry[]; notes: string } {
  const glossary: GlossaryEntry[] = [];
  const notes: KnowledgeNote[] = [];
  for (const e of entries) {
    if (e.kind === "term") glossary.push({ source: e.source.trim(), target: e.target.trim(), ...(e.hint.trim() ? { note: e.hint.trim() } : {}) });
    else notes.push({ text: e.text.trim() });
  }
  return { glossary, notes: serializeNotes(notes) };
}

/** One line per entry, in the format people paste in and copy out. */
export function entriesToText(entries: readonly KnowledgeEntry[]): string {
  const terms = entries.filter((e) => e.kind === "term").map((e) => serializeTerm({ source: e.source, target: e.target, ...(e.hint ? { note: e.hint } : {}) }));
  const notes = entries.filter((e) => e.kind === "note").map((e) => `> ${e.text}`);
  return [...terms, ...(terms.length > 0 && notes.length > 0 ? [""] : []), ...notes].join("\n");
}

export interface EntryDeps {
  newId: () => string;
  now: () => string;
}

/** Reads pasted lines into entries. Lines that cannot be read are counted so the user can be told. */
export function entriesFromText(text: string, origin: EntryOrigin, status: EntryStatus, deps: EntryDeps): { entries: KnowledgeEntry[]; unreadable: number } {
  const parsed = parseKnowledge(text);
  const at = deps.now();
  const base = { origin, status, updatedAt: at };
  const entries: KnowledgeEntry[] = [
    ...parsed.glossary.map((g): KnowledgeEntry => ({ id: deps.newId(), kind: "term", source: g.source, target: g.target, hint: g.note ?? "", text: "", pinned: false, ...base })),
    ...parsed.notes.map((n): KnowledgeEntry => ({ id: deps.newId(), kind: "note", source: "", target: "", hint: "", text: n.text, pinned: false, ...base })),
  ];
  return { entries, unreadable: parsed.lines.filter((l) => l.kind === "problem").length };
}

/** The entries for a project saved before there was a knowledge store (a glossary and notes written as text). */
export function entriesFromLegacy(glossary: readonly GlossaryEntry[], legacyNotes: string | undefined, knowledge: string | undefined, deps: EntryDeps): KnowledgeEntry[] {
  const text = knowledge !== undefined && knowledge.trim() !== "" ? knowledge : [glossary.map(serializeTerm).join("\n"), ...(legacyNotes ?? "").split("\n").filter((l) => l.trim() !== "").map((l) => (l.trim().startsWith(">") ? l.trim() : `> ${l.trim().replace(/^[-*]\s+/, "")}`))].filter((s) => s !== "").join("\n");
  return entriesFromText(text, { by: "user" }, "confirmed", deps).entries;
}

/** The entries a block will be translated with, in the form a request uses. */
export function materialFromEntries(entries: readonly KnowledgeEntry[]): BlockMaterial {
  const s = splitEntries(entries);
  return { glossary: s.glossary, notes: entries.filter((e) => e.kind === "note").map((e) => e.text.trim()) };
}
