import {
  glossaryLines,
  targetVariants,
  wordNoteLines,
} from "./glossary.js";
import {
  GLOSSARY_LABEL,
  NOTES_LABEL,
  TERMS_LABEL,
  WORD_NOTES_LABEL,
} from "./labels.js";

const CONTEXT_LABEL = "CONTEXT (the paragraphs before this one, with their translations; reference only, do not translate):";
const UNSURE_LABEL = "LIKELY NAMES (a likely {language} name, not confirmed: use it unless the story shows it is wrong, and write it the same way every time):";
const EXAMPLES_LABEL = "EXAMPLES (paragraphs elsewhere in the story as the user translated them, to show how the TERMS are written there; reference only, do not translate):";
const NEXT_LABEL = "NEXT (the paragraphs after this one, so that you know where the story goes; reference only, do not translate):";

/** One paragraph (a non-empty line) of a text, with where it stands in it. */
export interface Paragraph {
  start: number;
  end: number;
  text: string;
}

export function paragraphsOf(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const lead = line.length - line.trimStart().length;
    const t = line.trim();
    if (t !== "") out.push({ start: at + lead, end: at + lead + t.length, text: t });
    at += line.length + 1;
  }
  return out;
}

type GlossaryItem = { source: string; target: string; note?: string | undefined; aliases?: string[] | undefined; term?: boolean | undefined };

/** A paragraph and its translation. */
export interface Pair {
  source: string;
  translation: string;
}

/**
 * The instruction for translating one paragraph of a story. Only the paragraph is translated: the paragraphs around it are shown for
 * reference. The translation style is added as guidance for tone and wording.
 */
export function paragraphSystem(styleGuidance: string, sourceLanguage: string, targetLanguage: string): string {
  return [
    `You translate a story from ${sourceLanguage} into ${targetLanguage}, one paragraph at a time. The user message has labelled sections: NOTES (background about the story and its people; do not translate it), NAMES (the ${targetLanguage} names, to write exactly), TERMS (the ${targetLanguage} words to use for words of the story), WORD NOTES (instructions about particular words; follow them), LIKELY NAMES (names that are not confirmed), EXAMPLES (paragraphs the user translated, showing how the terms are written), CONTEXT and NEXT (the paragraphs around the one to translate, with their translations when there are any; for reference only, never translate them), and the ${sourceLanguage.toUpperCase()} PARAGRAPH TO TRANSLATE.`,
    `Style of the whole translation (it applies to tone and wording only; for this task follow the instructions below):\n${styleGuidance}`,
    `Your task: translate the paragraph, all of it and only it, so that it fits what comes before. Write the NAMES exactly as given, use the words from TERMS, and follow WORD NOTES. Do not omit or sanitize anything, and do not add comments.`,
    `Reply with the translation of the paragraph only, as one paragraph: no labels, and nothing about the other paragraphs.`,
  ].join("\n\n");
}

/** What the request for one paragraph is made of. */
export interface ParagraphRequest {
  glossary: readonly GlossaryItem[];
  notes: readonly string[];
  sourceLanguage: string;
  targetLanguage: string;
  /** Dictionary readings of names that have no confirmed English name: told as how the name sounds, not as the name to use. */
  suggestions?: readonly { source: string; suggestion: string; aliases?: string[] | undefined }[];
  /** The paragraphs before this one with their translations, oldest first (for the first paragraph of a block: the end of the block before). */
  before: readonly Pair[];
  paragraph: string;
  /** The glossary entries the translation must use (the paragraph's own), repeated in the last line where a small model reads them best. */
  required?: readonly GlossaryItem[] | undefined;
  /** Paragraphs from elsewhere that the user translated, with a term of this paragraph in them: how the user writes it in a sentence. */
  examples?: readonly Pair[] | undefined;
  /** The paragraphs after this one, with their translations when they have one. */
  next: readonly { source: string; translation: string | null }[];
  /** A version the user did not accept, shown only when the model gave it back unchanged, or when an alternative is asked for. */
  rejected?: string | undefined;
  /** An alternative was asked for: the model is told to write it in a different way from `rejected`. */
  different?: boolean | undefined;
}

