/** A glossary line: how a name or term should be translated. */
export interface GlossaryEntry {
  source: string;
  target: string;
  note?: string;
  /** Other ways the same word is written in the text. */
  aliases?: string[];
}

/** The accepted ways to write a term: the first is the preferred one. */
export const targetVariants = (target: string): string[] =>
  target
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);

type GlossaryItem = { source: string; target: string; note?: string | undefined; aliases?: string[] | undefined };

/** The glossary lines the model reads: the English name to use for each word that has one. Notes about words are separate (see wordNoteLines). */
export function glossaryLines(glossary: readonly GlossaryItem[]): string[] {
  return glossary.flatMap((g) => {
    const [first, ...others] = targetVariants(g.target);
    if (first === undefined) return [];
    return [`- ${[g.source, ...(g.aliases ?? [])].join(" / ")} => ${first}${others.length > 0 ? ` (or ${others.join(" / ")})` : ""}`];
  });
}

/** The notes about words, one line each, for a section of their own: they are instructions, not names, and are read as such there. */
export function wordNoteLines(glossary: readonly GlossaryItem[]): string[] {
  return glossary.filter((g) => g.note).map((g) => `- ${g.source}: ${g.note}`);
}

