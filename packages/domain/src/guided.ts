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
  /** The glossary topic this is, when it has been made one. */
  id?: string;
  /** What the topic says about itself, sent with the name. */
  hint?: string;
  /** The person this name stands for (the source of their topic), such as 山田 for 山田太郎. */
  refersTo?: string | null;
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
  /** Something to look at in the translation, such as paragraphs that seem to be missing. */
  warning?: string | null;
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

/** A first guess at a name that is not in the glossary yet: what kind it is, and its English form where the dictionary gives one. */
export function nameGuess(source: string, reading: readonly string[] | undefined): { kind: NameKind; english: string; reading: string } {
  const kind = guessKind(source);
  return { kind, english: englishFor(kind, reading), reading: readingLetters(reading) };
}

const namesOf = (n: { source: string; aliases: readonly string[] }): string[] => [n.source, ...n.aliases];

/** The line that ended the block before was said by `before`, and `other` is the one they were talking with. */
export interface Carry {
  before: string;
  other: string | null;
}

export interface InterpretInput {
  passage: string;
  /** Names found in the passage without a model. */
  candidates: readonly string[];
  readings: Readonly<Record<string, readonly string[]>>;
  glossary: readonly KnownName[];
  /** The conversation going on at the end of the block before this one, if there is one. */
  carry?: Carry | null;
  /** Who told the block before this one (the source of the name), so the narrator carries on until the user says it changed. */
  narrator?: string | null;
}

/** Who says each line of the passage, for the people in `names` and the narrator. */
export function labelLines(passage: string, names: readonly GuidedName[], narrator: string | null, narratorWord: string | null, carry: Carry | null = null, preset: readonly (string | null)[] = []): GuidedLine[] {
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
  // A conversation carried on from the block before: its last line was said by `before`, and the other one speaks next.
  const turn = carry && carry.other && speakers.some((s) => s.id === carry.before) && speakers.some((s) => s.id === carry.other) ? { before: carry.before, pair: [carry.before, carry.other] as const } : null;
  if (speakers.length < 2 && !turn) return unlabeled;
  // What the user already set stays, and the rules work from it.
  let who: (string | null)[] = quotes.map((q, i) => preset[i] ?? speakerByForm(passage, q, speakers, quotes));
  // A line that names one of two people as spoken to is said by the other.
  quotes.forEach((q, i) => {
    if (who[i] !== null || speakers.length !== 2) return;
    const left = speakers.filter((s) => !addressedIn(q.text, speakers).has(s.id));
    if (left.length === 1) who[i] = left[0]!.id;
  });
  who = takeTurns(passage, quotes, who, speakers, turn);
  return quotes.map((q, i) => ({ text: q.text, speaker: who[i] ?? null }));
}

