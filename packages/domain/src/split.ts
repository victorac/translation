import type {
  BoundaryKind,
} from "./chunker.js";

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

