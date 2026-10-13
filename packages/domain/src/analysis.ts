import { parseGlossaryText } from "./glossary.js";
import type { EntryDeps, EntryOrigin, KnowledgeEntry } from "./entries.js";
import { parseKnowledge, serializeTerm, type BlockKnowledge, type KnowledgeNote } from "./knowledge.js";
import type { GlossaryEntry } from "./state.js";

/** What reading a passage found: people (as glossary lines with a hint) and short notes about who is who. */
export interface AnalysisResult {
  characters: GlossaryEntry[];
  notes: KnowledgeNote[];
}

const MAX_CHARACTERS_PER_PASSAGE = 20;
const MAX_NOTES_PER_PASSAGE = 8;
const MAX_NOTE_CHARS = 220;

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
 * Adds what a model found to the knowledge entries, as suggestions. Nothing the user wrote is changed:
 * a term that is already listed only gets a hint if its hint was empty, and a note that is already there is not repeated.
 */
export function mergeSuggestions(entries: readonly KnowledgeEntry[], found: AnalysisResult, origin: EntryOrigin, deps: EntryDeps): { entries: KnowledgeEntry[]; added: number } {
  let next = [...entries];
  let added = 0;
  const at = deps.now();
  for (const c of found.characters) {
    const i = next.findIndex((e) => e.kind === "term" && e.source.trim() === c.source);
    if (i < 0) {
      next.push({ id: deps.newId(), kind: "term", source: c.source, target: c.target, hint: c.note ?? "", keys: [], text: "", origin, status: "suggested", updatedAt: at });
      added++;
    } else if (!next[i]!.hint.trim() && c.note) {
      next = next.map((e, j) => (j === i ? { ...e, hint: c.note!, updatedAt: at } : e));
      added++;
    }
  }
  for (const n of found.notes) {
    if (next.some((e) => e.kind === "note" && e.text.toLocaleLowerCase() === n.text.toLocaleLowerCase())) continue;
    next.push({ id: deps.newId(), kind: "note", source: "", target: "", hint: "", keys: n.keys, text: n.text, origin, status: "suggested", updatedAt: at });
    added++;
  }
  return { entries: next, added };
}
