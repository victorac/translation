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

const OPEN = "[[HERE]]";
const CLOSE = "[[/HERE]]";
const CONTEXT_LABEL = "CONTEXT (the end of the block before; reference only, do not translate):";

type GlossaryItem = { source: string; target: string; note?: string | undefined; aliases?: string[] | undefined };

/**
 * The instruction for translating one paragraph of a block. The paragraph is translated into an empty place in the translation so
 * far, so the model has the paragraphs around it to fit in with. The translation style is added as guidance for tone and wording.
 */
export function paragraphSystem(styleGuidance: string, sourceLanguage: string, targetLanguage: string): string {
  return [
    `You translate a story from ${sourceLanguage} into ${targetLanguage}, one paragraph at a time. The user message has labelled sections: NOTES (background about the story and its people; do not translate it), GLOSSARY (the ${targetLanguage} names to use), WORD NOTES (instructions about particular words; follow them), the ${sourceLanguage} text around the paragraph (for reference only), TRANSLATION SO FAR, which has an empty place between ${OPEN} and ${CLOSE}, and the ${sourceLanguage} PARAGRAPH TO TRANSLATE.`,
    `Style of the whole translation (it applies to tone and wording only; for this task follow the instructions below):\n${styleGuidance}`,
    `Your task: translate the paragraph into the empty place, so that it fits the translation before and after it. Translate all of it and only it. Use the names from GLOSSARY exactly as written and follow WORD NOTES. Do not omit or sanitize anything, and do not add comments.`,
    `Reply with the translation of the paragraph between ${OPEN} and ${CLOSE}, and nothing else.`,
  ]
    .filter((x) => x !== "")
    .join("\n\n");
}

/** What the request for one paragraph is made of. */
export interface ParagraphRequest {
  glossary: readonly GlossaryItem[];
  notes: readonly string[];
  sourceLanguage: string;
  /** The end of the block before, when this is the first paragraph of a block. */
  previous: { source: string; translation: string } | null;
  /** The source paragraphs around this one (those in the window), and this one. */
  sourceBefore: readonly string[];
  paragraph: string;
  sourceAfter: readonly string[];
  /** What is translated already of the paragraphs before and after (the ones after only when a paragraph is written again). */
  translatedBefore: readonly string[];
  translatedAfter: readonly string[];
  /** A version the user did not accept, shown only when the model gave it back unchanged. */
  rejected?: string | undefined;
}

export function paragraphMessage(r: ParagraphRequest): string {
  const parts: string[] = [];
  if (r.notes.length > 0) parts.push(`${NOTES_LABEL}\n${r.notes.map((n) => `- ${n}`).join("\n")}`);
  const lines = glossaryLines(r.glossary);
  if (lines.length > 0) parts.push(`${GLOSSARY_LABEL}\n${lines.join("\n")}`);
  const wordNotes = wordNoteLines(r.glossary);
  if (wordNotes.length > 0) parts.push(`${WORD_NOTES_LABEL}\n${wordNotes.join("\n")}`);
  if (r.previous) parts.push(`${CONTEXT_LABEL}\n${r.previous.source}\n\n${r.previous.translation}`);
  const around = [...r.sourceBefore, r.paragraph, ...r.sourceAfter];
  if (around.length > 1) parts.push(`${r.sourceLanguage.toUpperCase()} TEXT AROUND THE PARAGRAPH (reference only; the paragraph is one of these):\n${around.join("\n\n")}`);
  const before = r.translatedBefore.filter((t) => t.trim() !== "");
  const after = r.translatedAfter.filter((t) => t.trim() !== "");
  parts.push(`TRANSLATION SO FAR:\n${[...before, `${OPEN}${CLOSE}`, ...after].join("\n\n")}`);
  if (r.rejected) parts.push(`REJECTED VERSION (the user did not accept it; write a different translation, do not copy its wording):\n${r.rejected}`);
  parts.push(`${r.sourceLanguage.toUpperCase()} PARAGRAPH TO TRANSLATE:\n${r.paragraph}`);
  parts.push(`Translate that paragraph into the empty place between ${OPEN} and ${CLOSE}.`);
  return parts.join("\n\n");
}

/** What the model wrote: what is between the markers when it wrote them, else its whole reply. Null when there is nothing. */
export function answerOf(reply: string): string | null {
  const open = reply.indexOf(OPEN);
  const close = reply.lastIndexOf(CLOSE);
  let t = open >= 0 && close > open ? reply.slice(open + OPEN.length, close) : reply.split(OPEN).join("").split(CLOSE).join("");
  t = t.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  return t === "" ? null : t;
}

/** The glossary names (as `word => English`) that the source paragraph has but the translation of it does not use. */
export function missingNames(glossary: readonly GlossaryItem[], source: string, translation: string): string[] {
  const hay = translation.toLocaleLowerCase();
  return glossary
    .filter((g) => [g.source, ...(g.aliases ?? [])].some((n) => source.includes(n)))
    .flatMap((g) => {
      const wanted = targetVariants(g.target);
      return wanted.length > 0 && !wanted.some((w) => hay.includes(w.toLocaleLowerCase())) ? [`${g.source} => ${wanted[0]}`] : [];
    });
}

/** The text of a block's translation: the paragraphs that have one, one after the other with a blank line between. */
export const joinParts = (parts: readonly string[]): string =>
  parts
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .join("\n\n");
