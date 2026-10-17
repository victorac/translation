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

/** The marks put around the selection where it stands: brackets that Japanese and English prose do not use (「」 is speech). */
export const MARK_OPEN = "⟦";
export const MARK_CLOSE = "⟧";

/** A text with the selection marked where it stands (at `at`, or else where it is first written). */
export function marked(text: string, selected: string, at: number): string {
  const start = text.slice(at, at + selected.length) === selected ? at : text.indexOf(selected);
  if (start < 0) return text;
  return `${text.slice(0, start)}${MARK_OPEN}${selected}${MARK_CLOSE}${text.slice(start + selected.length)}`;
}

/**
 * The question, with the selection marked where it stands: the model sees which of several it is and the words around it, and the
 * marks cannot be taken for the quotation marks of speech. It writes first the marked part alone in the other language, then the words
 * of the other text that say the same. Asked for the part alone (not for what it means in the sentence, nor for "the matching part"),
 * a small model does not give back a whole clause: tried on local 4B models, this found 14 or 15 selections of 18 where asking for
 * the matching words at once found 8 to 11.
 */
export function matchQuestion(input: { side: MatchSide; selected: string; at: number; source: string; translation: string; from: string; to: string }): { system: string; user: string } {
  const FROM = input.from.toUpperCase();
  const TO = input.to.toUpperCase();
  const other = input.side === "source" ? TO : FROM;
  const language = input.side === "source" ? input.to : input.from;
  const source = input.side === "source" ? marked(input.source, input.selected, input.at) : input.source;
  const translation = input.side === "translation" ? marked(input.translation, input.selected, input.at) : input.translation;
  const label = (lang: string, side: MatchSide) => `${lang} TEXT${side === input.side ? ` (the part to match is marked ${MARK_OPEN} ${MARK_CLOSE})` : ""}:`;
  return {
    system: `You compare a paragraph of a story written in ${input.from} with its translation into ${input.to}. Answer with exactly what is asked and nothing else.`,
    user: [
      `${label(FROM, "source")}\n${source}`,
      `${label(TO, "translation")}\n${translation}`,
      `Reply in two lines:\nMEANING: only the marked part ${MARK_OPEN}${input.selected}${MARK_CLOSE}, said in ${language}, in as few words as it has\nPART: the words of the ${other} text that say the same as MEANING, copied exactly (or NONE)`,
    ].join("\n\n"),
  };
}

const MEANING = /^(meaning|意味)\s*[:：]\s*/i;
const PART = /^(part|パート|部分)\s*[:：]\s*/i;

/**
 * The two lines of a reply, read leniently: labels in English or Japanese, and a first line with no label taken as the meaning. A
 * meaning that gives back the instruction is no meaning.
 */
export function readAnswer(reply: string): { meaning: string; part: string } {
  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const meaningLine = lines.find((l) => MEANING.test(l)) ?? lines.find((l) => !PART.test(l)) ?? "";
  const meaning = meaningLine.replace(MEANING, "").trim();
  return { meaning: /marked part/i.test(meaning) ? "" : meaning, part: (lines.find((l) => PART.test(l)) ?? "").replace(PART, "").trim() };
}

const EDGES = /^["'“”‘’「」『』《》【】()（）⟦⟧\s]+|["'“”‘’「」『』《》【】()（）⟦⟧\s]+$/g;

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

/** Where some words are written in a text, nearest to `near` (0 to 1) when they are written more than once; null when they are not. */
export function spanOf(words: string, text: string, near = 0): Span | null {
  const line = words.trim();
  if (line === "" || /^none\b/i.test(line)) return null;
  // As written, then without the quotation marks a model may put around it, then without a last full stop, then without a note in
  // brackets after it (回復魔法 (kaifuku mahou)).
  const bare = line.replace(EDGES, "");
  const tries = [line, bare, bare.replace(/[.。,、;:!?！？]+$/, ""), line.replace(/\s*[(（][^()（）]*[)）]\s*$/, "").replace(EDGES, "").replace(/[.。,、;:!?！？]+$/, "")].filter((t, i, all) => t !== "" && all.indexOf(t) === i);
  for (const t of tries) {
    const found = placesOf(text, t);
    if (found.length === 0) continue;
    const length = Math.max(1, text.length);
    return found.reduce((best, s) => (Math.abs(s.start / length - near) < Math.abs(best.start / length - near) ? s : best));
  }
  return null;
}

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * The words of a text closest to a meaning that it does not write as it is. In Japanese, the longest piece of the meaning that the text
 * has (with a kanji, or two kana at least); in English, the shortest run of words, starting and ending with one of the meaning's, that has
 * the most of them (a word counts by its first four letters, so "needed" finds "need").
 */
export function nearestWords(meaning: string, text: string): Span | null {
  const m = meaning.replace(EDGES, "");
  if (m === "") return null;
  if (JAPANESE.test(text)) {
    for (let n = m.length; n >= 1; n--) {
      for (let i = 0; i + n <= m.length; i++) {
        const piece = m.slice(i, i + n);
        if (!JAPANESE.test(piece) || (n < 2 && !/\p{Script=Han}/u.test(piece))) continue;
        const at = text.indexOf(piece);
        if (at >= 0) return { start: at, end: at + n };
      }
    }
    return null;
  }
  const key = (w: string) => w.toLocaleLowerCase().slice(0, 4);
  const keys = new Set((m.match(/[\p{L}’']+/gu) ?? []).filter((w) => w.length >= 3).map(key));
  const tokens = [...text.matchAll(/[\p{L}’']+/gu)];
  let best: { hits: number; span: Span } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (!keys.has(key(tokens[i]![0]))) continue;
    for (let j = i; j < tokens.length && j < i + 8; j++) {
      if (!keys.has(key(tokens[j]![0]))) continue;
      const run = tokens.slice(i, j + 1);
      const hits = new Set(run.map((t) => key(t[0])).filter((k) => keys.has(k))).size;
      const span = { start: tokens[i]!.index!, end: tokens[j]!.index! + tokens[j]![0].length };
      if (!best || hits > best.hits || (hits === best.hits && span.end - span.start < best.span.end - best.span.start)) best = { hits, span };
    }
  }
  return best?.span ?? null;
}

/**
 * Where a reply's answer is written in the other text, or null when it is not (or the reply is NONE): the meaning as the text writes
 * it, else the part copied when it is not much longer than the meaning (a small model copies a whole clause), else the words nearest
 * the meaning, else the part. `near` is where the selection stands in its own paragraph, from 0 to 1.
 */
export function matchedSpan(reply: string, text: string, near = 0): Span | null {
  const { meaning, part } = readAnswer(reply);
  const byMeaning = spanOf(meaning, text, near);
  if (byMeaning) return byMeaning;
  const byPart = spanOf(part, text, near);
  if (byPart && (meaning === "" || byPart.end - byPart.start <= Math.max(12, 3 * meaning.length))) return byPart;
  return (meaning !== "" && !/^none\b/i.test(meaning) ? nearestWords(meaning, text) : null) ?? byPart;
}
