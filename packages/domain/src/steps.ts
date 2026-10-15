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
  for (const [i, t] of tokens.entries()) {
    const proper = t.details[0] === "名詞" && t.details[1] === "固有名詞";
    // A surname followed by a plain one or two kanji word that ends the phrase is a full name (鈴木 + 花子 = 鈴木花子).
    const next = tokens[i + 1];
    const given = current !== "" && !proper && t.details[0] === "名詞" && t.details[1] === "一般" && /^[\u4E00-\u9FFF]{1,2}$/.test(t.surface) && t.byteStart === lastEnd && (next === undefined || next.details[0] !== "名詞") && !HONORIFICS.includes(t.surface);
    if (given) {
      current += t.surface;
      lastEnd = t.byteEnd;
      flush();
      continue;
    }
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
  // A name from another language written in katakana, its parts set apart by a middle dot (ジョン・スミス).
  for (const m of text.matchAll(/[\u30A1-\u30FA\u30FC]{2,}(?:・[\u30A1-\u30FA\u30FC]{2,})+/g)) out.push(m[0]);
  // What is set in 『…』 is a name or a term of the story: it is named or called so.
  for (const m of text.matchAll(/『([^』\n]{2,12})』/g)) out.push(m[1]!);
  // A katakana word that comes back is a term of the story.
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/[\u30A1-\u30FA\u30FC]{3,}/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  for (const [word, n] of counts) if (n >= 2) out.push(word);
  return out;
}

const STOP = new Set(["彼", "彼女", "私", "僕", "ぼく", "俺", "お前", "あなた", "自分", "みんな", "誰", "何", "ここ", "そこ", "あそこ", "今日", "明日", "昨日", "先生", "先輩"]);

const KANJI_OR_KATAKANA = /[\u4E00-\u9FFF\u3005\u30A0-\u30FF\u30FC]/;
const FOLLOWING = ["さん", "くん", "君", "ちゃん", "様", "さま", "殿", "氏", "先輩", "先生", "家", "一族", "学園", "学院", "高校", "学校", "大学", "組", "団", "城", "村", "町", "島", "王国", "帝国"];

/**
 * Does the word stand on its own somewhere in the text, rather than only as part of a longer word? ボブ inside ボブカット
 * (a bob cut) is not a name; 花子 in 花子は is. A name may be followed by an honorific or a word like 家 or 学園.
 */
export function standsAlone(text: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) return false;
    const before = text[i - 1] ?? "";
    const after = text.slice(i + word.length, i + word.length + 3);
    const joinedBefore = before !== "" && KANJI_OR_KATAKANA.test(before) && KANJI_OR_KATAKANA.test(word[0]!);
    const joinedAfter = after !== "" && KANJI_OR_KATAKANA.test(after[0]!) && !FOLLOWING.some((f) => after.startsWith(f));
    if (!joinedBefore && !joinedAfter) return true;
    from = i + 1;
  }
}

/** Puts candidate names from several sources together: first appearance first, no repeats, nothing that cannot be a name. */
export function mergeCandidates(text: string, ...sources: (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of sources.flat()) {
    const c = raw.trim().replace(/^[「『（(]+|[」』）)、。！？!?]+$/g, "");
    if (c.length < 2 || c.length > 20 || seen.has(c)) continue;
    if (!HAS_LETTER.test(c) || ALL_KANA.test(c) || STOP.has(c) || /\s/.test(c)) continue;
    if (!text.includes(c)) continue; // a name the passage does not contain was made up
    if (!standsAlone(text, c)) continue; // only ever part of a longer word, such as ボブ in ボブカット
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
  /** For a choice: the parts it was written from, so it can be written again with the options in another order. */
  parts?: { intro: string; body: string; extra: string };
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
  parts: { intro, body, extra },
});

/**
 * The same question with the options in the opposite order. A model that really read the passage gives the same
 * answer both ways; one that is guessing tends to favour a position. `back[i]` is where option i of the reversed
 * question was in the original.
 */
export function reversed(q: Question): { question: Question; back: number[] } {
  const n = q.options!.length;
  const back = Array.from({ length: n }, (_, i) => n - 1 - i);
  const options = back.map((i) => q.options![i]!);
  const { intro, body, extra } = q.parts!;
  return { question: choice(q.id, intro, body, options, extra), back };
}

/** Is a statement supported by the passage? Used to throw away descriptions the model made up. */
export const supported = (statement: string, subject: string, passage: string): Question =>
  choice("supported", "You check statements against a text.", `Statement about 「${subject}」: ${statement}\n\nIs the statement supported by this passage?\n\nPASSAGE:\n${passage}`, ["Yes, the passage says or clearly implies it", "No, the passage does not say it"]);