export function paragraphMessage(r: ParagraphRequest): string {
  const from = r.sourceLanguage.toUpperCase();
  const to = r.targetLanguage.toUpperCase();
  const pair = (source: string, translation: string | null) => `${from}: ${source}${translation ? `\n${to}: ${translation}` : ""}`;
  const parts: string[] = [];
  if (r.notes.length > 0) parts.push(`${NOTES_LABEL}\n${r.notes.map((n) => `- ${n}`).join("\n")}`);
  // A name is copied as it is; a term is a word whose form follows the sentence (an enchanter, Enchanters, the title "Expelled Enchanter").
  const names = glossaryLines(r.glossary.filter((g) => !g.term));
  if (names.length > 0) parts.push(`${GLOSSARY_LABEL}\n${names.join("\n")}`);
  const terms = glossaryLines(r.glossary.filter((g) => g.term));
  if (terms.length > 0) parts.push(`${TERMS_LABEL}\n${terms.join("\n")}`);
  const wordNotes = wordNoteLines(r.glossary);
  if (wordNotes.length > 0) parts.push(`${WORD_NOTES_LABEL}\n${wordNotes.join("\n")}`);
  // A dictionary's reading of a name in kanji is usually its spelling, but a name can be read in more than one way: told as likely, not as certain.
  const unsure = (r.suggestions ?? []).map((g) => `- ${[g.source, ...(g.aliases ?? [])].join(" / ")} => probably ${g.suggestion}`);
  if (unsure.length > 0) parts.push(`${UNSURE_LABEL.replace("{language}", r.targetLanguage)}\n${unsure.join("\n")}`);
  if ((r.examples ?? []).length > 0) parts.push(`${EXAMPLES_LABEL}\n${r.examples!.map((p) => pair(p.source, p.translation)).join("\n\n")}`);
  if (r.before.length > 0) parts.push(`${CONTEXT_LABEL}\n${r.before.map((p) => pair(p.source, p.translation)).join("\n\n")}`);
  if (r.next.length > 0) parts.push(`${NEXT_LABEL}\n${r.next.map((p) => pair(p.source, p.translation)).join("\n\n")}`);
  if (r.rejected) parts.push(`REJECTED VERSION (the user did not accept it; write a different translation, do not copy its wording):\n${r.rejected}`);
  parts.push(`${from} PARAGRAPH TO TRANSLATE:\n${r.paragraph}`);
  // For an alternative the model is told outright to write something else: shown the version alone, it copies it.
  const how = r.rejected && r.different ? ` in a clearly different way from the REJECTED VERSION: other words and another sentence structure, with the same meaning` : "";
  const first = (items: readonly GlossaryItem[]) => items.map((g) => targetVariants(g.target)[0]).filter((t): t is string => !!t);
  const mustNames = first((r.required ?? []).filter((g) => !g.term));
  const mustTerms = first((r.required ?? []).filter((g) => g.term));
  const use = `${mustNames.length > 0 ? ` Use these names: ${mustNames.join(", ")}.` : ""}${mustTerms.length > 0 ? ` Use these words: ${mustTerms.join(", ")}.` : ""}`;
  parts.push(`Translate that paragraph into ${r.targetLanguage}${how}.${use} Reply with its translation only, as one paragraph.`);
  return parts.join("\n\n");
}

/** What the model wrote, without a code fence or a label such as "English:" in front. Null when there is nothing. */
export function answerOf(reply: string, targetLanguage: string): string | null {
  let t = reply.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  const label = new RegExp(`^${targetLanguage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i");
  t = t.replace(label, "").trim();
  return t === "" ? null : t;
}

/**
 * The glossary names (as `word => English`) that the source paragraph has but the translation of it does not use. A word that stands
 * in the paragraph only as a short form of the name (an alias) may be translated as part of the name: "Anna" for "Anna Smith".
 */
export function missingNames(glossary: readonly GlossaryItem[], source: string, translation: string): string[] {
  const hay = translation.toLocaleLowerCase();
  const names = glossary.flatMap((g) => [g.source, ...(g.aliases ?? [])]);
  // Where a word stands on its own, not inside a longer word of the glossary (灯 in 灯籠祭).
  const stands = (word: string): boolean =>
    names
      .filter((n) => n.length > word.length && n.includes(word))
      .reduce((rest, n) => rest.split(n).join("\u0000"), source)
      .includes(word);
  return glossary.flatMap((g) => {
    const wanted = targetVariants(g.target);
    if (wanted.length === 0) return [];
    const full = stands(g.source);
    if (!full && !(g.aliases ?? []).some(stands)) return [];
    const ok = full
      ? wanted.some((w) => hay.includes(w.toLocaleLowerCase()))
      : wanted.some((w) => w.split(/\s+/).some((word) => word.length >= 2 && hay.includes(word.toLocaleLowerCase())));
    return ok ? [] : [`${g.source} => ${wanted[0]}`];
  });
}

