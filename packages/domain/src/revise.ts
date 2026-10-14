import { targetVariants } from "./glossary.js";
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

/** The system instruction for rewriting a marked part of a translation. */
export function reviseSystem(style: string, sourceLanguage: string, targetLanguage: string): string {
  return (
    `${style}\n\n` +
    `Right now you are correcting a ${sourceLanguage} to ${targetLanguage} translation that is already written. The translation is shown with one part marked between ${REDO_OPEN} and ${REDO_CLOSE}; the marked part may be only a few words. ` +
    `Write new words for that marked part, from the source text, so that they fit the text before and after it. Always use the exact ${targetLanguage} names given in GLOSSARY. ` +
    `Reply with the replacement for the marked part only, about as long as the marked part: no markers, no explanation, and never repeat the text before or after it.`
  );
}

/**
 * The request to write a selected part of a translation again. It has the glossary and notes, the whole source block, and the
 * translation with the part marked; the text around the part is cut to `window` characters on each side so the request stays small.
 */
export function reviseMessage(glossary: readonly { source: string; target: string; note?: string; aliases?: string[] | undefined }[], notes: readonly string[], source: string, translation: string, from: number, to: number, window: number, partOfSource = false): string {
  const before = tail(translation.slice(0, from), window);
  const after = head(translation.slice(to), window);
  const parts: string[] = [];
  if (notes.length > 0) parts.push(`NOTES:\n${notes.map((n) => `- ${n}`).join("\n")}`);
  if (glossary.length > 0) {
    const lines = glossary.map((g) => {
      const [first, ...others] = targetVariants(g.target);
      return `- ${[g.source, ...(g.aliases ?? [])].join(" / ")} => ${first ?? g.target}${others.length > 0 ? ` (or ${others.join(" / ")})` : ""}${g.note ? ` — ${g.note}` : ""}`;
    });
    parts.push(`GLOSSARY:\n${lines.join("\n")}`);
  }
  parts.push(`${partOfSource ? "SOURCE_PART" : "SOURCE_BLOCK"}:\n${source}`);
  parts.push(`TRANSLATION:\n${before}${REDO_OPEN}${translation.slice(from, to)}${REDO_CLOSE}${after}`);
  return parts.join("\n\n");
}

/** The reply without the words it repeated from the text just before and just after the marked part. */
export function withoutEcho(reply: string, before: string, after: string): string {
  let t = reply;
  for (let n = Math.min(before.length, t.length); n >= 8; n--) {
    if (t.startsWith(before.slice(before.length - n))) {
      t = t.slice(n);
      break;
    }
  }
  for (let n = Math.min(after.length, t.length); n >= 8; n--) {
    if (t.endsWith(after.slice(0, n))) {
      t = t.slice(0, t.length - n);
      break;
    }
  }
  return t;
}

/** Whether a reply is much longer than the part it replaces, which means the model wrote more than it was asked to. */
export const tooLong = (reply: string, selected: string): boolean => reply.trim().length > Math.max(selected.trim().length * 2.5, selected.trim().length + 30);

/** What the model wrote for the marked part: without markers or stray quotes, and with the space around the part kept as it was. */
export function revisedPart(reply: string, original: string): string | null {
  let t = reply.split(REDO_OPEN).join("").split(REDO_CLOSE).join("").trim();
  t = t.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (t === "") return null;
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return `${lead}${t}${original.trim() === "" ? "" : trail}`;
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
    `You compare a ${sourceLanguage} text with its ${targetLanguage} translation. The source is cut into numbered sentences (S1, S2, ...) and the translation into numbered paragraphs (P1, P2, ...). ` +
    `For every paragraph of the translation, say which sentences of the source it was made from: the range runs from the first sentence it covers to the last. Reply with one line per paragraph in exactly this form, and nothing else:\n` +
    `P1: S1-S3\nP2: S4\nP3: S5-S6`
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
      out.push(r);
      floor = r.first;
    } else out.push(null);
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

/** When the translation has as many paragraphs as the source, each one comes from the paragraph in the same place: no model needed. */
export function locateByParagraphs(source: string, translation: string): Located[] | null {
  const s = paragraphsOf(source);
  const t = paragraphsOf(translation);
  if (s.length !== t.length || s.length === 0) return null;
  if (s.length === 1 && sentenceUnits(source).length > 1) return null; // one paragraph: the sentences say more
  return t.map((p, i) => ({ from: p.start, to: p.end, source: { start: s[i]!.start, end: s[i]!.end } }));
}
