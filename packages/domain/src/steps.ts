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

export const englishName = (name: string, kind: string, context: string, targetLanguage: string, strict = false): Question => ({
  id: "english-name",
  kind: "text",
  system: `You translate names in fiction into ${targetLanguage}. ${RULE}`,
  user: `Give the ${targetLanguage} name that should be used for 「${name}」 (${kind}) in a ${targetLanguage} translation: romanize the names of people, and translate the meaning of places and organizations when that reads naturally. Reply with the name only.${strict ? ` Your first answer was not a plain name. Reply with the name and nothing else: at most 4 words, no explanation.` : ""}\n\nPASSAGE:\n${context}`,
  maxTokens: 30,
});

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

export const narratorQuestion = (word: string, people: string[], context: string): Question =>
  choice("narrator", "You read fiction closely.", `This passage is told in the first person: the narrator calls himself or herself 「${word}」. Which of these people is the narrator?\n\nPASSAGE:\n${context}`, [...people, "None of them, or it cannot be told"]);

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
export function takeTurns(passage: string, quotes: readonly Quote[], who: readonly (string | null)[], speakers: readonly Speaker[]): (string | null)[] {
  const out = [...who];
  if (speakers.length !== 2) return out;
  // A line of its own: it starts a paragraph, and after it comes at most a few words of narration ("…」と花子は言った。").
  const alone = (q: Quote) => {
    if (q.start !== 0 && passage[q.start - 1] !== "\n") return false;
    const rest = passage.slice(q.end).split("\n")[0]!;
    return !rest.includes("「") && rest.length <= 25;
  };
  const other = (id: string) => speakers.find((s) => s.id !== id)!.id;
  const spokenTo = quotes.map((q) => addressedIn(q.text, speakers));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < quotes.length; i++) {
      if (out[i] !== null || !alone(quotes[i]!)) continue;
      const via = [i - 1, i + 1].find((j) => out[j] != null && j >= 0 && j < quotes.length && alone(quotes[j]!));
      if (via === undefined) continue;
      const id = other(out[via]!);
      if (spokenTo[i]!.has(id)) continue;
      out[i] = id;
      changed = true;
    }
  }
  return out;
}

/** Who says this line? `context` shows the passage with the line marked and the speakers settled so far written before their lines. */
export const speakerQuestion = (line: string, people: string[], context: string): Question =>
  choice("speaker", "You read fiction closely.", `Who says the line marked >> << in this passage: ${line}\n\nThe people who may be speaking are listed below. Lines are often said by the two people taking turns, and a person named inside a line is usually the one spoken to, not the one speaking.\n\nPASSAGE:\n${context}`, [...people, "It cannot be told"]);

/** Do two descriptions of passages that follow each other belong to one scene? */
export const sameSceneByDescription = (first: string, second: string): Question =>
  choice(
    "same-scene",
    "You follow the scenes of a story.",
    `These are descriptions of two passages of a story that follow each other. Do they take place in the same place and at the same time, as one continuous scene?\n\nFIRST: ${first}\nSECOND: ${second}`,
    ["Yes, one continuous scene", "No, the second one is a different scene"],
  );

