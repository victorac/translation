import type { EntryDeps, EntryOrigin, EntryScope, KnowledgeEntry } from "./entries.js";
import { parseGlossaryText } from "./glossary.js";
import { serializeTerm } from "./knowledge.js";
import type { GlossaryEntry } from "./state.js";

/** What reading one passage found. */
export interface AnalysisResult {
  /** People and terms. */
  characters: GlossaryEntry[];
  /** Facts, each about a person or term named as written in the passage (null when not about anyone in particular). */
  facts: { about: string | null; text: string }[];
  /** What is going on in the passage, and who is present. */
  scene: { present: string[]; text: string } | null;
}

const MAX_CHARACTERS_PER_PASSAGE = 20;
const MAX_FACTS_PER_PASSAGE = 10;
const MAX_TEXT_CHARS = 400;

export function analysisSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  return `You help a translator prepare to translate fiction from ${sourceLanguage} to ${targetLanguage}. Read the passage and report only facts that help avoid mistakes with names, pronouns, who is speaking and who is being spoken to. Do not translate the passage.

Reply with plain lines and nothing else. There are three kinds of line.
1. PERSON: for each named person or recurring term: the name as written in the passage, then "=", then the name in ${targetLanguage}, then "#", then a short hint (gender, age group, role). Example: PERSON: 花子 = Hanako # girl, the narrator's classmate
2. FACT: the name as written in the passage, then "|", then one short sentence that stays true throughout the story about that person or term: how they speak, how they address others, how they are related to others. Example: FACT: 花子 | Speaks politely and addresses the narrator as Taro-kun.
3. SCENE: exactly one line for the passage: the names of the people present as written in the passage, separated by commas, then "|", then one or two sentences saying where this is, what happens, and who speaks to whom. Example: SCENE: 花子, 太郎 | At the school gate after class, Hanako greets Taro and asks why he is waiting; Taro answers casually.

A section called KNOWN SO FAR lists what is already noted, with the scene of the passage before this one. Do not repeat it. Add a person only if they are new, and add a fact only if it is new. If you are not sure about something, say so in the line (for example "probably a girl"). Always write the SCENE line.`;
}

/** A person or term already known, with the facts noted about them. */
export interface KnownTerm {
  source: string;
  target: string;
  hint: string;
  facts: string[];
}

/** The request for one passage, as plain labelled text. */
export function analysisUserMessage(known: { terms: readonly KnownTerm[]; previousScene?: string | undefined }, passage: string): string {
  const lines = known.terms.flatMap((t) => [serializeTerm({ source: t.source, target: t.target, ...(t.hint ? { note: t.hint } : {}) }), ...t.facts.map((f) => `  fact: ${f}`)]);
  const parts: string[] = [];
  if (lines.length > 0 || known.previousScene) {
    parts.push(`KNOWN SO FAR:\n${[...lines, ...(known.previousScene ? [`The passage before this one: ${known.previousScene}`] : [])].join("\n")}`);
  }
  parts.push(`PASSAGE:\n${passage}`);
  return parts.join("\n\n");
}

const cleanLine = (line: string): string =>
  line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();

const names = (s: string) => s.split(/[,、，]/).map((n) => n.trim()).filter(Boolean);

/** Reads the model's reply. Anything that is not one of the line kinds is ignored. */
export function parseAnalysisReply(reply: string): AnalysisResult {
  const characterLines: string[] = [];
  const facts: AnalysisResult["facts"] = [];
  let scene: AnalysisResult["scene"] = null;
  for (const raw of reply.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (line === "" || /^none\.?$/i.test(line)) continue;
    const fact = /^fact\s*[:：]\s*(.+)$/i.exec(line);
    const sceneLine = /^scene\s*[:：]\s*(.+)$/i.exec(line);
    const note = /^note\s*[:：]\s*(.+)$/i.exec(line);
    const person = /^(?:person|term)\s*[:：]\s*(.+)$/i.exec(line);
    if (sceneLine) {
      const [head, ...rest] = sceneLine[1]!.split("|");
      const text = (rest.length > 0 ? rest.join("|") : head!).trim().slice(0, MAX_TEXT_CHARS);
      if (text !== "" && !scene) scene = { present: rest.length > 0 ? names(head!) : [], text };
    } else if (fact || note) {
      if (facts.length >= MAX_FACTS_PER_PASSAGE) continue;
      const body = (fact ?? note)![1]!;
      const bar = body.indexOf("|");
      const about = bar >= 0 ? body.slice(0, bar).trim() : "";
      const text = (bar >= 0 ? body.slice(bar + 1) : body).trim().slice(0, MAX_TEXT_CHARS);
      if (text !== "") facts.push({ about: about !== "" ? about : null, text });
    } else if (person) {
      characterLines.push(person[1]!);
    } else if (/[=→]|->/.test(line)) {
      characterLines.push(line);
    }
  }
  const characters = parseGlossaryText(characterLines.join("\n")).entries.slice(0, MAX_CHARACTERS_PER_PASSAGE);
  return { characters, facts, scene };
}

