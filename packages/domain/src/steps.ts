/**
 * The building blocks of reading a passage for knowledge, one small question at a time: splitting it into sentences,
 * finding candidate names, writing each question, and reading and checking each answer. The program decides what to
 * ask and what to do with the answer; the model only ever answers a narrow question.
 */

// ---- sentences ----

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

const ENDERS = new Set(["。", "！", "？", "!", "?", "…"]);
const CLOSERS = new Set(["」", "』", "）", ")", "”", "’", "】"]);

/** Splits at the end of a sentence (keeping a closing quote with it) and at line breaks. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t !== "") out.push({ text: t, start: start + lead, end: start + lead + t.length });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") {
      push(i);
      start = i + 1;
    } else if (ENDERS.has(c)) {
      let j = i + 1;
      while (j < text.length && (ENDERS.has(text[j]!) || CLOSERS.has(text[j]!))) j++;
      push(j);
      i = j - 1;
    }
  }
  push(text.length);
  return out;
}

/** The sentences that contain any of the names, with the sentence before the first one for context. */
export function windowAround(sentences: readonly Sentence[], names: readonly string[], maxChars = 900): string {
  const hits = sentences.map((s, i) => (names.some((n) => s.text.includes(n)) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) return sentences.map((s) => s.text).join("\n").slice(0, maxChars);
  const keep = new Set<number>();
  for (const h of hits) {
    keep.add(h);
    if (h > 0) keep.add(h - 1);
  }
  let out = "";
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (out.length + sentences[i]!.text.length > maxChars && out !== "") break;
    out += `${out ? "\n" : ""}${sentences[i]!.text}`;
  }
  return out;
}

// ---- candidate names ----

/** What a Japanese word analyzer reports for one word. */
export interface WordToken {
  surface: string;
  details: string[];
  byteStart: number;
  byteEnd: number;
}

const HONORIFICS = ["さん", "くん", "君", "ちゃん", "様", "さま", "殿", "氏", "先輩", "先生", "せんせい", "お嬢様", "お兄ちゃん", "お姉ちゃん", "兄さん", "姉さん"];
const KANJI_KATAKANA = "\\u4E00-\\u9FFF\\u3005\\u30A0-\\u30FF\\u30FC";
const HAS_LETTER = /[一-鿿゠-ヿ]/;
const ALL_KANA = /^[぀-ゟー]+$/;

/** Proper nouns the analyzer found, with neighbouring ones joined (山田 + 亘 = 山田太郎, and 山田 + 家 = 山田家). */
export function properNounRuns(tokens: readonly WordToken[]): string[] {
  const runs: string[] = [];
  let current = "";
  let lastEnd = -1;
  const flush = () => {
    if (current !== "") runs.push(current);
    current = "";
  };
  for (const t of tokens) {
    const proper = t.details[0] === "名詞" && t.details[1] === "固有名詞";
    const suffix = current !== "" && t.details[0] === "名詞" && t.details[1] === "接尾" && !HONORIFICS.includes(t.surface);
    if ((proper || suffix) && (current === "" || t.byteStart === lastEnd)) {
      current += t.surface;
      lastEnd = t.byteEnd;
    } else {
      flush();
      if (proper) {
        current = t.surface;
        lastEnd = t.byteEnd;
      }
    }
  }
  flush();
  return runs;
}

/** Names that the way they are written gives away: before an honorific, or ending like a family, school or place. */
export function patternCandidates(text: string): string[] {
  const out: string[] = [];
  const honorific = new RegExp(`([${KANJI_KATAKANA}]{1,8})(?:${HONORIFICS.join("|")})`, "g");
  for (const m of text.matchAll(honorific)) out.push(m[1]!);
  const kinds = new RegExp(`[${KANJI_KATAKANA}]{1,8}(?:学園|学院|高校|学校|大学|家|一族|組|会社|商会|団|城|村|町|王国|帝国|島)`, "g");
  for (const m of text.matchAll(kinds)) out.push(m[0]);
  return out;
}

