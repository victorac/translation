import { relevantEntries } from "./glossary.js";
import type { GlossaryEntry } from "./state.js";
import { estimateTokens } from "./tokens.js";

/**
 * The project's knowledge base is one text with one entry per line:
 *
 *   # a comment or heading
 *   花子 = Hanako # girl, speaks politely        a name or term, with an optional hint
 *   > 花子, 太郎 | Hanako is being addressed.    a note that applies when those words appear
 *   > Keep honorifics.                          a note for every block
 */
export interface KnowledgeNote {
  /** The words that make this note relevant. Empty means it applies to every block. */
  keys: string[];
  text: string;
}

export type KnowledgeLine =
  | { kind: "blank" | "comment" | "term" | "note"; from: number; to: number }
  | { kind: "problem"; from: number; to: number; message: string };

export interface ParsedKnowledge {
  glossary: GlossaryEntry[];
  notes: KnowledgeNote[];
  /** One entry per line of the text, for showing how each line was read. */
  lines: KnowledgeLine[];
}

const TERM = /^(.*?)\s*(?:=>|->|→|=|\t)\s*(.*)$/;
const KEY_SPLIT = /[,、，]/;

export function parseKnowledge(text: string): ParsedKnowledge {
  const glossary: GlossaryEntry[] = [];
  const notes: KnowledgeNote[] = [];
  const lines: KnowledgeLine[] = [];
  let from = 0;
  for (const raw of text.split("\n")) {
    const to = from + raw.length;
    const line = raw.trim();
    if (line === "") lines.push({ kind: "blank", from, to });
    else if (line.startsWith("#")) lines.push({ kind: "comment", from, to });
    else if (line.startsWith(">")) {
      const body = line.slice(1).trim();
      const bar = body.indexOf("|");
      const keys = bar >= 0 ? body.slice(0, bar).split(KEY_SPLIT).map((k) => k.trim()).filter(Boolean) : [];
      const noteText = (bar >= 0 ? body.slice(bar + 1) : body).trim();
      if (noteText === "") lines.push({ kind: "problem", from, to, message: "This note is empty." });
      else if (bar >= 0 && keys.length === 0) lines.push({ kind: "problem", from, to, message: 'Put the words it is about before "|", or remove the "|" to use it everywhere.' });
      else {
        notes.push({ keys, text: noteText });
        lines.push({ kind: "note", from, to });
      }
    } else {
      const [pair = "", ...hint] = line.split(/\s#\s/);
      const m = TERM.exec(pair.trim());
      const source = m?.[1]?.trim() ?? "";
      const target = m?.[2]?.trim() ?? "";
      if (!m || source === "" || target === "") {
        lines.push({ kind: "problem", from, to, message: "Not understood. Write: source = translation # hint. Notes start with >." });
      } else {
        const note = hint.join(" # ").trim();
        glossary.push({ source, target, ...(note ? { note } : {}) });
        lines.push({ kind: "term", from, to });
      }
    }
    from = to + 1;
  }
  return { glossary, notes, lines };
}

export const serializeNote = (n: KnowledgeNote): string => `> ${n.keys.length > 0 ? `${n.keys.join(", ")} | ` : ""}${n.text}`;
export const serializeNotes = (notes: readonly KnowledgeNote[]): string => notes.map(serializeNote).join("\n");
export const serializeTerm = (g: GlossaryEntry): string => `${g.source} = ${g.target}${g.note ? ` # ${g.note}` : ""}`;

/** What a run needs from the knowledge text: the terms, and the notes in the same line format. */
export function splitKnowledge(text: string): { glossary: GlossaryEntry[]; notes: string } {
  const k = parseKnowledge(text);
  return { glossary: k.glossary, notes: serializeNotes(k.notes) };
}

/** Builds the knowledge text for a project saved before it existed (a glossary and free-text notes). */
export function knowledgeFromLegacy(glossary: readonly GlossaryEntry[], legacyNotes: string | undefined): string {
  const parts: string[] = [];
  if (glossary.length > 0) parts.push(glossary.map(serializeTerm).join("\n"));
  const notes = (legacyNotes ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith(">") || l.startsWith("#") ? l : `> ${l.replace(/^[-*]\s+/, "")}`));
  if (notes.length > 0) parts.push(notes.join("\n"));
  return parts.join("\n\n");
}

const lower = (s: string) => s.toLocaleLowerCase();

/** Notes for every block, plus the ones whose words appear in the given text. */
export function relevantNotes(notes: readonly KnowledgeNote[], ...texts: (string | null)[]): KnowledgeNote[] {
  const hay = texts.filter((t): t is string => !!t).map(lower);
  return notes.filter((n) => n.keys.length === 0 || n.keys.some((k) => hay.some((h) => h.includes(lower(k)))));
}

/** The most tokens of knowledge one request may carry: a fifth of the context, and never more than 1000. */
export const knowledgeCap = (contextLimit: number): number => Math.max(0, Math.min(1000, Math.floor(contextLimit * 0.2)));

const termLine = (g: GlossaryEntry) => serializeTerm(g);

/** Room to set aside for knowledge in a model's context: everything if it is small, otherwise the cap. */
export function knowledgeReserve(glossary: readonly GlossaryEntry[], notes: string, contextLimit: number): number {
  const all = estimateTokens([...glossary.map(termLine), ...parseKnowledge(notes).notes.map((n) => n.text)].join("\n"));
  return Math.min(all, knowledgeCap(contextLimit));
}

export interface BlockKnowledge {
  glossary: GlossaryEntry[];
  notes: string[];
  /** How many relevant entries did not fit in the allowance and were left out. */
  omitted: number;
}

/**
 * What one block's request carries: only the terms and notes that apply to its own text, within the allowance.
 * Terms come first, then notes about the words in the block, then notes for every block.
 */
export function knowledgeForBlock(glossary: readonly GlossaryEntry[], notesText: string, blockText: string, capTokens: number): BlockKnowledge {
  const terms = relevantEntries(glossary, blockText);
  const all = parseKnowledge(notesText).notes;
  const keyed = relevantNotes(all, blockText).filter((n) => n.keys.length > 0);
  const general = all.filter((n) => n.keys.length === 0);
  let left = capTokens;
  let omitted = 0;
  const take = <T>(items: readonly T[], cost: (t: T) => number): T[] => {
    const kept: T[] = [];
    for (const it of items) {
      const c = cost(it);
      if (c <= left) {
        left -= c;
        kept.push(it);
      } else omitted++;
    }
    return kept;
  };
  const t = take(terms, (g) => estimateTokens(termLine(g)));
  const k = take(keyed, (n) => estimateTokens(n.text));
  const g = take(general, (n) => estimateTokens(n.text));
  return { glossary: t, notes: [...k, ...g].map((n) => n.text), omitted };
}
