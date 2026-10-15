import {
  normalizeSource,
} from "./normalize.js";
import {
  paragraphsOf,
} from "./paragraphs.js";
import {
  labelDocument,
  syncParagraphs,
  type Word,
  type Work,
  type WorkParagraph,
} from "./work.js";

/** The work on a document as the app kept it when it went block by block. Only read, to bring older projects over. */
export interface LegacyBlocks {
  documentId: string;
  blocks: {
    text: string;
    translation: string;
    parts: string[];
    interpretation: { names: Word[]; lines: { text: string; speaker: string | null }[] } | null;
  }[];
}

/**
 * The work on a document from the blocks of an older project: every word the blocks had (the first of each), the translation of every
 * paragraph, and who says each line as the user had set it. Paragraphs are matched to the text as it is now, so the work of a text that
 * was edited afterwards is kept where the paragraph is the same.
 */
export function workFromBlocks(old: LegacyBlocks, text: string): Work {
  const source = normalizeSource(text);
  const words: Word[] = [];
  for (const b of old.blocks) for (const n of b.interpretation?.names ?? []) if (!words.some((w) => w.source === n.source)) words.push(n);

  const translated: WorkParagraph[] = old.blocks.flatMap((b) => {
    const texts = paragraphsOf(b.text).map((p) => p.text);
    // A block saved as one piece of translation has it matched to its paragraphs when the number is the same, else all of it in the first.
    const pieces = b.parts.length === texts.length ? b.parts : b.translation.trim() !== "" ? (paragraphsOf(b.translation).length === texts.length ? paragraphsOf(b.translation).map((p) => p.text) : [b.translation, ...texts.slice(1).map(() => "")]) : texts.map(() => "");
    return texts.map((t, i) => ({ text: t, translation: (pieces[i] ?? "").trim() }));
  });
  const paragraphs = syncParagraphs(translated, source);

  // What the user set for a line stays with it: by the text of the line, and which time it is said.
  const said = new Map<string, string | null>();
  const seen = new Map<string, number>();
  for (const b of old.blocks) {
    for (const l of b.interpretation?.lines ?? []) {
      const n = seen.get(l.text) ?? 0;
      seen.set(l.text, n + 1);
      said.set(`${l.text}#${n}`, l.speaker);
    }
  }
  const counted = new Map<string, number>();
  const preset: (string | null)[] = [];
  for (const m of source.matchAll(/「[^」]*」/g)) {
    const n = counted.get(m[0]) ?? 0;
    counted.set(m[0], n + 1);
    preset.push(said.get(`${m[0]}#${n}`) ?? null);
  }
  // Lines are labelled in the order of findQuotes, which skips a few quotations; the preset by position is right for the ones that count.
  return { documentId: old.documentId, source, words, lines: labelDocument(source, words, presetFor(source, preset)), paragraphs, error: null };
}

/** The preset by quotation, as a preset by line: the lines are the quotations that findQuotes keeps, in order. */
function presetFor(source: string, byQuotation: readonly (string | null)[]): (string | null)[] {
  const all = [...source.matchAll(/「[^」]*」/g)];
  const kept = all.filter((m) => !/^と(?:呼|称|名乗|名付)/.test(source.slice(m.index! + m[0].length, m.index! + m[0].length + 3)));
  return kept.map((m) => byQuotation[all.indexOf(m)] ?? null);
}
