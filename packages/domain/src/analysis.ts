import { parseGlossaryText } from "./glossary.js";
import type { GlossaryEntry } from "./state.js";

/** What reading a passage found: people (as glossary lines with a hint) and short facts about who is who. */
export interface AnalysisResult {
  characters: GlossaryEntry[];
  notes: string[];
}

const MAX_CHARACTERS_PER_PASSAGE = 20;
const MAX_NOTES_PER_PASSAGE = 8;
const MAX_NOTE_CHARS = 220;
export const SUGGESTED_HEADER = "Suggested by the model (please check):";

export function analysisSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  return `You help a translator prepare to translate fiction from ${sourceLanguage} to ${targetLanguage}. Read the passage and report only facts that help avoid mistakes with names, pronouns, who is speaking and who is being spoken to. Do not translate the passage.

Reply with plain lines and nothing else. There are two kinds of line.
1. One line for each named person or recurring character: the name as written in the passage, then "=", then the name in ${targetLanguage}, then "#", then a short hint (gender, age group, how they speak, their relationship to others). Example: 花子 = Hanako # girl, speaks very politely, the narrator's classmate
2. Lines that start with "NOTE:" followed by one short sentence about who speaks to whom, who a dropped subject or object refers to, or whose point of view the narrator has.

A section called KNOWN SO FAR lists what is already noted. Do not repeat it. Add a person only if they are new, or if you can add something that is missing. If you are not sure about something, say so in the line (for example "probably a girl"). If there is nothing to add, reply with the single word NONE.`;
}

/** The request for one passage, as plain labelled text. */
export function analysisUserMessage(known: { glossary: readonly GlossaryEntry[]; notes: string }, passage: string): string {
  const people = known.glossary
    .filter((g) => g.source.trim() !== "" && g.target.trim() !== "")
    .slice(0, 80)
    .map((g) => `${g.source} = ${g.target}${g.note ? ` # ${g.note}` : ""}`);
  const notes = known.notes.trim().slice(-2000);
  const parts: string[] = [];
  if (people.length > 0 || notes !== "") parts.push(`KNOWN SO FAR:\n${[...people, notes].filter(Boolean).join("\n")}`);
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
  const notes: string[] = [];
  for (const raw of reply.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (line === "" || /^none\.?$/i.test(line)) continue;
    const note = /^note\s*[:：]\s*(.+)$/i.exec(line);
    if (note) {
      const text = note[1]!.trim().slice(0, MAX_NOTE_CHARS);
      if (text !== "" && notes.length < MAX_NOTES_PER_PASSAGE) notes.push(text);
    } else if (/[=→]|->/.test(line)) {
      characterLines.push(line);
    }
  }
  const characters = parseGlossaryText(characterLines.join("\n")).entries.slice(0, MAX_CHARACTERS_PER_PASSAGE);
  return { characters, notes };
}

export interface NotesState {
  glossary: GlossaryEntry[];
  notes: string;
}

/**
 * Adds what was found to what the user already has. Nothing the user wrote is changed or removed:
 * a person already in the glossary only gets a hint if theirs was empty, and a note already present is not repeated.
 */
export function mergeAnalysis(current: NotesState, found: AnalysisResult): NotesState {
  let glossary = current.glossary;
  for (const c of found.characters) {
    const at = glossary.findIndex((g) => g.source.trim() === c.source);
    if (at < 0) {
      glossary = [...glossary, c];
    } else if (!glossary[at]!.note?.trim() && c.note) {
      glossary = glossary.map((g, i) => (i === at ? { ...g, note: c.note! } : g));
    }
  }
  let notes = current.notes;
  const have = notes.toLocaleLowerCase();
  const fresh = found.notes.filter((n) => !have.includes(n.toLocaleLowerCase()));
  if (fresh.length > 0) {
    const head = notes.includes(SUGGESTED_HEADER) ? "" : `${notes.trim() === "" ? "" : "\n\n"}${SUGGESTED_HEADER}\n`;
    const body = fresh.map((n) => `- ${n}`).join("\n");
    notes = notes.trim() === "" || head !== "" ? `${notes.replace(/\s+$/, "")}${head}${body}` : `${notes.replace(/\s+$/, "")}\n${body}`;
  }
  return { glossary, notes };
}
