import { splitSentences, addressedIn, findQuotes, firstPersonInNarration, nameFromReadings, romanize, speakerByForm, takeTurns, type Speaker } from "./steps.js";

/**
 * The step-by-step way of translating: for each block the program reads out who is named, who is telling it and who says
 * each line, the user checks that, and only then is the block translated with it. Everything here is decided by rules
 * and the dictionary, never by guessing.
 */

export type NameKind = "character" | "family" | "place" | "organization" | "term";

export interface GuidedName {
  source: string;
  /** The name in the translation. Empty when it is not known and the user has to write it. */
  english: string;
  kind: NameKind;
  aliases: string[];
  /** How the dictionary reads it, in letters, to help the user write the English name. */
  reading: string;
  /** True when the name is already in the project's glossary. */
  known: boolean;
  /** For a person: how the text refers to them, when it is clear. */
  gender?: Gender | null;
}

export type Gender = "female" | "male";

export interface GuidedLine {
  text: string;
  /** The source of the name that says it, or null when it is not known. */
  speaker: string | null;
}

export interface Interpretation {
  names: GuidedName[];
  /** The source of the name of the one telling the story, when told as "I". */
  narrator: string | null;
  /** The word the narrator uses for "I" in this block, if the block is told that way. */
  narratorWord: string | null;
  lines: GuidedLine[];
}

/** A name that is already in the glossary. */
export interface KnownName {
  source: string;
  english: string;
  kind: NameKind;
  aliases: string[];
  narrator: boolean;
  gender?: Gender | null;
}

export type GuidedStatus = "new" | "interpreted" | "translated";

export interface GuidedBlock {
  index: number;
  text: string;
  interpretation: Interpretation | null;
  translation: string;
  status: GuidedStatus;
  /** Why the last attempt to translate it failed. */
  error: string | null;
}

export interface GuidedState {
  documentId: string;
  blocks: GuidedBlock[];
  /** The block the user is working on. */
  current: number;
}

const ORGANIZATION = /(学園|学院|学校|高校|大学|会社|協会|組合|騎士団|教団|軍|党)$/;
const PLACE = /(市|町|村|県|駅|島|山|川|森|街|城|寺|神社|王国|帝国|国|村|港|橋)$/;

/** What kind of name this probably is, from how it ends. The user can change it. */
export function guessKind(source: string): NameKind {
  if (/家$/.test(source) && source.length >= 3) return "family";
  if (ORGANIZATION.test(source)) return "organization";
  if (PLACE.test(source)) return "place";
  return "character";
}

/** The reading as letters with a space between words: ["ヤマダ", "タロウ"] gives "yamada taro". */
export function readingLetters(reading: readonly string[] | undefined): string {
  if (!reading) return "";
  const words = reading.map(romanize);
  return words.every((w) => w !== null) ? words.join(" ") : "";
}

/** The English name of a person or family from the dictionary; other kinds are left for the user, who is shown the reading. */
function englishFor(kind: NameKind, reading: readonly string[] | undefined): string {
  if (!reading || (kind !== "character" && kind !== "family")) return "";
  return nameFromReadings(reading, kind === "family") ?? "";
}

/**
 * What the text says a person is, from the sentence after the one that gives their name when that sentence names nobody else
 * and starts with 彼女 or 彼 ("鈴木花子。彼女は…"). Null when it does not say, or says both.
 */
export function guessGender(passage: string, names: readonly string[], otherNames: readonly string[]): Gender | null {
  const sentences = splitSentences(passage);
  let female = 0;
  let male = 0;
  sentences.forEach((s, i) => {
    if (!names.some((n) => s.text.includes(n)) || otherNames.some((o) => s.text.includes(o))) return;
    const next = sentences[i + 1]?.text ?? "";
    if (next.startsWith("彼女")) female++;
    else if (next.startsWith("彼")) male++;
  });
  return female > 0 && male === 0 ? "female" : male > 0 && female === 0 ? "male" : null;
}

const namesOf = (n: { source: string; aliases: readonly string[] }): string[] => [n.source, ...n.aliases];

export interface InterpretInput {
  passage: string;
  /** Names found in the passage without a model. */
  candidates: readonly string[];
  readings: Readonly<Record<string, readonly string[]>>;
  glossary: readonly KnownName[];
}

/** Who says each line of the passage, for the people in `names` and the narrator. */
export function labelLines(passage: string, names: readonly GuidedName[], narrator: string | null, narratorWord: string | null): GuidedLine[] {
  const quotes = findQuotes(passage);
  const speakers: Speaker[] = names
    .filter((n) => n.kind === "character")
    .map((n) => ({ id: n.source, label: n.english || n.source, names: namesOf(n) }));
  if (narrator) {
    const known = speakers.find((s) => s.id === narrator);
    if (known) {
      if (narratorWord) known.names = [...known.names, narratorWord];
    } else speakers.push({ id: narrator, label: narrator, names: narratorWord ? [narrator, narratorWord] : [narrator] });
  }
  const unlabeled = quotes.map((q) => ({ text: q.text, speaker: null as string | null }));
  if (speakers.length < 2) return unlabeled;
  let who: (string | null)[] = quotes.map((q) => speakerByForm(passage, q, speakers, quotes));
  // A line that names one of two people as spoken to is said by the other.
  quotes.forEach((q, i) => {
    if (who[i] !== null || speakers.length !== 2) return;
    const left = speakers.filter((s) => !addressedIn(q.text, speakers).has(s.id));
    if (left.length === 1) who[i] = left[0]!.id;
  });
  who = takeTurns(passage, quotes, who, speakers);
  return quotes.map((q, i) => ({ text: q.text, speaker: who[i] ?? null }));
}

