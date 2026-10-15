import { glossaryLines, targetVariants, wordNoteLines } from "./glossary.js";
import { GLOSSARY_LABEL, NOTES_LABEL, WORD_NOTES_LABEL } from "./labels.js";
import { splitSentences } from "./steps.js";

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

const REDO_OPEN = "[[REDO]]";
const REDO_CLOSE = "[[/REDO]]";

/** The end of `text` no longer than `chars`, starting at a line or word boundary. */
function tail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(text.length - chars);
  const boundary = cut.search(/[\n\s]/);
  return `…${boundary >= 0 && boundary < cut.length / 2 ? cut.slice(boundary).trimStart() : cut}`;
}
function head(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return `${boundary > cut.length / 2 ? cut.slice(0, boundary) : cut}…`;
}

const OPENERS = "「『“（(";
const CLOSERS_ = "」』”）)";

/** The sentences of a text, with the sentences inside one quotation kept together (a quote is placed as one piece). */
export function sentenceUnits(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let depth = 0;
  for (const sentence of splitSentences(text)) {
    const last = out[out.length - 1];
    if (last && depth > 0) {
      last.end = sentence.end;
      last.text = text.slice(last.start, last.end);
    } else out.push({ ...sentence });
    for (const c of sentence.text) {
      if (OPENERS.includes(c)) depth++;
      else if (CLOSERS_.includes(c)) depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

/**
 * The instruction for writing paragraphs of a translation again. It is its own instruction, not the translation style: the style says
 * "translate SOURCE_BLOCK and return only its translation", which is a different task and makes a model translate the whole source.
 * A style that is not the standard one is added as guidance for tone only.
 */
export function reviseSystem(styleGuidance: string | null, sourceLanguage: string, targetLanguage: string): string {
  return [
    `You are completing a translation from ${sourceLanguage} into ${targetLanguage}. One part of it is missing, and it is your job to translate that part. The user message has labelled sections: GLOSSARY (the ${targetLanguage} names to use), WORD NOTES (instructions about particular words; follow them), NOTES (background; do not translate it), the ${sourceLanguage} text the missing part is made from, and TRANSLATION, which is the translation with the empty place for the missing part between ${REDO_OPEN} and ${REDO_CLOSE}.`,
    styleGuidance ? `Style of the whole translation (it applies to tone and wording only; for this task follow the instructions below):\n${styleGuidance}` : "",
    `Your task: translate the ${sourceLanguage} text into the empty place between ${REDO_OPEN} and ${REDO_CLOSE}, so that it fits the translation before and after it. Use the names from GLOSSARY exactly as written and follow WORD NOTES. Do not translate or repeat anything outside the markers.`,
    `Reply with the translation for the empty place between ${REDO_OPEN} and ${REDO_CLOSE}, and nothing else: no explanation and no labels.`,
  ]
    .filter((x) => x !== "")
    .join("\n\n");
}

/**
 * The whole paragraphs of `text` next to the part from..to, nearest first, as many as fit in `room` tokens. They keep their line
 * breaks, and a side that does not reach the end of the text starts or ends with "…".
 */
export function surroundings(text: string, from: number, to: number, room: number, estimate: (s: string) => number): { before: string; after: string } {
  const paragraphs = paragraphsOf(text);
  const earlier = paragraphs.filter((p) => p.end <= from).reverse();
  const later = paragraphs.filter((p) => p.start >= to);
  let left = room;
  let b = 0;
  let a = 0;
  for (;;) {
    const nb = earlier[b];
    const na = later[a];
    // Take the nearer paragraph first, alternating, until the next one does not fit.
    const useBefore = nb !== undefined && (na === undefined || b <= a);
    const next = useBefore ? nb : na;
    if (next === undefined) break;
    const cost = estimate(next.text);
    if (cost > left) break;
    left -= cost;
    if (useBefore) b++;
    else a++;
  }
  const start = b > 0 ? earlier[b - 1]!.start : from;
  const end = a > 0 ? later[a - 1]!.end : to;
  const before = text.slice(start, from);
  const after = text.slice(to, end);
  return { before: `${start > 0 && b < earlier.length ? "…\n" : ""}${before}`, after: `${after}${end < text.length && a < later.length ? "\n…" : ""}` };
}

/** The request to write a part of a translation again: the background, the source text, the translation with the part marked, and the task. */
export function reviseMessage(input: {
  glossary: readonly { source: string; target: string; note?: string; aliases?: string[] | undefined }[];
  notes: readonly string[];
  /** The source text the part was made from, or the whole block when that is not known. */
  source: string;
  sourceIsPart: boolean;
  sourceLanguage: string;
  before: string;
  after: string;
  /** A version the user did not accept, shown only when the model gave it back unchanged. */
  rejected?: string | undefined;
}): string {
  const parts: string[] = [];
  if (input.notes.length > 0) parts.push(`${NOTES_LABEL}\n${input.notes.map((n) => `- ${n}`).join("\n")}`);
  const lines = glossaryLines(input.glossary);
  if (lines.length > 0) parts.push(`${GLOSSARY_LABEL}\n${lines.join("\n")}`);
  const wordNotes = wordNoteLines(input.glossary);
  if (wordNotes.length > 0) parts.push(`${WORD_NOTES_LABEL}\n${wordNotes.join("\n")}`);
  parts.push(`${input.sourceLanguage.toUpperCase()} TEXT ${input.sourceIsPart ? "TO TRANSLATE INTO THE EMPTY PLACE" : "(the whole block; the empty place is made from some of it)"}:\n${input.source}`);
  // The old text is left out on purpose: shown the old version, a model tends to give it back.
  parts.push(`TRANSLATION:\n${input.before}${REDO_OPEN}${REDO_CLOSE}${input.after}`);
  if (input.rejected) parts.push(`REJECTED VERSION (the user did not accept it; write a different translation, do not copy its wording):\n${input.rejected}`);
  parts.push(`Translate the ${input.sourceLanguage} text into the empty place between ${REDO_OPEN} and ${REDO_CLOSE}.`);
  return parts.join("\n\n");
}

/** What the model wrote for the marked part: what is between the markers when it wrote them, else its whole reply; the space around the part is kept as it was. */
export function revisedPart(reply: string, original: string): string | null {
  const open = reply.indexOf(REDO_OPEN);
  const close = reply.lastIndexOf(REDO_CLOSE);
  let t = open >= 0 && close > open ? reply.slice(open + REDO_OPEN.length, close) : reply.split(REDO_OPEN).join("").split(REDO_CLOSE).join("");
  t = t.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (t === "") return null;
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return `${lead}${t}${original.trim() === "" ? "" : trail}`;
}

/** The selection widened to whole paragraphs: from the start of the first paragraph it touches to the end of the last. Null when it touches none. */
export function wholeParagraphs(text: string, from: number, to: number): { from: number; to: number } | null {
  const touched = paragraphsOf(text).filter((p) => p.start <= Math.max(from, to) && p.end >= Math.min(from, to));
  return touched.length > 0 ? { from: touched[0]!.start, to: touched[touched.length - 1]!.end } : null;
}

// ---- where a part of the translation comes from ----

/** Where a paragraph of the translation comes from in the source block. */
export interface Located {
  /** The paragraph in the translation. */
  from: number;
  to: number;
  /** The text it was made from, in the source block; null when that could not be told. */
  source: { start: number; end: number } | null;
}

export function locateSystem(sourceLanguage: string, targetLanguage: string): string {
  return (
    `You compare a ${sourceLanguage} text with its ${targetLanguage} translation. The ${sourceLanguage} text is cut into numbered sentences (S1, S2, ...) and the translation into numbered paragraphs (P1, P2, ...). A paragraph of the translation may be made from one sentence or several, and a sentence may be spread over two paragraphs.\n` +
    `For every paragraph of the translation, say which sentences it was made from: the first and the last sentence it covers. Reply with one line per paragraph, written P<number>: S<first>-S<last>, or P<number>: S<number> when it is made from one sentence, and nothing else.`
  );
}

/** The request: the numbered source sentences and the numbered paragraphs of the translation. */
export function locateMessage(source: string, translation: string): string {
  const sentences = sentenceUnits(source).map((s, i) => `S${i + 1}: ${s.text}`);
  const paragraphs = paragraphsOf(translation).map((p, i) => `P${i + 1}: ${p.text}`);
  return `SOURCE:\n${sentences.join("\n")}\n\nTRANSLATION:\n${paragraphs.join("\n")}`;
}

/**
 * The model's lines read back as sentence ranges, one for each paragraph (null where a line is missing, makes no sense, or goes back
 * before the one above it: a translation keeps the order of the source).
 */
export function parseLocation(reply: string, paragraphs: number, sentences: number): ({ first: number; last: number } | null)[] {
  const found = new Map<number, { first: number; last: number }>();
  for (const line of reply.split(/\r?\n/)) {
    const m = /\bP\s*(\d+)\s*[:：=\-–>]+\s*S?\s*(\d+)(?:\s*(?:[-–—~]|to)\s*S?\s*(\d+))?/i.exec(line);
    if (!m) continue;
    const p = Number(m[1]);
    const first = Number(m[2]);
    const last = m[3] !== undefined ? Number(m[3]) : first;
    if (p < 1 || p > paragraphs || first < 1 || last > sentences || first > last) continue;
    if (!found.has(p)) found.set(p, { first, last });
  }
  let floor = 1;
  const out: ({ first: number; last: number } | null)[] = [];
  for (let p = 1; p <= paragraphs; p++) {
    const r = found.get(p) ?? null;
    if (r && r.first >= floor) {
      out.push({ ...r });
      floor = r.first;
    } else out.push(null);
  }
  // A paragraph cannot reach past where the next one starts (they may share one sentence when a sentence is split between them).
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (!r) continue;
    const next = out.slice(i + 1).find((x) => x !== null);
    if (next && r.last > next.first) r.last = Math.max(r.first, next.first);
  }
  return out;
}

/** The paragraphs of the translation placed on the source, from sentence ranges. */
export function placeLocation(source: string, translation: string, ranges: ({ first: number; last: number } | null)[]): Located[] {
  const sentences = sentenceUnits(source);
  return paragraphsOf(translation).map((p, i) => {
    const r = ranges[i];
    const a = r ? sentences[r.first - 1] : undefined;
    const b = r ? sentences[r.last - 1] : undefined;
    return { from: p.start, to: p.end, source: a && b ? { start: a.start, end: b.end } : null };
  });
}

/**
 * The translation paragraphs to write again, and the source text they stand for, when the paragraph under the cursor is wanted.
 * A paragraph may share source sentences with its neighbours (one source paragraph written as two, or two written as one), so the
 * range grows until the source text it covers belongs to no paragraph outside it. Null when the place is not known.
 */
export function rewriteRange(located: readonly Located[], from: number, to: number): { from: number; to: number; source: { start: number; end: number } | null } | null {
  const at = located.map((p, i) => ({ p, i })).filter(({ p }) => p.from <= Math.max(from, to) && p.to >= Math.min(from, to));
  if (at.length === 0) return null;
  let lo = at[0]!.i;
  let hi = at[at.length - 1]!.i;
  const span = () => {
    const sources = located.slice(lo, hi + 1).map((p) => p.source).filter((x): x is { start: number; end: number } => x !== null);
    return sources.length === 0 ? null : { start: Math.min(...sources.map((x) => x.start)), end: Math.max(...sources.map((x) => x.end)) };
  };
  for (;;) {
    const src = span();
    if (!src) break;
    const share = (i: number) => located[i]?.source && located[i]!.source!.start < src.end && located[i]!.source!.end > src.start;
    if (lo > 0 && share(lo - 1)) lo--;
    else if (hi < located.length - 1 && share(hi + 1)) hi++;
    else break;
  }
  return { from: located[lo]!.from, to: located[hi]!.to, source: span() };
}

/**
 * A check on the model's answer with the glossary: when a paragraph of the translation has the English name of a word that is in the
 * source text, the source text it was mapped to must have that word. A paragraph for which that is not so is marked as not known,
 * since a wrong place is worse than none.
 */
export function dropContradicted(located: readonly Located[], translation: string, source: string, names: readonly { source: string; aliases: string[]; english: string }[]): Located[] {
  return located.map((p) => {
    if (!p.source) return p;
    const text = translation.slice(p.from, p.to).toLocaleLowerCase();
    const there = source.slice(p.source.start, p.source.end);
    const contradicted = names.some((n) => {
      const words = [n.source, ...n.aliases];
      if (!words.some((w) => source.includes(w))) return false; // not in the source at all: nothing to compare
      const named = targetVariants(n.english).some((v) => text.includes(v.toLocaleLowerCase()));
      return named && !words.some((w) => there.includes(w));
    });
    return contradicted ? { ...p, source: null } : p;
  });
}
