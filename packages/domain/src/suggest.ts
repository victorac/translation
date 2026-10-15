/**
 * Questions for a small model about a translated text, and the checks on its answers. Each question is short, has one answer that can be
 * checked in code (words copied from the translation, or a letter from a list), and nothing a model says is used unless it passes.
 */

/** A paragraph and its translation. */
export interface Evidence {
  source: string;
  translation: string;
}

const LETTERS = "ABCDEFGHIJ";
const RULE = "Answer with exactly what is asked and nothing else.";
const show = (pairs: readonly Evidence[], from: string, to: string): string => pairs.map((p) => `${from}: ${p.source}\n${to}: ${p.translation}`).join("\n\n");

/** Asks for the words of the translation that stand for a name. The answer has to be copied from the translation. */
export function nameQuestion(name: string, pairs: readonly Evidence[], from: string, to: string): { system: string; user: string } {
  return {
    system: `You read a story that was translated from ${from} into ${to}. ${RULE}`,
    user: `${show(pairs, from.toUpperCase(), to.toUpperCase())}\n\nWhich words of the ${to.toUpperCase()} text stand for 「${name}」? Copy them exactly from the ${to.toUpperCase()} text, and reply with those words only. If it is not written in the ${to.toUpperCase()} text, reply NONE.`,
  };
}

/** The words copied in a reply, as they are written in the translation; null when the reply is not words of the translation. */
export function copiedWords(reply: string, translations: readonly string[]): string | null {
  let t = (reply.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  t = t.replace(/^["'“”‘’「『(\[]+|["'“”‘’」』)\].,;:!?]+$/g, "").trim();
  if (t === "" || /^none$/i.test(t) || t.length > 80 || t.split(/\s+/).length > 6) return null;
  const wanted = t.toLocaleLowerCase();
  for (const text of translations) {
    const at = text.toLocaleLowerCase().indexOf(wanted);
    if (at >= 0) return text.slice(at, at + t.length);
  }
  return null;
}

/** A question with lettered options, the last of which is always "not stated". */
export function choiceQuestion(asked: string, options: readonly string[], pairs: readonly Evidence[], from: string, to: string): { system: string; user: string } {
  const lettered = [...options, "not stated"].map((o, i) => `${LETTERS[i]}) ${o}`).join("\n");
  return {
    system: `You read a story that was translated from ${from} into ${to}. ${RULE}`,
    user: `${show(pairs, from.toUpperCase(), to.toUpperCase())}\n\n${asked}\n\n${lettered}\n\nReply with the letter only.`,
  };
}

/** The option a reply chose (its index), or null when it chose "not stated" or did not answer with a letter of the list. */
export function chosenOption(reply: string, options: readonly string[]): number | null {
  const m = /^\s*[("']?([A-J])\b/i.exec(reply);
  if (!m) return null;
  const at = LETTERS.indexOf(m[1]!.toUpperCase());
  return at >= 0 && at < options.length ? at : null;
}

/** What the English pronouns in some texts say about who they are about: only when they are all one way. */
export function pronounGender(texts: readonly string[]): "male" | "female" | null {
  const all = texts.join("\n");
  const female = (all.match(/\b(she|her|hers|herself)\b/gi) ?? []).length;
  const male = (all.match(/\b(he|him|his|himself)\b/gi) ?? []).length;
  return female > 0 && male === 0 ? "female" : male > 0 && female === 0 ? "male" : null;
}

/** Asks who says a line of speech, with the translation of the paragraph (and the one before) to read. */
export function speakerQuestion(line: string, options: readonly string[], context: readonly string[], from: string, to: string): { system: string; user: string } {
  const lettered = [...options, "not stated"].map((o, i) => `${LETTERS[i]}) ${o}`).join("\n");
  return {
    system: `You read a story that was translated from ${from} into ${to}. ${RULE}`,
    user: `${to.toUpperCase()} TEXT:\n${context.join("\n\n")}\n\nThe ${from} line ${line} is in that text. Who says it?\n\n${lettered}\n\nReply with the letter only.`,
  };
}
