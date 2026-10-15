import {
  glossaryLines,
  targetVariants,
  wordNoteLines,
} from "./glossary.js";
import {
  GLOSSARY_LABEL,
  NOTES_LABEL,
  WORD_NOTES_LABEL,
} from "./labels.js";

const CONTEXT_LABEL = "CONTEXT (the paragraphs before this one, with their translations; reference only, do not translate):";
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

type GlossaryItem = { source: string; target: string; note?: string | undefined; aliases?: string[] | undefined };

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
    `You translate a story from ${sourceLanguage} into ${targetLanguage}, one paragraph at a time. The user message has labelled sections: NOTES (background about the story and its people; do not translate it), GLOSSARY (the ${targetLanguage} names to use), WORD NOTES (instructions about particular words; follow them), CONTEXT and NEXT (the paragraphs around the one to translate, with their translations when there are any; for reference only, never translate them), and the ${sourceLanguage.toUpperCase()} PARAGRAPH TO TRANSLATE.`,
    `Style of the whole translation (it applies to tone and wording only; for this task follow the instructions below):\n${styleGuidance}`,
    `Your task: translate the paragraph, all of it and only it, so that it fits what comes before. Use the names from GLOSSARY exactly as written and follow WORD NOTES. Do not omit or sanitize anything, and do not add comments.`,
    `Reply with the translation of the paragraph only, as one paragraph: no labels, and nothing about the other paragraphs.`,
  ].join("\n\n");
}

/** What the request for one paragraph is made of. */
export interface ParagraphRequest {
  glossary: readonly GlossaryItem[];
  notes: readonly string[];
  sourceLanguage: string;
  targetLanguage: string;
  /** The paragraphs before this one with their translations, oldest first (for the first paragraph of a block: the end of the block before). */
  before: readonly Pair[];
  paragraph: string;
  /** The paragraphs after this one, with their translations when they have one. */
  next: readonly { source: string; translation: string | null }[];
  /** A version the user did not accept, shown only when the model gave it back unchanged. */
  rejected?: string | undefined;
}

export function paragraphMessage(r: ParagraphRequest): string {
  const from = r.sourceLanguage.toUpperCase();
  const to = r.targetLanguage.toUpperCase();
  const pair = (source: string, translation: string | null) => `${from}: ${source}${translation ? `\n${to}: ${translation}` : ""}`;
  const parts: string[] = [];
  if (r.notes.length > 0) parts.push(`${NOTES_LABEL}\n${r.notes.map((n) => `- ${n}`).join("\n")}`);
  const lines = glossaryLines(r.glossary);
  if (lines.length > 0) parts.push(`${GLOSSARY_LABEL}\n${lines.join("\n")}`);
  const wordNotes = wordNoteLines(r.glossary);
  if (wordNotes.length > 0) parts.push(`${WORD_NOTES_LABEL}\n${wordNotes.join("\n")}`);
  if (r.before.length > 0) parts.push(`${CONTEXT_LABEL}\n${r.before.map((p) => pair(p.source, p.translation)).join("\n\n")}`);
  if (r.next.length > 0) parts.push(`${NEXT_LABEL}\n${r.next.map((p) => pair(p.source, p.translation)).join("\n\n")}`);
  if (r.rejected) parts.push(`REJECTED VERSION (the user did not accept it; write a different translation, do not copy its wording):\n${r.rejected}`);
  parts.push(`${from} PARAGRAPH TO TRANSLATE:\n${r.paragraph}`);
  parts.push(`Translate that paragraph into ${r.targetLanguage}. Reply with its translation only, as one paragraph.`);
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
 * in the paragraph only as a short form of the name (an alias) may be translated as part of the name: "Rein" for "Rein Garland".
 */
export function missingNames(glossary: readonly GlossaryItem[], source: string, translation: string): string[] {
  const hay = translation.toLocaleLowerCase();
  return glossary.flatMap((g) => {
    const wanted = targetVariants(g.target);
    if (wanted.length === 0) return [];
    const full = source.includes(g.source);
    if (!full && !(g.aliases ?? []).some((n) => source.includes(n))) return [];
    const ok = full
      ? wanted.some((w) => hay.includes(w.toLocaleLowerCase()))
      : wanted.some((w) => w.split(/\s+/).some((word) => word.length >= 2 && hay.includes(word.toLocaleLowerCase())));
    return ok ? [] : [`${g.source} => ${wanted[0]}`];
  });
}

/** The text of a block's translation: the paragraphs that have one, one after the other with a blank line between. */
export const joinParts = (parts: readonly string[]): string =>
  parts
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .join("\n\n");