/** Reads a block into what the user is shown to check. */
export function interpretPassage(input: InterpretInput): Interpretation {
  const { passage } = input;
  const names: GuidedName[] = [];
  const taken = (s: string) => names.some((n) => namesOf(n).includes(s));

  for (const k of input.glossary) {
    if (namesOf(k).some((n) => passage.includes(n))) names.push({ source: k.source, english: k.english, kind: k.kind, aliases: [...k.aliases], reading: readingLetters(input.readings[k.source]), known: true, gender: k.gender ?? null });
  }
  // The longest candidates first, so a short one inside a longer one is not taken as a name of its own.
  const rest = [...new Set(input.candidates)].filter((c) => !taken(c)).sort((a, b) => b.length - a.length);
  for (const c of rest) {
    if (taken(c)) continue;
    if (names.some((n) => n.source.length > c.length && n.source.includes(c) && passage.split(n.source).join("").indexOf(c) < 0)) continue;
    const kind = guessKind(c);
    const reading = input.readings[c];
    names.push({ source: c, english: englishFor(kind, reading), kind, aliases: [], reading: readingLetters(reading), known: false, gender: null });
  }
  // The given name written alone (花子 for 鈴木花子) is the same person: it becomes one of that person's names.
  for (const p of names.filter((n) => n.kind === "character" && n.source.length >= 4)) {
    const tail = p.source.slice(-2);
    const alone = passage.split(p.source).join("|");
    const found = [...alone.matchAll(new RegExp(tail, "g"))].some((m) => !/[一-鿿゠-ヿ]/.test(alone[m.index! - 1] ?? ""));
    if (!found) continue;
    const other = names.findIndex((n) => n !== p && n.source === tail);
    if (other >= 0) names.splice(other, 1);
    if (!namesOf(p).includes(tail)) p.aliases.push(tail);
  }

  const narratorWord = firstPersonInNarration(passage);
  const narratorEntry = narratorWord ? input.glossary.find((k) => k.narrator) : undefined;
  const narrator = narratorEntry?.source ?? null;
  // The narrator speaks and acts in a block even when the block never writes the name.
  if (narratorEntry && !names.some((n) => n.source === narratorEntry.source)) {
    names.push({ source: narratorEntry.source, english: narratorEntry.english, kind: narratorEntry.kind, aliases: [...narratorEntry.aliases], reading: readingLetters(input.readings[narratorEntry.source]), known: true, gender: narratorEntry.gender ?? null });
  }
  // Where the text says it, a person who is not known to be one way or the other is that.
  for (const p of names.filter((n) => n.kind === "character" && !n.gender)) {
    p.gender = guessGender(passage, namesOf(p), names.filter((o) => o !== p && o.kind === "character").flatMap(namesOf));
  }
  return { names, narrator, narratorWord, lines: labelLines(passage, names, narrator, narratorWord) };
}

const shorten = (text: string, n: number): string => (Array.from(text).length > n ? `${Array.from(text).slice(0, n).join("")}…` : text);

/** The notes sent with the block: who is telling it, and who says the lines that are known. */
export function notesFor(interp: Interpretation): string[] {
  const english = (source: string): string => interp.names.find((n) => n.source === source)?.english || source;
  const notes: string[] = [];
  if (interp.narrator && interp.narratorWord) notes.push(`The narrator, who says ${interp.narratorWord} about himself or herself, is ${english(interp.narrator)}.`);
  for (const n of interp.names) if (n.kind === "character" && n.gender && n.english) notes.push(n.gender === "female" ? `${n.english} is a woman or girl (she/her).` : `${n.english} is a man or boy (he/him).`);
  for (const l of interp.lines) if (l.speaker) notes.push(`The line ${shorten(l.text, 16)} is said by ${english(l.speaker)}.`);
  return notes;
}

/** The glossary entries sent with the block: every name that has an English form. */
export function glossaryFor(interp: Interpretation): { source: string; target: string; aliases?: string[] }[] {
  return interp.names.filter((n) => n.english.trim() !== "").map((n) => ({ source: n.source, target: n.english.trim(), ...(n.aliases.length > 0 ? { aliases: n.aliases } : {}) }));
}

/** The last `lines` lines of a text, but never more than `maxChars` characters. */
export function lastLines(text: string, lines: number, maxChars: number): string {
  const parts = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  let out = parts.slice(-lines).join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}
