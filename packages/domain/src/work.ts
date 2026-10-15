import {
  chunkSource,
} from "./chunker.js";
import {
  paragraphsOf,
} from "./paragraphs.js";
import {
  splitSentences,
  addressedIn,
  findQuotes,
  nameFromReadings,
  romanize,
  speakerByForm,
  takeTurns,
  type Speaker,
} from "./steps.js";

/**
 * The work on a document: the text is read once for its words (names and terms) and for who says each line of speech, the user
 * checks that, and then the paragraphs are translated one after the other. Everything here is decided by rules and the
 * dictionary, never by guessing.
 */

export type NameKind = "character" | "family" | "place" | "organization" | "term";

/** A word of the text that has a translation of its own: a name, a place, a term. */
export interface Word {
  source: string;
  /** The name in the translation. Empty when it is not known and the user has to write it. */
  english: string;
  kind: NameKind;
  aliases: string[];
  /** How the dictionary reads it, in letters, to help the user write the English name. */
  reading: string;
  /** True when the name is already in the project's glossary and accepted. */
  known: boolean;
  /** True for a word found in the text that is not in the knowledge base yet: it is added when the text is translated. */
  draft?: boolean;
  /**
   * What the app or the model thinks a field is, not yet confirmed by the user: by field (`english`, `gender`, or the key of another
   * attribute), a list of one value. A suggestion is shown pre-filled and marked, is told to the model only as a suggestion, and
   * becomes the value when the user accepts it or writes the field themselves.
   */
  suggestions?: Record<string, string[]>;
  /** The suggested English name is told to the model, in the way a dictionary's reading is (as how the name sounds, not a spelling it must use): the dictionary's own, or what the user wrote as a suggestion. */
  fromReading?: boolean;
  /** The user wrote the suggested English name: reading the translation does not replace it. */
  written?: boolean;
  /** False when the user chose to ignore this word: it is not sent and not added to the knowledge base. */
  use?: boolean;
  /** The glossary topic this is, when it has been made one. */
  id?: string;
  /** What the topic says about itself, sent with the name. */
  hint?: string;
  /** The topic's attributes (gender, family...), as the glossary has them now. */
  attrs?: Record<string, string[]>;
  /** The person this name stands for (the source of their topic), such as 山田 for 山田太郎. */
  refersTo?: string | null;
  /** For a person: how the text refers to them, when it is clear. */
  gender?: Gender | null;
}

export type Gender = "female" | "male";

/** One line of speech (a 「…」 quotation, or a 『…』 line of its own) and who says it. */
export interface WorkLine {
  /** The paragraph it stands in (counted from 0). */
  paragraph: number;
  text: string;
  /** The source of the word of the person who says it, as the user set it; null when they have not. */
  speaker: string | null;
  /** Who the rules or the model think says it, while the user has not set it. */
  suggested?: string | null;
}

/** One paragraph (non-empty line) of the source and its translation. */
export interface WorkParagraph {
  text: string;
  /** Empty until it is translated. */
  translation: string;
  /** Something to look at in the translation, such as a glossary name it does not use. */
  issue?: string | null;
}

