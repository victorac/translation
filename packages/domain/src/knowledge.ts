import { relevantEntries } from "./glossary.js";
import type { GlossaryEntry } from "./state.js";
import { estimateTokens } from "./tokens.js";

/**
 * Names, hints and notes can be written as lines, for pasting in and copying out:
 *
 *   # a comment or heading
 *   花子 = Hanako # girl, speaks politely     a name or term, with an optional hint
 *   > Hanako is being addressed.             a note about the story
 */
export interface KnowledgeNote {
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
      // Lines written when notes were tied to words ("names | note") keep only the note.
      const body = line.slice(1).trim();
      const bar = body.indexOf("|");
      const noteText = (bar >= 0 ? body.slice(bar + 1) : body).trim();
      if (noteText === "") lines.push({ kind: "problem", from, to, message: "This note is empty." });
      else {
        notes.push({ text: noteText });
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

export const serializeNote = (n: KnowledgeNote): string => `> ${n.text}`;
export const serializeNotes = (notes: readonly KnowledgeNote[]): string => notes.map(serializeNote).join("\n");
export const serializeTerm = (g: GlossaryEntry): string => `${g.source} = ${g.target}${g.note ? ` # ${g.note}` : ""}`;

/** What a run keeps from the project's knowledge: the terms, and the notes written as lines. */
export function splitKnowledge(text: string): { glossary: GlossaryEntry[]; notes: string } {
  const k = parseKnowledge(text);
  return { glossary: k.glossary, notes: serializeNotes(k.notes) };
}

/** The background that goes with one block: only the entries that were chosen for it. */
export interface BlockMaterial {
  glossary: GlossaryEntry[];
  notes: string[];
}

export interface BlockKnowledge extends BlockMaterial {
  /** How many chosen entries did not fit in the allowance and were left out. */
  omitted: number;
}

/** The most tokens of background one request may carry: a fifth of the context, and never more than 1000. */
export const knowledgeCap = (contextLimit: number): number => Math.max(0, Math.min(1000, Math.floor(contextLimit * 0.2)));

/** Room to set aside for background in a model's context: everything if it is small, otherwise the cap. */
export function knowledgeReserve(glossary: readonly GlossaryEntry[], notes: string, contextLimit: number): number {
  const all = estimateTokens([...glossary.map(serializeTerm), ...parseKnowledge(notes).notes.map((n) => n.text)].join("\n"));
  return Math.min(all, knowledgeCap(contextLimit));
}

/** Keeps what fits the allowance: terms first, then notes. */
export function fitMaterial(material: BlockMaterial, capTokens: number): BlockKnowledge {
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
  const glossary = take(material.glossary, (g) => estimateTokens(serializeTerm(g)));
  const notes = take(material.notes, (n) => estimateTokens(n));
  return { glossary, notes, omitted };
}

/**
 * A backup for when no one has looked through the knowledge for a block: the terms that appear in its text, and all notes.
 * The normal way is for a model to choose what matters for each block.
 */
export function backupMaterial(glossary: readonly GlossaryEntry[], notesText: string, blockText: string): BlockMaterial {
  return { glossary: relevantEntries(glossary, blockText), notes: parseKnowledge(notesText).notes.map((n) => n.text) };
}
