/**
 * Asking a model for the names and terms of a passage of the source, before anything is translated: the dictionary finds only the
 * names it knows (水瀬灯 is to it two common nouns and a suffix), and it cannot tell a skill or a slang word from any other word.
 * Nothing the model says is used unless it is written in the passage, and what is found is a suggestion: a word of the text with no
 * English name yet.
 */

/** A word the model found, as written in the passage, and its kind (a class of the knowledge base). */
export interface FoundWord {
  source: string;
  kind: string;
}

/** A class of the knowledge base, and the word the model is told for it. */
export interface FindKind {
  name: string;
  word: string;
}

/** The word a model is told for a class: "person" reads better than the class's own name. */
export const kindWord = (name: string): string => (name === "character" ? "person" : name);

/** The paragraphs to read together (indices), in order: consecutive ones, up to about `size` characters a passage. */
export function passagesOf(paragraphs: readonly { at: number; text: string }[], size = 600): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let length = 0;
  let last = -2;
  for (const p of paragraphs) {
    if (cur.length > 0 && (p.at !== last + 1 || length + p.text.length > size)) {
      out.push(cur);
      cur = [];
      length = 0;
    }
    cur.push(p.at);
    length += p.text.length;
    last = p.at;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** The question: every name and special term of the passage, one a line, as `word | kind`. */
export function findQuestion(passage: string, kinds: readonly FindKind[], from: string): { system: string; user: string } {
  const words = kinds.map((k) => k.word).join(", ");
  return {
    system: `You find the names and special terms in a passage of a story written in ${from}. Answer with exactly what is asked and nothing else.`,
    user: [
      `PASSAGE:\n${passage}`,
      `List every name and special term in the passage: people, families, places, organizations, skills and spells, slang, and other words with a special meaning in this story. Leave out ordinary words.`,
      `Write one per line as:  word | kind`,
      `Copy each word exactly as it is written in the passage, without brackets or honorifics. The kind is one of: ${words}.`,
      `If there are none, reply NONE.`,
    ].join("\n\n"),
  };
}

const BRACKETS = /^[\s"'“”‘’「」『』【】（）()[\]<>《》〈〉]+|[\s"'“”‘’「」『』【】（）()[\]<>《》〈〉。、,.]+$/g;
const HONORIFIC = /(さん|さま|様|くん|君|ちゃん|殿|先輩|先生)$/;
/** A word worth a row of its own: some letters, not only a kana or two, and short enough to be a name or a term. */
const wordLike = (w: string): boolean => /\p{L}/u.test(w) && w.length <= 20 && !/^[\p{Script=Hiragana}ー]{1,2}$/u.test(w) && !/\s/.test(w);

/**
 * The words a reply found that are written in the passage, each once, with a kind of the list (a kind it does not know is a term).
 * A line that is not `word | kind`, or a word the passage does not have, is thrown away.
 */
export function foundWords(reply: string, passage: string, kinds: readonly FindKind[]): FoundWord[] {
  const kindOf = (said: string): string => {
    const k = said.trim().toLocaleLowerCase().replace(/[.。]$/, "");
    const hit = kinds.find((x) => x.word === k || x.name === k) ?? kinds.find((x) => `${x.word}s` === k || `${x.name}s` === k);
    return hit?.name ?? "term";
  };
  const out: FoundWord[] = [];
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•・]|\d+[.)、])\s*/, "");
    const parts = line.split(/[|｜]/);
    if (parts.length < 2) continue;
    let source = parts[0]!.replace(BRACKETS, "").trim();
    // A name with an honorific is the name: 灯ちゃん is 灯.
    const bare = source.replace(HONORIFIC, "");
    if (bare !== source && bare !== "" && passage.includes(bare)) source = bare;
    if (source === "" || !wordLike(source) || !passage.includes(source) || out.some((f) => f.source === source)) continue;
    out.push({ source, kind: kindOf(parts[1]!) });
  }
  return out;
}
