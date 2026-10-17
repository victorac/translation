import {
  occurrencesOf,
  type Word,
} from "./work.js";

/**
 * Where the words of the glossary stand in the source and in the translation, to underline them: by kind (a colour each) and by
 * whether the English name is fixed (told to the model as the name to use) or only a suggestion.
 */
export interface EntryMark {
  start: number;
  end: number;
  /** The source of the word, which says which entry it is. */
  source: string;
  kind: string;
  /** An ignored word is still marked in the source (faintly), so it can be found and used again. */
  status: "fixed" | "suggested" | "ignored";
}

/** Fixed when the user (or the knowledge base) gave the English name; otherwise what is known of it is a suggestion. */
export const wordStatus = (w: Word): EntryMark["status"] => (w.use === false ? "ignored" : w.english.trim() !== "" ? "fixed" : "suggested");

/** The English name to look for in the translation: the fixed one, or else the suggested one. */
export const englishOf = (w: Word): string => (w.english.trim() !== "" ? w.english.trim() : (w.suggestions?.["english"]?.[0] ?? "").trim());

/** Keeps the first of marks that overlap, after putting the earliest (and of those the longest) first. */
function apart(marks: EntryMark[]): EntryMark[] {
  marks.sort((x, y) => x.start - y.start || y.end - x.end);
  let lastEnd = 0;
  return marks.filter((m) => (m.start >= lastEnd ? ((lastEnd = m.end), true) : false));
}

/**
 * Where each word stands in the source, the ignored ones too. A short name inside a longer word of the glossary (灯 in 灯籠祭) is not
 * marked there.
 */
export function sourceMarks(text: string, words: readonly Word[]): EntryMark[] {
  const sources = words.flatMap((w) => [w.source, ...w.aliases]);
  return apart(words.flatMap((w) => occurrencesOf(text, [w.source, ...w.aliases], sources).map((r) => ({ ...r, source: w.source, kind: w.kind, status: wordStatus(w) }))));
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PEOPLE = new Set(["character", "family"]);

/**
 * Where each word in use stands in a translation, by its English name: in any case (a term is written in lowercase in prose), as a
 * whole word, and for a word that is not a person, in the plural too. A longer name wins over a shorter one inside it.
 */
export function translationMarks(text: string, words: readonly Word[]): EntryMark[] {
  const marks: EntryMark[] = [];
  for (const w of words) {
    const english = englishOf(w);
    if (w.use === false || english === "") continue;
    const plural = PEOPLE.has(w.kind) ? "" : "(?:e?s)?";
    const find = new RegExp(`(?<![\\p{L}\\p{N}])${escape(english)}${plural}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(find)) marks.push({ start: m.index, end: m.index + m[0].length, source: w.source, kind: w.kind, status: wordStatus(w) });
  }
  return apart(marks);
}