/** Reads a block into what the user is shown to check. */
export function interpretPassage(input: InterpretInput): Interpretation {
  const { passage } = input;
  const names: GuidedName[] = [];
  const taken = (s: string) => names.some((n) => namesOf(n).includes(s));

  for (const k of input.glossary) {
    // A name that is part of a longer one counts only where it stands on its own (山田 in 「山田、…」, not in 山田太郎).
    const sources = input.glossary.map((e) => e.source);
    if (namesOf(k).some((n) => withoutLongerNames(passage, n, sources).includes(n))) names.push({ source: k.source, english: k.english, kind: k.kind, aliases: [...k.aliases], reading: readingLetters(input.readings[k.source]), known: true, gender: k.gender ?? null });
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
  // The narrator carries on from the block before, and can be changed on any block. They speak and act in a block told as "I"
  // even when the block never writes the name.
  const narratorEntry = input.narrator ? input.glossary.find((k) => k.source === input.narrator) : undefined;
  const narrator = input.narrator ?? null;
  if (narratorWord && narratorEntry && !names.some((n) => n.source === narratorEntry.source)) {
    names.push({ source: narratorEntry.source, english: narratorEntry.english, kind: narratorEntry.kind, aliases: [...narratorEntry.aliases], reading: readingLetters(input.readings[narratorEntry.source]), known: true, gender: narratorEntry.gender ?? null });
  }
  // The two of a conversation that carries on speak here even when the block does not write their names.
  for (const who of [input.carry?.before, input.carry?.other]) {
    const k = who ? input.glossary.find((e) => e.source === who) : undefined;
    if (k && !names.some((n) => n.source === k.source)) names.push({ source: k.source, english: k.english, kind: k.kind, aliases: [...k.aliases], reading: readingLetters(input.readings[k.source]), known: true, gender: k.gender ?? null });
  }
  // Where the text says it, a person who is not known to be one way or the other is that.
  for (const p of names.filter((n) => n.kind === "character" && !n.gender)) {
    p.gender = guessGender(passage, namesOf(p), names.filter((o) => o !== p && o.kind === "character").flatMap(namesOf));
  }
  return { names, narrator, narratorWord, lines: labelLines(passage, names, narrator, narratorWord, input.carry ?? null) };
}

const shorten = (text: string, n: number): string => (Array.from(text).length > n ? `${Array.from(text).slice(0, n).join("")}…` : text);

/** The notes sent with the block: who is telling it, and who says the lines that are known. */
export function notesFor(interp: Interpretation, only?: string): string[] {
  const english = (source: string): string => interp.names.find((n) => n.source === source)?.english || source;
  const notes: string[] = [];
  if (interp.narrator && interp.narratorWord) notes.push(`The narrator, who says ${interp.narratorWord} about himself or herself, is ${english(interp.narrator)}.`);
  for (const n of interp.names) if (n.kind === "character" && n.gender && n.english) notes.push(n.gender === "female" ? `${n.english} is a woman or girl (she/her).` : `${n.english} is a man or boy (he/him).`);
  for (const l of interp.lines) if (l.speaker && (only === undefined || only.includes(l.text))) notes.push(`The line ${shorten(l.text, 16)} is said by ${english(l.speaker)}.`);
  return notes;
}

/** The text with every longer name that contains `name` taken out, so what is left is where `name` stands on its own (山田 in 「山田、…」 but not in 山田太郎). */
export function withoutLongerNames(text: string, name: string, sources: readonly string[]): string {
  return sources
    .filter((s) => s.length > name.length && s.includes(name))
    .sort((x, y) => y.length - x.length)
    .reduce((rest, s) => rest.split(s).join("\u0000"), text);
}

/**
 * The glossary entries sent with the block: every name that has an English form and appears in it. A short name that is part of
 * a longer one (山田 in 山田太郎) is sent only when it stands on its own somewhere, with a note saying that is when it applies, and is
 * not also listed as another way to write the longer name.
 */
export function glossaryFor(interp: Interpretation, only?: string): { source: string; target: string; note?: string; aliases?: string[] }[] {
  const sources = interp.names.map((n) => n.source);
  return interp.names
    .filter((n) => n.english.trim() !== "")
    .flatMap((n) => {
      const longer = sources.filter((s) => s.length > n.source.length && s.includes(n.source));
      const aliases = n.aliases.filter((a) => !sources.includes(a));
      if (only !== undefined) {
        const alone = withoutLongerNames(only, n.source, sources);
        if (![n.source, ...aliases].some((s) => (s === n.source ? alone : only).includes(s))) return [];
      }
      const target = n.refersTo ? interp.names.find((o) => o.source === n.refersTo) : undefined;
      const stands = target ? `a name for ${target.english.trim() !== "" ? target.english.trim() : target.source}` : "";
      const note = [stands, n.hint?.trim() ?? "", longer.length > 0 ? `when it stands on its own, not as part of ${longer.join(" or ")}` : ""].filter((x) => x !== "").join("; ");
      return [{ source: n.source, target: n.english.trim(), ...(note !== "" ? { note } : {}), ...(aliases.length > 0 ? { aliases } : {}) }];
    });
}

/** Pieces of a block for translating one at a time, so that a small model does not skip or cut off the end of a long one. Paragraphs are never split. */
export function splitPieces(text: string, tokensPerPiece: number, count: (s: string) => number): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    current.push(line);
    if (line.trim() !== "" && count(current.join("\n")) >= tokensPerPiece) {
      pieces.push(current.join("\n").trim());
      current = [];
    }
  }
  const rest = current.join("\n").trim();
  if (rest !== "") pieces.push(rest);
  return pieces;
}

/** How many paragraphs (non-empty lines) a text has. */
export const paragraphCount = (text: string): number => text.split(/\r?\n/).filter((l) => l.trim() !== "").length;

/** The last `lines` lines of a text, but never more than `maxChars` characters. */
export function lastLines(text: string, lines: number, maxChars: number): string {
  const parts = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  let out = parts.slice(-lines).join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}
