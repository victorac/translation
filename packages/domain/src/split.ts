import type { BoundaryKind } from "./chunker.js";

/** How a block ended, in words for the user. */
export const BOUNDARY_PHRASE: Record<BoundaryKind, string> = {
  chapter: "next block starts a new chapter (divider line)",
  paragraph: "ends at a paragraph break",
  sentence: "ends at the end of a sentence",
  quote: "cut inside a quotation (too long to keep whole)",
  line: "ends at a line break",
  whitespace: "ends at a space (no sentence end found)",
  hard: "cut in the middle of text (no natural break found)",
  end: "end of the text",
};

/** Endings that deserve the user's attention, because the text was cut somewhere unnatural. */
export const AWKWARD_BOUNDARIES: ReadonlySet<BoundaryKind> = new Set<BoundaryKind>(["quote", "whitespace", "hard"]);

/** Plain sentences about the split, for the preview. */
export function describeSplit(blocks: readonly { boundaryKind: BoundaryKind }[]): string[] {
  const count = (k: BoundaryKind) => blocks.filter((b) => b.boundaryKind === k).length;
  const notes: string[] = [];
  const chapters = count("chapter");
  if (chapters > 0) notes.push(`${chapters} divider line${chapters === 1 ? "" : "s"} found: each starts a new block, and no block crosses one.`);
  const hard = count("hard");
  if (hard > 0) notes.push(`${hard} block${hard === 1 ? " is" : "s are"} cut in the middle of text because no sentence or line break was found nearby. Check those, or choose a larger block size.`);
  const quote = count("quote");
  if (quote > 0) notes.push(`${quote} block${quote === 1 ? " ends" : "s end"} inside a long quotation that was too big to keep whole.`);
  const space = count("whitespace");
  if (space > 0) notes.push(`${space} block${space === 1 ? " ends" : "s end"} at a space because there was no sentence end nearby.`);
  return notes;
}
