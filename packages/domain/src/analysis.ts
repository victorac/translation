import { parseGlossaryText } from "./glossary.js";
import { parseKnowledge, serializeNote, serializeTerm, type BlockKnowledge, type KnowledgeNote } from "./knowledge.js";
import type { GlossaryEntry } from "./state.js";

/** What reading a passage found: people (as glossary lines with a hint) and short notes about who is who. */
export interface AnalysisResult {
  characters: GlossaryEntry[];
  notes: KnowledgeNote[];
}

const MAX_CHARACTERS_PER_PASSAGE = 20;
const MAX_NOTES_PER_PASSAGE = 8;
const MAX_NOTE_CHARS = 220;
export const SUGGESTED_HEADER = "# Suggested by the model (please check)";

export function analysisSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  return `You help a translator prepare to translate fiction from ${sourceLanguage} to ${targetLanguage}. Read the passage and report only facts that help avoid mistakes with names, pronouns, who is speaking and who is being spoken to. Do not translate the passage.

Reply with plain lines and nothing else. There are two kinds of line.
1. One line for each named person or recurring character: the name as written in the passage, then "=", then the name in ${targetLanguage}, then "#", then a short hint (gender, age group, how they speak, their relationship to others). Example: 花子 = Hanako # girl, speaks very politely, the narrator's classmate
2. Lines that start with "NOTE:", then the names (as written in the passage) the note is about, separated by commas, then "|", then one short sentence about who speaks to whom, who a dropped subject or object refers to, or whose point of view the narrator has. Example: NOTE: 花子 | The second speaker is talking to Hanako.

A section called KNOWN SO FAR lists what is already noted. Do not repeat it. Add a person only if they are new, or if you can add something that is missing. If you are not sure about something, say so in the line (for example "probably a girl"). If there is nothing to add, reply with the single word NONE.`;
}

/** The request for one passage, as plain labelled text. `known` is only what already applies to this passage. */
export function analysisUserMessage(known: Pick<BlockKnowledge, "glossary" | "notes">, passage: string): string {
  const lines = [...known.glossary.filter((g) => g.source.trim() !== "" && g.target.trim() !== "").map(serializeTerm), ...known.notes];
  const parts: string[] = [];
  if (lines.length > 0) parts.push(`KNOWN SO FAR:\n${lines.join("\n")}`);
  parts.push(`PASSAGE:\n${passage}`);
  return parts.join("\n\n");
}

const cleanLine = (line: string): string =>
  line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();

/** Reads the model's reply. Anything that is not one of the two line kinds is ignored. */
export function parseAnalysisReply(reply: string): AnalysisResult {
  const characterLines: string[] = [];
  const notes: KnowledgeNote[] = [];
  for (const raw of reply.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (line === "" || /^none\.?$/i.test(line)) continue;
    const note = /^note\s*[:：]\s*(.+)$/i.exec(line);
    if (note) {
      if (notes.length >= MAX_NOTES_PER_PASSAGE) continue;
      const parsed = parseKnowledge(`> ${note[1]!.trim()}`).notes[0];
      if (parsed) notes.push({ keys: parsed.keys, text: parsed.text.slice(0, MAX_NOTE_CHARS) });
    } else if (/[=→]|->/.test(line)) {
      characterLines.push(line);
    }
  }
  const characters = parseGlossaryText(characterLines.join("\n")).entries.slice(0, MAX_CHARACTERS_PER_PASSAGE);
  return { characters, notes };
}

/**
 * Adds what was found to the knowledge text. Nothing the user wrote is changed or removed: a person who is already
 * listed only gets a hint if theirs was empty, and a note that is already there is not repeated.
 * New lines go at the end under one heading, so they are easy to find and check.
 */
export function mergeAnalysis(text: string, found: AnalysisResult): string {
  const parsed = parseKnowledge(text);
  let out = text;
  const additions: string[] = [];
  // Fill empty hints in place, working from the end so earlier offsets stay valid.
  const termLines = parsed.lines.filter((l) => l.kind === "term");
  const fills: { at: number; hint: string }[] = [];
  for (const c of found.characters) {
    const i = parsed.glossary.findIndex((g) => g.source === c.source);
    if (i < 0) {
      if (!additions.some((a) => a.startsWith(`${c.source} =`))) additions.push(serializeTerm(c));
    } else if (!parsed.glossary[i]!.note && c.note) {
      fills.push({ at: termLines[i]!.to, hint: c.note });
    }
  }
  for (const f of fills.sort((a, b) => b.at - a.at)) out = `${out.slice(0, f.at)} # ${f.hint}${out.slice(f.at)}`;
  const have = parsed.notes.map((n) => n.text.toLocaleLowerCase());
  for (const n of found.notes) {
    if (!have.includes(n.text.toLocaleLowerCase())) {
      have.push(n.text.toLocaleLowerCase());
      additions.push(serializeNote(n));
    }
  }
  if (additions.length === 0) return out;
  const trimmed = out.replace(/\s+$/, "");
  const header = trimmed.includes(SUGGESTED_HEADER) ? "" : `${trimmed === "" ? "" : "\n\n"}${SUGGESTED_HEADER}\n`;
  return `${trimmed}${header === "" ? "\n" : header}${additions.join("\n")}\n`;
}