/** Shortens scene descriptions, without adding anything to them. */
export const condense = (title: string, scenes: readonly string[], maxWords: number, targetLanguage: string): Question => ({
  id: "condense",
  kind: "text",
  system: `You shorten scene descriptions of a chapter into one summary written in ${targetLanguage}. Use only what the descriptions say. Do not add any detail, name, reason or ending that is not in them. ${RULE}`,
  user: `Shorten these scene descriptions of the chapter 「${title}」 into one summary of at most ${maxWords} words, keeping every event. Reply with the summary only.\n\nSCENES:\n${scenes.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  maxTokens: Math.min(500, Math.round(maxWords * 2.5) + 40),
});

export const sceneText = (
  passage: string,
  targetLanguage: string,
  names: { source: string; target: string }[] = [],
  narrator: { word: string; name: string } | null = null,
  strict = false,
  labelled = false,
): Question => ({
  id: "scene-text",
  kind: "text",
  system: `You describe what happens in a passage of a story, in ${targetLanguage}. ${RULE}`,
  user: `In at most 35 words, say what happens in this passage: who does what, and to whom. Be careful about who is waiting for whom, who arrives and who is speaking. Do not quote the passage and do not use any Japanese characters.${names.length > 0 ? `\n\nWrite names like this: ${names.map((n) => `${n.source} = ${n.target}`).join("; ")}.` : ""}${narrator ? ` The narrator, the one who says ${narrator.word} about himself or herself, is ${narrator.name}.` : ""}${labelled ? ` Lines written as [Name] 「…」 are said by that person.` : ""}${strict ? `\n\nYour first answer could not be used. Write only ${targetLanguage}, with no Japanese or Chinese characters at all, and describe only what the passage says.` : ""}\n\nPASSAGE:\n${passage.slice(0, 1500)}`,
  maxTokens: 120,
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

/** The English name of a person or family from the readings of its words (["ミヅキ", "ハナコ"] gives "Hanako Suzuki"), or null. */
export function nameFromReadings(readings: readonly string[], family: boolean): string | null {
  const pieces = family && readings.at(-1) === "カ" ? readings.slice(0, -1) : readings;
  const words = pieces.map(romanize);
  if (words.length === 0 || words.some((w) => !w)) return null;
  const name = words.map((w) => w![0]!.toUpperCase() + w!.slice(1)).join(" ");
  return family ? `${name} family` : name;
}

/** Words that tell a description is about a person, which a place, an organization or a family is not. */
export const PERSON_WORDS = /\b(student|boy|girl|man|woman|male|female|he|she|his|her|him|heir|son|daughter|protagonist|narrator|person)\b/i;

/** A name is short and plain: no sentence, no list, no explanation. */
export function plausibleName(reply: string, name: string): boolean {
  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1 || name.length > 60) return false;
  return !/[,;:!?、。]/.test(name) && name.split(/\s+/).length <= 5 && !/\b(is|are|was|were|am|i|my|me|who|that|which)\b/i.test(name);
}

/**
 * What a person does in a passage, when the way their name is written settles it, so the model need not be asked:
 * a name followed by は or が is the one acting (0), and a name inside a quotation just before 」 or 、 is being spoken to (1).
 * Anything else is left to the model (null).
 */
export function roleByForm(sentences: readonly Sentence[], names: readonly string[]): number | null {
  const lonely = (s: string, n: string, after: string) => {
    for (let i = s.indexOf(n); i >= 0; i = s.indexOf(n, i + 1)) {
      const before = s[i - 1] ?? "";
      if (before !== "" && KANJI_OR_KATAKANA.test(before) && KANJI_OR_KATAKANA.test(n[0]!)) continue;
      const next = s.slice(i + n.length, i + n.length + 3);
      if (new RegExp(`^(?:${after})`).test(next)) return true;
    }
    return false;
  };
  for (const s of sentences) for (const n of names) if (lonely(s.text, n, "は|が|も")) return 0;
  for (const s of sentences) {
    if (!/[「『]/.test(s.text)) continue;
    for (const n of names) if (lonely(s.text, n, "」|』|、|，|さん|くん|ちゃん|様|君")) return 1;
  }
  return null;
}

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
export function parseShortText(reply: string, maxChars: number, dropFinalPeriod = false): string | null {
  const line = reply.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (!line) return null;
  const clean = line.replace(/^["'「『“]+|["'」』”]+$/g, "").replace(/^(answer|name|description)\s*[:：]\s*/i, "").trim();
  const result = dropFinalPeriod ? clean.replace(/[.。]+$/, "").trim() : clean;
  if (result === "" || /^unknown\.?$/i.test(result) || result.length > maxChars) return null;
  return result;
}