const STOP = new Set(["彼", "彼女", "私", "僕", "ぼく", "俺", "お前", "あなた", "自分", "みんな", "誰", "何", "ここ", "そこ", "あそこ", "今日", "明日", "昨日", "先生", "先輩"]);

/** Puts candidate names from several sources together: first appearance first, no repeats, nothing that cannot be a name. */
export function mergeCandidates(text: string, ...sources: (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of sources.flat()) {
    const c = raw.trim().replace(/^[「『（(]+|[」』）)、。！？!?]+$/g, "");
    if (c.length < 2 || c.length > 20 || seen.has(c)) continue;
    if (!HAS_LETTER.test(c) || ALL_KANA.test(c) || STOP.has(c) || /\s/.test(c)) continue;
    if (!text.includes(c)) continue; // a name the passage does not contain was made up
    seen.add(c);
    list.push(c);
  }
  // A word that only ever appears inside a longer candidate (桜台 inside 桜台学園) is part of it, not a name of its own.
  const whole = list.filter((c) => !list.some((d) => d.length > c.length && d.includes(c) && text.split(d).join("").indexOf(c) < 0));
  return whole.sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/** Could two written forms be the same thing? One contains the other, or they share most of their characters. */
export function related(a: string, b: string): boolean {
  if (a === b) return true;
  if ((a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b))) return true;
  const sa = new Set([...a].filter((c) => HAS_LETTER.test(c)));
  const common = [...b].filter((c) => sa.has(c));
  return common.length >= 2 && common.length >= Math.min(sa.size, [...new Set([...b])].length) * 0.6;
}

// ---- questions ----

export type QuestionKind = "choice" | "text" | "list";

export interface Question {
  /** What is being asked, for tests and the log. */
  id: string;
  kind: QuestionKind;
  system: string;
  user: string;
  /** For a choice: the options, in order. */
  options?: string[];
  /** The most the model should write. */
  maxTokens: number;
}

const LETTERS = "ABCDEFGHIJ";
const RULE = "Answer with exactly what is asked and nothing else.";
const optionLines = (options: readonly string[]) => options.map((o, i) => `${LETTERS[i]}) ${o}`).join("\n");

const choice = (id: string, intro: string, body: string, options: string[], extra = ""): Question => ({
  id,
  kind: "choice",
  system: `${intro} ${RULE}`,
  user: `${body}\n\n${optionLines(options)}\n\nReply with the letter only${extra}.`,
  options,
  maxTokens: extra ? 80 : 8,
});

export const listNames = (passage: string, sourceLanguage: string): Question => ({
  id: "list-names",
  kind: "list",
  system: `You find names in ${sourceLanguage} fiction. ${RULE}`,
  user: `List every name of a person, place, organization or family that appears in this passage, one per line, written exactly as in the passage. If there are none, write NONE.\n\nPASSAGE:\n${passage}`,
  maxTokens: 200,
});

export const classify = (name: string, context: string, options: string[]): Question =>
  choice("classify", "You classify words in fiction.", `In this passage, what is 「${name}」?\n\nPASSAGE:\n${context}`, options);

export const sameAs = (name: string, context: string, known: { label: string }[]): Question =>
  choice(
    "same-as",
    "You decide whether two names refer to the same thing.",
    `In this passage, is 「${name}」 the same person or thing as one of the known entries below?\n\nPASSAGE:\n${context}`,
    [...known.map((k) => k.label), "None of them: it is a new one"],
  );

export const englishName = (name: string, kind: string, context: string, targetLanguage: string): Question => ({
  id: "english-name",
  kind: "text",
  system: `You translate names in fiction into ${targetLanguage}. ${RULE}`,
  user: `Give the ${targetLanguage} name that should be used for 「${name}」 (${kind}) in a ${targetLanguage} translation: romanize the names of people, and translate the meaning of places and organizations when that reads naturally. Reply with the name only.\n\nPASSAGE:\n${context}`,
  maxTokens: 30,
});

