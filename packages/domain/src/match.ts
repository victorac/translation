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
  // The question names the language of the answer, so a small model does not give back what it was shown; and it asks for a part,
  // not for words, as what stands for the selection is often one word.
  const asked =
    input.side === "source"
      ? `Which part of the ${TO} text translates the ${FROM} 「${input.selected}」? Copy that part exactly from the ${TO} text, no more of it than it takes, and reply with it only. If the ${TO} text leaves it out, reply NONE.`
      : `Which part of the ${FROM} text does the ${TO} ${/\s/.test(input.selected.trim()) ? "phrase" : "word"} "${input.selected}" translate? Copy that part exactly from the ${FROM} text, no more of it than it takes, and reply with it only. If it is not in the ${FROM} text, reply NONE.`;
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
 * Whether a match is too much to be one: nearly all of the other paragraph, for a selection that is only a part of its own. A small
 * model sometimes gives back the whole paragraph.
 */
export function tooMuch(span: Span, otherLength: number, selected: number, ownLength: number): boolean {
  return otherLength > 0 && ownLength > 0 && (span.end - span.start) / otherLength >= 0.8 && selected / ownLength < 0.5;
}

/**
 * Where a reply's words are written in the other text, or null when they are not (or the reply is NONE). `near` is where the selection
 * stands in its own paragraph, from 0 to 1: of several places, the one at about the same point of the other text is taken.
 */
export function matchedSpan(reply: string, text: string, near = 0): Span | null {
  const line = (reply.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  if (line === "" || /^none\b/i.test(line)) return null;
  // As written, then without the quotation marks a model may put around it, then without a last full stop, then without a note in
  // brackets after it (回復魔法 (kaifuku mahou)).
  const bare = line.replace(EDGES, "");
  const tries = [line, bare, bare.replace(/[.。,、;:!?！？]+$/, ""), line.replace(/\s*[(（][^()（）]*[)）]\s*$/, "").replace(EDGES, "")].filter((t, i, all) => t !== "" && all.indexOf(t) === i);
  for (const t of tries) {
    const found = placesOf(text, t);
    if (found.length === 0) continue;
    const length = Math.max(1, text.length);
    return found.reduce((best, s) => (Math.abs(s.start / length - near) < Math.abs(best.start / length - near) ? s : best));
  }
  return null;
}