/**
 * Adds what a model found to the knowledge entries, as suggestions. Nothing the user wrote is changed:
 *  - a term that is already listed only gets a hint if its hint was empty
 *  - a fact is attached to the term it is about, and is not repeated
 *  - the passage's scene is added, or replaces an earlier suggested scene for the same text (a confirmed one is kept)
 */
export function mergeSuggestions(
  entries: readonly KnowledgeEntry[],
  found: AnalysisResult,
  origin: EntryOrigin,
  scope: EntryScope,
  deps: EntryDeps,
): { entries: KnowledgeEntry[]; added: number } {
  let next = [...entries];
  let added = 0;
  const at = deps.now();
  const blank = { source: "", target: "", hint: "", text: "", about: null, related: [] as string[], scope: null } as const;
  const termId = (source: string) => next.find((e) => e.kind === "term" && e.source.trim() === source.trim())?.id;

  for (const c of found.characters) {
    const i = next.findIndex((e) => e.kind === "term" && e.source.trim() === c.source);
    if (i < 0) {
      next.push({ ...blank, id: deps.newId(), kind: "term", source: c.source, target: c.target, hint: c.note ?? "", origin, status: "suggested", updatedAt: at });
      added++;
    } else if (!next[i]!.hint.trim() && c.note) {
      next = next.map((e, j) => (j === i ? { ...e, hint: c.note!, updatedAt: at } : e));
      added++;
    }
  }
  for (const f of found.facts) {
    const about = f.about ? (termId(f.about) ?? null) : null;
    if (f.about && about === null) continue; // about someone who is not listed: skip rather than leave it floating
    const same = (e: KnowledgeEntry) => e.kind === "note" && e.about === about && e.text.toLocaleLowerCase() === f.text.toLocaleLowerCase();
    if (next.some(same)) continue;
    next.push({ ...blank, id: deps.newId(), kind: "note", text: f.text, about, origin, status: "suggested", updatedAt: at });
    added++;
  }
  if (found.scene && scope.blockHash) {
    const related = [...new Set(found.scene.present.map(termId).filter((id): id is string => !!id))];
    const existing = next.findIndex((e) => e.kind === "scene" && e.scope?.blockHash === scope.blockHash && e.scope?.documentId === scope.documentId);
    if (existing < 0) {
      next.push({ ...blank, id: deps.newId(), kind: "scene", text: found.scene.text, related, scope, origin, status: "suggested", updatedAt: at });
      added++;
    } else if (next[existing]!.status === "suggested") {
      next = next.map((e, j) => (j === existing ? { ...e, text: found.scene!.text, related, origin, updatedAt: at } : e));
    }
  }
  return { entries: next, added };
}

// ---- the summary of a whole document ----

export function summarySystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  return `You help a translator who is translating fiction from ${sourceLanguage} to ${targetLanguage}. You are given short descriptions of the scenes of a chapter, in order. Write an abridged version of the chapter in ${targetLanguage}: who the people are, what happens, and how it ends. Use at most 120 words, in plain prose. Reply with the summary only.`;
}

export function summaryUserMessage(title: string, scenes: readonly string[]): string {
  return `CHAPTER: ${title}\n\nSCENES:\n${scenes.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

/** Stores a generated summary for a document. A summary the user wrote or confirmed is kept. */
export function mergeSummary(entries: readonly KnowledgeEntry[], text: string, scope: EntryScope, origin: EntryOrigin, deps: EntryDeps): { entries: KnowledgeEntry[]; updated: boolean } {
  const at = deps.now();
  const i = entries.findIndex((e) => e.kind === "summary" && e.scope?.documentId === scope.documentId);
  if (i >= 0) {
    if (entries[i]!.status === "confirmed") return { entries: [...entries], updated: false };
    return { entries: entries.map((e, j) => (j === i ? { ...e, text, origin, updatedAt: at } : e)), updated: true };
  }
  return {
    entries: [...entries, { id: deps.newId(), kind: "summary", source: "", target: "", hint: "", text, about: null, related: [], scope: { documentId: scope.documentId }, origin, status: "suggested", updatedAt: at }],
    updated: true,
  };
}