export const classify = (name: string, context: string, options: string[]): Question =>
  choice("classify", "You classify words in fiction.", `In this passage, what is 「${name}」?\n\nPASSAGE:\n${context}`, options);

export const describe = (name: string, kind: string, context: string, targetLanguage: string, strict = false): Question => ({
  id: "describe",
  kind: "text",
  system: `You write very short descriptions from a passage. ${RULE}`,
  user: `In at most 15 words, written in ${targetLanguage}, say what 「${name}」 (${kind}) is in the story (for a person, their role or how they relate to others; for a place or organization, what kind it is), using only what the passage says. Do not mention the passage or the text itself. If it does not say, reply UNKNOWN.${strict ? ` Your first answer could not be used. Write only ${targetLanguage}, with no Japanese or Chinese characters at all, and write no names in the original script.` : ""}\n\nPASSAGE:\n${context}`,
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

/** Is a passage told in the first person? The word the narrator uses for "I" outside of quotations, or null. */
export function firstPersonInNarration(text: string): string | null {
  const narration = text.replace(/「[^」]*」/g, "").replace(/『[^』]*』/g, "");
  return ["ぼく", "僕", "私", "わたし", "俺", "おれ", "オレ", "あたし", "わたくし"].find((w) => narration.includes(w)) ?? null;
}

export interface Speaker {
  id: string;
  /** The English name shown to the model. */
  label: string;
  /** Every way the passage may write it: names, aliases, and for the narrator the word for "I". */
  names: string[];
}

export interface Quote {
  start: number;
  end: number;
  text: string;
}

/** The 「…」 lines of a passage, in order. */
export function findQuotes(passage: string): Quote[] {
  // A word set in quotation marks and then named or called so (「山田」と呼んで) is not something said.
  return [...passage.matchAll(/「[^」]*」/g)]
    .filter((m) => !/^と(?:呼|称|名乗|名付)/.test(passage.slice(m.index! + m[0].length, m.index! + m[0].length + 3)))
    .map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
}

/** Where `name` is written in `text` followed by one of `after`, and not as part of a longer name. */
function writtenWith(text: string, name: string, after: RegExp): boolean {
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    const before = text[i - 1] ?? "";
    if (before !== "" && KANJI_OR_KATAKANA.test(before) && KANJI_OR_KATAKANA.test(name[0]!)) continue;
    if (after.test(text.slice(i + name.length, i + name.length + 2))) return true;
  }
  return false;
}

/** Who is named in a quotation as being spoken to: the name before an honorific, a comma or the end of the line. They are not the one speaking it. */
export function addressedIn(quote: string, speakers: readonly Speaker[]): Set<string> {
  const out = new Set<string>();
  for (const s of speakers) if (s.names.some((n) => writtenWith(quote, n, /^(?:」|、|，|さん|くん|ちゃん|様|君)/))) out.add(s.id);
  return out;
}

/**
 * The speaker of a quotation when the text beside it says so ("…」と花子は言った", "花子は笑って「…」"): exactly one person
 * written with は, が or も in the narration just after the quotation, else just before it. Otherwise null.
 */
export function speakerByForm(passage: string, quote: Quote, speakers: readonly Speaker[], quotes: readonly Quote[]): string | null {
  const next = quotes.find((q) => q.start >= quote.end);
  const after = passage.slice(quote.end, Math.min(next?.start ?? passage.length, quote.end + 40)).split(/[\r\n。]/)[0]!;
  const prior = [...quotes].reverse().find((q) => q.end <= quote.start);
  const before = passage.slice(Math.max(prior?.end ?? 0, quote.start - 40), quote.start).split(/[\r\n。]/).at(-1)!;
  for (const part of [after, before]) {
    const found = speakers.filter((s) => s.names.some((n) => writtenWith(part, n, /^(?:は|が|も)/)));
    if (found.length === 1) return found[0]!.id;
  }
  return null;
}

/**
 * With two people talking, lines that each stand on a line of their own are said by the two in turn. From the lines whose speaker
 * is known, the neighbours that are not known are filled in, unless the person it would give is the one named as spoken to in that line.
 * Narration between two lines does not change whose turn it is. Returns the speakers with the new ones filled in.
 */
export function takeTurns(passage: string, quotes: readonly Quote[], who: readonly (string | null)[], speakers: readonly Speaker[], carry?: { before: string; pair: readonly [string, string] } | null): (string | null)[] {
  const out = [...who];
  // The two who are talking: the two people of this block, or when the block carries on a conversation, the two of that conversation.
  const pair: readonly string[] | null = carry ? carry.pair : speakers.length === 2 ? speakers.map((s) => s.id) : null;
  if (!pair) return out;
  // A line of its own: it starts a paragraph, and after it comes at most a few words of narration ("…」と花子は言った。").
  const alone = (q: Quote) => {
    if (q.start !== 0 && passage[q.start - 1] !== "\n") return false;
    const rest = passage.slice(q.end).split("\n")[0]!;
    return !rest.includes("「") && rest.length <= 25;
  };
  const other = (id: string) => pair.find((p) => p !== id)!;
  const spokenTo = quotes.map((q) => addressedIn(q.text, speakers));
  // The line before this passage, said by `carry.before`, comes just before the first line here.
  const said = (j: number): string | null => (j === -1 ? (carry?.before ?? null) : (out[j] ?? null));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < quotes.length; i++) {
      if (out[i] !== null || !alone(quotes[i]!)) continue;
      const via = [i - 1, i + 1].find((j) => said(j) !== null && j < quotes.length && (j === -1 || alone(quotes[j]!)) && pair.includes(said(j)!));
      if (via === undefined) continue;
      const id = other(said(via)!);
      if (spokenTo[i]!.has(id)) continue;
      out[i] = id;
      changed = true;
    }
  }
  return out;
}

