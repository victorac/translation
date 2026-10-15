import type {
  GlossaryEntry,
} from "./glossary.js";

/**
 * Names, hints and notes can be written as lines, for pasting in and copying out:
 *
 *   # a comment or heading
 *   花子 = Hanako # girl, speaks politely     a name or term, with an optional hint
 *   > Hanako is being addressed.             a note about the story
 */
export interface KnowledgeNote {
  text: string;
}

export type KnowledgeLine =
  | { kind: "blank" | "comment" | "term" | "note"; from: number; to: number }
  | { kind: "problem"; from: number; to: number; message: string };

export interface ParsedKnowledge {
  glossary: GlossaryEntry[];
  notes: KnowledgeNote[];
  /** One entry per line of the text, for showing how each line was read. */
  lines: KnowledgeLine[];
}

const TERM = /^(.*?)\s*(?:=>|->|→|=|\t)\s*(.*)$/;

/** "花子 / 花子" is a word followed by other ways it is written. */
export const splitNames = (s: string): string[] => s.split(" / ").map((n) => n.trim()).filter(Boolean);

export function parseKnowledge(text: string): ParsedKnowledge {
  const glossary: GlossaryEntry[] = [];
  const notes: KnowledgeNote[] = [];
  const lines: KnowledgeLine[] = [];
  let from = 0;
  for (const raw of text.split("\n")) {
    const to = from + raw.length;
    const line = raw.trim();
    if (line === "") lines.push({ kind: "blank", from, to });
    else if (line.startsWith("#")) lines.push({ kind: "comment", from, to });
    else if (line.startsWith(">")) {
      // Lines written when notes were tied to words ("names | note") keep only the note.
      const body = line.slice(1).trim();
      const bar = body.indexOf("|");
      const noteText = (bar >= 0 ? body.slice(bar + 1) : body).trim();
      if (noteText === "") lines.push({ kind: "problem", from, to, message: "This note is empty." });
      else {
        notes.push({ text: noteText });
        lines.push({ kind: "note", from, to });
      }
    } else {
      const [pair = "", ...hint] = line.split(/\s#\s/);
      const m = TERM.exec(pair.trim());
      const [source = "", ...aliases] = splitNames(m?.[1] ?? "");
      const target = m?.[2]?.trim() ?? "";
      if (!m || source === "" || target === "") {
        lines.push({ kind: "problem", from, to, message: "Not understood. Write: source = translation # hint. Notes start with >." });
      } else {
        const note = hint.join(" # ").trim();
        glossary.push({ source, target, ...(note ? { note } : {}), ...(aliases.length > 0 ? { aliases } : {}) });
        lines.push({ kind: "term", from, to });
      }
    }
    from = to + 1;
  }
  return { glossary, notes, lines };
}

export const serializeTerm = (g: GlossaryEntry): string => `${[g.source, ...(g.aliases ?? [])].join(" / ")} = ${g.target}${g.note ? ` # ${g.note}` : ""}`;