/** Everything about one document's translation. */
export interface Work {
  documentId: string;
  /** The text the work was made from, so a change in the source is noticed. */
  source: string;
  words: Word[];
  lines: WorkLine[];
  paragraphs: WorkParagraph[];
  /** Why the last attempt to translate failed. */
  error?: string | null;
  /** While the translation is being read for suggestions: how far it has got. Never saved. */
  reading?: { done: number; total: number } | null;
  /** What the last reading of the translation could not suggest, and why, in words for the user. Never saved. */
  misses?: string[];
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
export function englishFor(kind: NameKind, reading: readonly string[] | undefined, source = ""): string {
  // A name with no kanji gets no guess: in katakana the dictionary only spells out the sounds (Sumisu for Smith), which is not how the name is written in English.
  if (source !== "" && !/\p{Script=Han}/u.test(source)) return "";
  if (!reading || (kind !== "character" && kind !== "family")) return "";
  return nameFromReadings(reading, kind === "family") ?? "";
}

/**
 * What kind of name a word in this passage probably is. A word set in 『…』 is a term, or an organization or a place when the
 * word before it says so (the guild 『…』); a katakana word without a middle dot is a term; otherwise it is judged by how it ends.
 */
export function guessKindIn(passage: string, source: string): NameKind {
  const quoted = passage.indexOf(`『${source}』`);
  if (quoted >= 0) {
    const before = passage.slice(Math.max(0, quoted - 8), quoted);
    if (/(ギルド|クラン|パーティ|団|軍|組織|商会|教団|学園|学院)$/.test(before)) return "organization";
    if (/(国|王国|帝国|街|町|村|都|城|島)$/.test(before)) return "place";
    return "term";
  }
  if (/^[\u30A1-\u30FA\u30FC]+$/.test(source)) return "term";
  return guessKind(source);
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
  return { kind, english: englishFor(kind, reading, source), reading: readingLetters(reading) };
}

const namesOf = (n: { source: string; aliases: readonly string[] }): string[] => [n.source, ...n.aliases];

/** A word that is already in the glossary, or a draft word the user has been working on: reading starts from it. */
export interface KnownWord {
  source: string;
  english: string;
  kind: NameKind;
  aliases: string[];
  gender?: Gender | null;
  /** True for a draft word: it is still not in the knowledge base. */
  draft?: boolean;
  attrs?: Record<string, string[]>;
  /** What the user set on a draft word, kept when the text is read again. */
  hint?: string;
  use?: boolean;
  suggestions?: Record<string, string[]>;
  fromReading?: boolean;
  written?: boolean;
}

export interface ReadInput {
  /** The whole text. */
  text: string;
  /** Names found in the text without a model. */
  candidates: readonly string[];
  readings: Readonly<Record<string, readonly string[]>>;
  glossary: readonly KnownWord[];
}

/** The conversation going on at the end of the part before: its last line was said by `before`, and `other` is the one they were talking with. */
export interface Carry {
  before: string;
  other: string | null;
}

/** Who says each line of a passage, for the people in `words`. A conversation carried on from before the passage is given in `carry`. */
export function labelLines(passage: string, words: readonly Word[], carry: Carry | null = null, preset: readonly (string | null)[] = []): { text: string; speaker: string | null; start: number }[] {
  const quotes = findQuotes(passage);
  const speakers: Speaker[] = words
    .filter((n) => n.kind === "character" && n.use !== false)
    .map((n) => ({ id: n.source, label: n.english || n.source, names: namesOf(n) }));
  const unlabeled = quotes.map((q) => ({ text: q.text, speaker: null as string | null, start: q.start }));
  // A conversation carried on from before: its last line was said by `before`, and the other one speaks next.
  const turn = carry && carry.other && speakers.some((s) => s.id === carry.before) && speakers.some((s) => s.id === carry.other) ? { before: carry.before, pair: [carry.before, carry.other] as const } : null;
  if (speakers.length < 2 && !turn) return unlabeled.map((l, i) => ({ ...l, speaker: preset[i] ?? null }));
  // What the user already set stays, and the rules work from it.
  let who: (string | null)[] = quotes.map((q, i) => preset[i] ?? speakerByForm(passage, q, speakers, quotes));
  // A line that names one of two people as spoken to is said by the other.
  quotes.forEach((q, i) => {
    if (who[i] !== null || speakers.length !== 2) return;
    const left = speakers.filter((s) => !addressedIn(q.text, speakers).has(s.id));
    if (left.length === 1) who[i] = left[0]!.id;
  });
  who = takeTurns(passage, quotes, who, speakers, turn);
  return quotes.map((q, i) => ({ text: q.text, speaker: who[i] ?? null, start: q.start }));
}

/**
 * Who says each line of the whole text. The rules (who is named beside a line, two people taking turns) work on a stretch of text
 * with a few people in it, so the text is gone through in stretches, each with the conversation that was going on at the end of the one
 * before. `confirmed` is what the user already set, by line: it stays, and the rules work from it. What the rules work out for the other
 * lines is only a suggestion.
 */
export function labelDocument(text: string, words: readonly Word[], confirmed: readonly (string | null)[] = []): WorkLine[] {
  const paragraphs = paragraphsOf(text);
  const paragraphAt = (offset: number): number => {
    let lo = 0;
    let hi = paragraphs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (paragraphs[mid]!.start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  };
  const sources = words.map((w) => w.source);
  const out: WorkLine[] = [];
  let carry: Carry | null = null;
  for (const chunk of chunkSource(text, { targetTokens: 600, maxTokens: 900 })) {
    const passage = text.slice(chunk.startOffset, chunk.endOffset);
    // The people of this stretch: those it writes, and the two of a conversation that carries on into it.
    const here = words.filter((w) => w.kind === "character" && (occurrencesOf(passage, namesOf(w), sources).length > 0 || w.source === carry?.before || w.source === carry?.other));
    const lines = labelLines(passage, here, carry, confirmed.slice(out.length));
    for (const l of lines) {
      const set = confirmed[out.length] ?? null;
      out.push({ paragraph: paragraphAt(chunk.startOffset + l.start), text: l.text, speaker: set, suggested: set === null ? l.speaker : null });
    }
    // Only when the stretch ended on a line of speech whose speaker is known does its conversation carry on.
    const last = lines.at(-1);
    const lastParagraph = passage.split(/\r?\n/).filter((l) => l.trim() !== "").at(-1) ?? "";
    carry = last?.speaker && /^[「『]/.test(lastParagraph.trim()) ? { before: last.speaker, other: [...lines].reverse().find((l) => l.speaker && l.speaker !== last.speaker)?.speaker ?? null } : null;
  }
  return out;
}

/** Reads the text into the words the user is shown to check. */
export function readWords(input: ReadInput): Word[] {
  const passage = input.text;
  const names: Word[] = [];
  const taken = (s: string) => names.some((n) => namesOf(n).includes(s));
  const from = (k: KnownWord): Word => ({
    source: k.source,
    english: k.english,
    kind: k.kind,
    aliases: [...k.aliases],
    reading: readingLetters(input.readings[k.source]),
    known: !k.draft,
    draft: k.draft === true,
    ...(k.attrs ? { attrs: k.attrs } : {}),
    ...(k.hint ? { hint: k.hint } : {}),
    ...(k.use === false ? { use: false } : {}),
    ...(k.suggestions && Object.keys(k.suggestions).length > 0 ? { suggestions: k.suggestions } : {}),
    ...(k.fromReading ? { fromReading: true } : {}),
    ...(k.written ? { written: true } : {}),
    gender: k.gender ?? null,
  });

  const sources = input.glossary.map((e) => e.source);
  for (const k of input.glossary) {
    // A name that is part of a longer one counts only where it stands on its own (山田 in 「山田、…」, not in 山田太郎).
    if (namesOf(k).some((n) => withoutLongerNames(passage, n, sources).includes(n))) names.push(from(k));
  }
  // The longest candidates first, so a short one inside a longer one is not taken as a name of its own.
  const rest = [...new Set(input.candidates)].filter((c) => !taken(c)).sort((a, b) => b.length - a.length);
  for (const c of rest) {
    if (taken(c)) continue;
    if (names.some((n) => n.source.length > c.length && n.source.includes(c) && passage.split(n.source).join("").indexOf(c) < 0)) continue;
    const kind = guessKindIn(passage, c);
    const reading = input.readings[c];
    // What the dictionary reads it as is a suggestion, not the name.
    const guess = englishFor(kind, reading, c);
    names.push({ source: c, english: "", kind, aliases: [], reading: readingLetters(reading), known: false, draft: true, gender: null, attrs: {}, ...(guess !== "" ? { suggestions: { english: [guess] }, fromReading: true } : {}) });
  }
  // A name with a middle dot is written by one of its parts alone as well (ジョン for ジョン・スミス): that is the same person.
  for (const p of names.filter((n) => n.kind === "character" && n.source.includes("・"))) {
    for (const part of p.source.split("・").filter((x) => x.length >= 2)) {
      const other = names.findIndex((n) => n !== p && n.source === part);
      if (other >= 0) names.splice(other, 1);
      if (passage.split(p.source).join("|").includes(part) && !namesOf(p).includes(part)) p.aliases.push(part);
    }
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
  // Where the text says it, a person who is not known to be one way or the other is suggested to be that.
  for (const p of names.filter((n) => n.kind === "character" && !n.gender && !n.attrs?.["gender"]?.length)) {
    const gender = guessGender(passage, namesOf(p), names.filter((o) => o !== p && o.kind === "character").flatMap(namesOf));
    if (gender && !p.suggestions?.["gender"]) p.suggestions = { ...(p.suggestions ?? {}), gender: [gender] };
  }
  return names;
}

const shorten = (text: string, n: number): string => (Array.from(text).length > n ? `${Array.from(text).slice(0, n).join("")}…` : text);

/** The notes sent with a paragraph: the gender of the people it names, and who says the lines in it, as the user confirmed them. */
export function notesFor(words: readonly Word[], lines: readonly WorkLine[], paragraph: { index: number; text: string }): string[] {
  const english = (source: string): string => words.find((n) => n.source === source)?.english || source;
  const notes: string[] = [];
  for (const n of words) {
    if (n.use === false || n.kind !== "character" || !n.gender || !n.english) continue;
    if (!occurrencesOf(paragraph.text, namesOf(n), words.map((w) => w.source)).length) continue;
    notes.push(n.gender === "female" ? `${n.english} is a woman or girl (she/her).` : `${n.english} is a man or boy (he/him).`);
  }
  for (const l of lines) if (l.speaker && l.paragraph === paragraph.index) notes.push(`The line ${shorten(l.text, 16)} is said by ${english(l.speaker)}.`);
  return notes;
}

/** The text with every longer name that contains `name` blanked out, letter for letter, so what is left is where `name` stands on its own (山 in 「山、…」 but not in 山田太郎) and positions still match the text. */
export function withoutLongerNames(text: string, name: string, sources: readonly string[]): string {
  return sources
    .filter((s) => s.length > name.length && s.includes(name))
    .sort((x, y) => y.length - x.length)
    .reduce((rest, s) => rest.split(s).join("\u0000".repeat(s.length)), text);
}

/** Where any of `names` stands on its own in the text, in order, without overlaps. `sources` are all the names of the glossary. */
export function occurrencesOf(text: string, names: readonly string[], sources: readonly string[]): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const name of names) {
    if (name === "") continue;
    const rest = withoutLongerNames(text, name, sources);
    for (let i = rest.indexOf(name); i >= 0; i = rest.indexOf(name, i + name.length)) found.push({ start: i, end: i + name.length });
  }
  found.sort((x, y) => x.start - y.start || y.end - x.end);
  let lastEnd = 0;
  return found.filter((r) => (r.start >= lastEnd ? ((lastEnd = r.end), true) : false));
}

/** The glossary entries whose name (or other way of writing it) stands in the text. */
export function glossaryHits<T extends { source: string; aliases: readonly string[] }>(text: string, glossary: readonly T[]): T[] {
  const sources = glossary.map((e) => e.source);
  return glossary.filter((e) => occurrencesOf(text, [e.source, ...e.aliases], sources).length > 0);
}

/**
 * The glossary entries sent with a paragraph: every word that has an English form (or a note) and stands in it. A short name that is
 * part of a longer one (山田 in 山田太郎) is sent only when it stands on its own there, with a note saying that is when it applies,
 * and is not also listed as another way to write the longer name.
 */
export function glossaryFor(words: readonly Word[], only?: string): { source: string; target: string; note?: string; aliases?: string[] }[] {
  const sources = words.map((n) => n.source);
  return words
    .filter((n) => (n.english.trim() !== "" || (n.hint ?? "").trim() !== "") && n.use !== false)
    .flatMap((n) => {
      const longer = sources.filter((s) => s.length > n.source.length && s.includes(n.source));
      const aliases = n.aliases.filter((a) => !sources.includes(a));
      if (only !== undefined) {
        const alone = withoutLongerNames(only, n.source, sources);
        if (![n.source, ...aliases].some((s) => (s === n.source ? alone : only).includes(s))) return [];
      }
      const target = n.refersTo ? words.find((o) => o.source === n.refersTo) : undefined;
      const stands = target ? `a name for ${target.english.trim() !== "" ? target.english.trim() : target.source}` : "";
      const note = [stands, n.hint?.trim() ?? "", longer.length > 0 ? `when it stands on its own, not as part of ${longer.join(" or ")}` : ""].filter((x) => x !== "").join("; ");
      return [{ source: n.source, target: n.english.trim(), ...(note !== "" ? { note } : {}), ...(aliases.length > 0 ? { aliases } : {}) }];
    });
}

/**
 * The words of a paragraph that have no confirmed English name but a dictionary reading (for a name in kanji) or a suggestion the user
 * wrote. It is told to the model as how the name sounds, not as a spelling. What the model itself wrote in an earlier translation is not sent back: it would keep a mistake in place.
 */
export function suggestionsFor(words: readonly Word[], only: string): { source: string; suggestion: string; aliases?: string[] }[] {
  const sources = words.map((n) => n.source);
  return words.flatMap((n) => {
    const suggestion = n.suggestions?.["english"]?.[0]?.trim();
    if (!suggestion || n.fromReading !== true || n.english.trim() !== "" || n.use === false) return [];
    // A dictionary reading helps with a name written in kanji, which the model cannot read. For a name in katakana it only spells out the
    // sounds (Sumisu for Smith) and the model would copy that: it is sent only when the user wrote it.
    if (n.written !== true && !/\p{Script=Han}/u.test(n.source)) return [];
    const aliases = n.aliases.filter((a) => !sources.includes(a));
    const alone = withoutLongerNames(only, n.source, sources);
    if (![n.source, ...aliases].some((x) => (x === n.source ? alone : only).includes(x))) return [];
    return [{ source: n.source, suggestion, ...(aliases.length > 0 ? { aliases } : {}) }];
  });
}

/**
 * The paragraphs of a new text with the work of the old: a paragraph whose text is the same as one before it (in the same order)
 * keeps its translation, and the others start again.
 */
export function syncParagraphs(old: readonly WorkParagraph[], text: string): WorkParagraph[] {
  const byText = new Map<string, number[]>();
  old.forEach((p, i) => byText.set(p.text, [...(byText.get(p.text) ?? []), i]));
  let last = -1;
  return paragraphsOf(text).map((p) => {
    const at = (byText.get(p.text) ?? []).find((i) => i > last);
    if (at === undefined) return { text: p.text, translation: "" };
    last = at;
    return { ...old[at]! };
  });
}