/** Shortens scene descriptions, without adding anything to them. */
export const condense = (title: string, scenes: readonly string[], maxWords: number, targetLanguage: string): Question => ({
  id: "condense",
  kind: "text",
  system: `You shorten scene descriptions of a chapter into one summary written in ${targetLanguage}. Use only what the descriptions say. Do not add any detail, name, reason or ending that is not in them. ${RULE}`,
  user: `Shorten these scene descriptions of the chapter 「${title}」 into one summary of at most ${maxWords} words, keeping every event. Reply with the summary only.\n\nSCENES:\n${scenes.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  maxTokens: Math.min(500, Math.round(maxWords * 2.5) + 40),
});

const KANA: Record<string, string> = {
  ア: "a", イ: "i", ウ: "u", エ: "e", オ: "o", カ: "ka", キ: "ki", ク: "ku", ケ: "ke", コ: "ko", サ: "sa", シ: "shi", ス: "su", セ: "se", ソ: "so",
  タ: "ta", チ: "chi", ツ: "tsu", テ: "te", ト: "to", ナ: "na", ニ: "ni", ヌ: "nu", ネ: "ne", ノ: "no", ハ: "ha", ヒ: "hi", フ: "fu", ヘ: "he", ホ: "ho",
  マ: "ma", ミ: "mi", ム: "mu", メ: "me", モ: "mo", ヤ: "ya", ユ: "yu", ヨ: "yo", ラ: "ra", リ: "ri", ル: "ru", レ: "re", ロ: "ro", ワ: "wa", ヲ: "o", ン: "n",
  ガ: "ga", ギ: "gi", グ: "gu", ゲ: "ge", ゴ: "go", ザ: "za", ジ: "ji", ズ: "zu", ゼ: "ze", ゾ: "zo", ダ: "da", ヂ: "ji", ヅ: "zu", デ: "de", ド: "do",
  バ: "ba", ビ: "bi", ブ: "bu", ベ: "be", ボ: "bo", パ: "pa", ピ: "pi", プ: "pu", ペ: "pe", ポ: "po", ヴ: "vu",
};

/** Katakana to plain Hepburn romaji, without macrons: ハナコ and ハナコ are both "hanako". Null when something is not katakana. */
export function romanize(kana: string): string | null {
  const chars = [...kana];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const next = chars[i + 1] ?? "";
    if (c === "ー") continue;
    if (c === "ッ") {
      const n = KANA[next];
      if (!n) return null;
      out += n.startsWith("ch") ? "t" : n[0]!;
      continue;
    }
    const base = KANA[c];
    if (!base) return null;
    if (c === "ウ" && /[ou]$/.test(out)) continue; // トウ, ユウ: a long vowel
    if (c === "オ" && /o$/.test(out)) continue;
    const glide = { ャ: "a", ュ: "u", ョ: "o" }[next as "ャ"];
    if (glide && base.length > 1 && base.endsWith("i")) {
      out += (base === "shi" ? "sh" : base === "chi" ? "ch" : base === "ji" ? "j" : `${base.slice(0, -1)}y`) + glide;
      i++;
      continue;
    }
    out += base;
  }
  return out;
}

/** The English name of a person or family from the readings of its words (["ミヅキ", "ハナコ"] gives "Suzuki Hanako"), or null. */
export function nameFromReadings(readings: readonly string[], family: boolean): string | null {
  const pieces = family && readings.at(-1) === "カ" ? readings.slice(0, -1) : readings;
  const words = pieces.map(romanize);
  if (words.length === 0 || words.some((w) => !w)) return null;
  const name = words.map((w) => w![0]!.toUpperCase() + w!.slice(1)).join(" ");
  return family ? `${name} family` : name;
}

