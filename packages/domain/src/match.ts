/**
 * Which words of a paragraph's translation stand for the words selected in the source, or the other way round. The model is asked to
 * copy them from the other text, and its answer is used only where that text has it: the place it is written, nearest to where the
 * selection stands in its own paragraph when it is written more than once.
 */

/** Which text the selection was made in. */
export type MatchSide = "source" | "translation";

export interface Span {
  start: number;
  end: number;
}

/** The question: the words of the other text that the selected words translate (or are translated by), copied exactly. */
export function matchQuestion(input: { side: MatchSide; selected: string; source: string; translation: string; from: string; to: string }): { system: string; user: string } {
  const FROM = input.from.toUpperCase();
  const TO = input.to.toUpperCase();
  // The question names the language of the answer, so a small model does not give back the words it was shown.
  const asked =
    input.side === "source"
      ? `The ${FROM} words 「${input.selected}」 are translated by some words of the ${TO} text. Which ${TO} words? Copy them exactly from the ${TO} text, as few as needed, and reply with those ${TO} words only. If the ${TO} text leaves them out, reply NONE.`
      : `The ${TO} words "${input.selected}" translate some words of the ${FROM} text. Which ${FROM} words? Copy them exactly from the ${FROM} text, as few as needed, and reply with those ${FROM} words only. If they are not in the ${FROM} text, reply NONE.`;
  return {
    system: `You compare a paragraph of a story written in ${input.from} with its translation into ${input.to}. Answer with exactly what is asked and nothing else.`,
    user: [`${FROM} TEXT:\n${input.source}`, `${TO} TEXT:\n${input.translation}`, asked].join("\n\n"),
  };
}

const EDGES = /^["'“”‘’「」『』《》【】()（）\s]+|["'“”‘’「」『』《》【】()（）\s]+$/g;

/** Every place `part` is written in `text`, in any case. */
function placesOf(text: string, part: string): Span[] {
  const hay = text.toLocaleLowerCase();
  const needle = part.toLocaleLowerCase();
  const out: Span[] = [];
  if (needle === "") return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push({ start: i, end: i + part.length });
  return out;
}

/**
 * Where a reply's words are written in the other text, or null when they are not (or the reply is NONE). `near` is where the selection
 * stands in its own paragraph, from 0 to 1: of several places, the one at about the same point of the other text is taken.
 */
export function matchedSpan(reply: string, text: string, near = 0): Span | null {
  const line = (reply.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  if (line === "" || /^none\b/i.test(line)) return null;
  // As written, then without the quotation marks a model may put around it, then without a last full stop.
  const tries = [line, line.replace(EDGES, ""), line.replace(EDGES, "").replace(/[.。,、;:!?！？]+$/, "")].filter((t, i, all) => t !== "" && all.indexOf(t) === i);
  for (const t of tries) {
    const found = placesOf(text, t);
    if (found.length === 0) continue;
    const length = Math.max(1, text.length);
    return found.reduce((best, s) => (Math.abs(s.start / length - near) < Math.abs(best.start / length - near) ? s : best));
  }
  return null;
}