export const describe = (name: string, context: string): Question => ({
  id: "describe",
  kind: "text",
  system: `You write very short descriptions from a passage. ${RULE}`,
  user: `In at most 15 words, say who or what 「${name}」 is, using only what the passage says. If it does not say, reply UNKNOWN.\n\nPASSAGE:\n${context}`,
  maxTokens: 50,
});

export const role = (name: string, context: string): Question =>
  choice("role", "You read fiction closely.", `In this passage, what does 「${name}」 do?\n\nPASSAGE:\n${context}`, [
    "speaks or acts",
    "is spoken to",
    "is only mentioned or talked about",
    "does not appear as a person here",
  ]);

export const attribute = (name: string, key: string, options: string[], context: string): Question =>
  choice("attribute", "You read fiction closely and only report what the text says.", `According to this passage, what is the ${key} of 「${name}」?\n\nPASSAGE:\n${context}`, [...options, "Not stated in the passage"], ", then | and a short quote from the passage that shows it");

export const relation = (name: string, key: string, other: string, context: string): Question =>
  choice("relation", "You read fiction closely and only report what the text says.", `According to this passage, does 「${name}」 have this relation to 「${other}」: "${key}"?\n\nPASSAGE:\n${context}`, ["Yes", "No, or not stated"], ", then | and a short quote from the passage that shows it");

export const sameScene = (previous: string, passage: string): Question =>
  choice("same-scene", "You follow the scenes of a story.", `Here is the scene so far, then the start of the next passage. Does the next passage continue the same scene (the same place and time)?\n\nSCENE SO FAR:\n${previous}\n\nNEXT PASSAGE:\n${passage.slice(0, 500)}`, ["Yes, it continues the scene", "No, a new scene starts"]);

export const sceneText = (passage: string, present: string[], targetLanguage: string): Question => ({
  id: "scene-text",
  kind: "text",
  system: `You describe scenes of a story in ${targetLanguage}. ${RULE}`,
  user: `In one sentence of at most 25 words, say where this takes place and what happens${present.length > 0 ? `. The people present are: ${present.join(", ")}` : ""}.\n\nPASSAGE:\n${passage.slice(0, 1500)}`,
  maxTokens: 80,
});

// ---- reading answers ----

/** Which option a reply chose (a letter or a number), or null if it chose none of them. */
export function parseChoice(reply: string, count: number): number | null {
  const m = /^\s*[(\[]?\s*([A-Za-z]|\d{1,2})\s*[)\].:|,]?(?![A-Za-z0-9])/.exec(reply);
  if (!m) return null;
  const token = m[1]!;
  const index = /\d/.test(token) ? Number(token) - 1 : token.toUpperCase().charCodeAt(0) - 65;
  return index >= 0 && index < count ? index : null;
}

/** A choice followed by "|" and a quote. */
export function parseChoiceWithQuote(reply: string, count: number): { index: number; quote: string } | null {
  const bar = reply.indexOf("|");
  const index = parseChoice(bar >= 0 ? reply.slice(0, bar) : reply, count);
  if (index === null) return null;
  return { index, quote: (bar >= 0 ? reply.slice(bar + 1) : "").trim().replace(/^["「『]+|["」』]+$/g, "").trim() };
}

/** True if the quote is really in the passage (ignoring spaces and line breaks). */
export function quoteInPassage(passage: string, quote: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const q = squash(quote.replace(/^["「『]+|["」』]+$/g, ""));
  return q.length >= 2 && squash(passage).includes(q);
}

export function parseNameList(reply: string): string[] {
  return reply
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((l) => l !== "" && !/^none\.?$/i.test(l));
}

/** The first line of a short answer, without quotes, or null if there is nothing usable. */
export function parseShortText(reply: string, maxChars: number): string | null {
  const line = reply.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (!line) return null;
  const clean = line.replace(/^["'「『“]+|["'」』”]+$/g, "").replace(/^(answer|name|description)\s*[:：]\s*/i, "").trim();
  if (clean === "" || /^unknown\.?$/i.test(clean) || clean.length > maxChars) return null;
  return clean;
}
