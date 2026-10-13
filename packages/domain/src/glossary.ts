import type { GlossaryEntry } from "./state.js";

export const MAX_GLOSSARY_ENTRIES = 500;
const MAX_TERM_CHARS = 200;
const MAX_NOTE_CHARS = 500;

export interface NormalizedGlossary {
  entries: GlossaryEntry[];
  /** Things the user should fix, in plain words. Entries with problems are left out. */
  problems: string[];
}

/**
 * Cleans a glossary: trims, drops empty rows, and keeps one entry per source term (the last one wins).
 * The translation may list alternatives separated by "|", for example "Demon King|Demon Lord":
 * the first is the one to use, and any of them counts as correct when checking.
 */
export function normalizeGlossary(raw: readonly GlossaryEntry[]): NormalizedGlossary {
  const problems: string[] = [];
  const bySource = new Map<string, GlossaryEntry>();
  raw.forEach((e, i) => {
    const source = e.source.trim();
    const target = e.target.trim();
    const note = e.note?.trim();
    if (source === "" && target === "") return;
    const row = `Glossary row ${i + 1}`;
    if (source === "") return void problems.push(`${row} has a translation but no source term.`);
    if (target === "") return void problems.push(`${row} ("${source}") has no translation.`);
    if (source.length > MAX_TERM_CHARS || target.length > MAX_TERM_CHARS) return void problems.push(`${row} ("${source.slice(0, 20)}…") is too long.`);
    if (note && note.length > MAX_NOTE_CHARS) return void problems.push(`${row} ("${source}") has too long a note.`);
    bySource.delete(source);
    bySource.set(source, { source, target, ...(note ? { note } : {}) });
  });
  const entries = [...bySource.values()];
  if (entries.length > MAX_GLOSSARY_ENTRIES) problems.push(`The glossary has ${entries.length} entries; at most ${MAX_GLOSSARY_ENTRIES} are allowed.`);
  return { entries: entries.slice(0, MAX_GLOSSARY_ENTRIES), problems };
}

/**
 * Reads pasted lines such as `魔王 = Demon King`, `Alice → アリス`, `勇者 -> Hero # the protagonist`
 * or tab-separated pairs. Lines that cannot be read are returned so the user can see them.
 */
export function parseGlossaryText(text: string): { entries: GlossaryEntry[]; skipped: string[] } {
  const entries: GlossaryEntry[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const [pair = "", ...noteParts] = line.split(/\s#\s/);
    const m = /^(.*?)\s*(?:=>|->|→|=|\t)\s*(.*)$/.exec(pair.trim());
    const source = m?.[1]?.trim() ?? "";
    const target = m?.[2]?.trim() ?? "";
    if (!m || source === "" || target === "") {
      skipped.push(line.trim());
      continue;
    }
    const note = noteParts.join(" # ").trim();
    entries.push({ source, target, ...(note ? { note } : {}) });
  }
  return { entries, skipped };
}

/** The accepted ways to write a term: the first is the preferred one. */
export const targetVariants = (target: string): string[] =>
  target
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);

const lower = (s: string): string => s.toLocaleLowerCase();

/** Only the entries whose source term appears in the given texts, so each request carries what it needs. */
export function relevantEntries(glossary: readonly GlossaryEntry[], ...texts: (string | null)[]): GlossaryEntry[] {
  const hay = texts.filter((t): t is string => !!t).map(lower);
  return glossary.filter((g) => hay.some((h) => h.includes(lower(g.source))));
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/gu;
const LETTER = /\p{L}/gu;
const CJK_TARGET = /japan|chinese|korean|mandarin|cantonese|日本|中文|中国|한국|한글/i;
const COMMENTARY = [
  /^\W*(here is|here's|here are)\b[^\n]{0,80}translat/i,
  /^\W*(sure|certainly|okay|ok|of course)\b[^\n]{0,40}\b(translat|here)/i,
  /^\W*\**translation\**\s*[:：]/i,
  /(^|\n)\s*\(?\[?(translator'?s )?note\s*[:：]/i,
];

/**
 * Cheap checks on a finished translation. They can be wrong (a term may be inflected, a note may be
 * wanted), so they only produce reasons for the user to look, never a verdict.
 */
export function checkTranslation(input: {
  source: string;
  output: string;
  glossary: readonly GlossaryEntry[];
  targetLanguage: string;
  /** `terms` skips the commentary and untranslated-text checks (used for the practice translator). */
  mode?: "all" | "terms";
}): string[] {
  const notes: string[] = [];
  const out = input.output;
  const lowOut = lower(out);

  const missing = relevantEntries(input.glossary, input.source).filter((g) => !targetVariants(g.target).some((v) => lowOut.includes(lower(v))));
  for (const g of missing.slice(0, 5)) {
    const wanted = targetVariants(g.target);
    notes.push(`Glossary: "${g.source}" should be "${wanted[0] ?? g.target}"${wanted.length > 1 ? ` (or ${wanted.slice(1).join(", ")})` : ""}, but that was not found.`);
  }
  if (missing.length > 5) notes.push(`…and ${missing.length - 5} more glossary terms were not found.`);

  if (input.mode === "terms") return notes;

  const head = out.trimStart().slice(0, 120);
  if (COMMENTARY.some((re) => re.test(head)) || COMMENTARY[3]!.test(out)) {
    notes.push("The reply may contain commentary or a note from the model, not only the translation.");
  }

  if (out.trim() !== "" && out.trim() === input.source.trim()) {
    notes.push("The reply is identical to the source text, so it may be untranslated.");
  } else if (!CJK_TARGET.test(input.targetLanguage)) {
    const letters = out.match(LETTER)?.length ?? 0;
    const cjk = out.match(CJK)?.length ?? 0;
    if (letters >= 10 && cjk / letters > 0.3 && (input.source.match(CJK)?.length ?? 0) > 0) {
      notes.push("Much of the reply is still in the source script, so parts may be untranslated.");
    }
  }
  return notes;
}

const ECHO_PATTERNS = [
  /^\s*[[{]\s*"(glossary|context|source_block)"\s*:/,
  /"(source_block|translation_status)"\s*:/,
  /^\s*(SOURCE_BLOCK|GLOSSARY)\s*:/m,
  /^\s*CONTEXT \(reference only/m,
  /^\s*(SCENE|STORY SO FAR|NOTES) \(/m,
];

/**
 * True when a reply is the request written back (JSON or the labelled sections) instead of a translation.
 * Such a reply is useless, and if kept it would be fed to the next block as context, so it counts as a failure.
 */
export function looksLikeEcho(output: string): boolean {
  const head = output.trimStart();
  return ECHO_PATTERNS.some((re) => re.test(head));
}
