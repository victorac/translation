import type { EntryDeps, EntryOrigin, KnowledgeEntry, TermCategory } from "./entries.js";
import { splitNames } from "./knowledge.js";

/** A person, place or term found in a passage, with every way it was written there. */
export interface FoundEntity {
  category: TermCategory;
  /** The first is the main way it is written; the rest are other ways. */
  names: string[];
  target: string;
  summary: string;
}

/** What reading one passage found. */
export interface AnalysisResult {
  entities: FoundEntity[];
  /** "ALIAS" lines: a name that is another way of writing someone already known. */
  aliases: { alias: string; of: string }[];
  /** Facts, each about a person or term named as written in the passage (null when not about anyone in particular). */
  facts: { about: string | null; text: string }[];
  /** What is going on, and who is present. `continues` says the passage is part of the scene before it. */
  scene: { continues: boolean; present: string[]; text: string } | null;
}

const MAX_ENTITIES_PER_PASSAGE = 20;
const MAX_FACTS_PER_PASSAGE = 10;
const MAX_TEXT_CHARS = 500;

export function analysisSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  return `You help a translator prepare to translate fiction from ${sourceLanguage} to ${targetLanguage}. Read the passage and report only facts that help avoid mistakes with names, pronouns, who is speaking and who is being spoken to. Do not translate the passage.

Reply with plain lines and nothing else. The kinds of line are:
1. CHARACTER: for a person, PLACE: for a place, TERM: for any other special word. Then the name as written in the passage (if the same thing is written in other ways, list them after " / "), then "=", then the name in ${targetLanguage}, then "|", then a short summary: for a character, gender, age group, role and how they speak. Example: CHARACTER: 花子 / 花ちゃん = Hanako | girl, the narrator's classmate, speaks politely
2. ALIAS: a name as written, then "=", then the known name it is another way of writing. Use it when a name in the passage is the same as someone in KNOWN SO FAR. Example: ALIAS: 花ちゃん = 花子
3. FACT: the name as written, then "|", then one short sentence that stays true throughout the story: how that person speaks, how they address others, how they are related to others. Example: FACT: 花子 | Addresses the narrator as Taro-kun.
4. SCENE: exactly one line. First CONTINUES if this passage goes on in the same place and time as the scene before it, otherwise NEW. Then "|", the names of the people present as written, separated by commas, then "|", then one or two sentences describing the whole scene so far: where it is, what happens, who speaks to whom. Example: SCENE: CONTINUES | 花子, 太郎 | At the school gate after class, Hanako greets Taro and asks why he is waiting; Taro answers casually.

A section called KNOWN SO FAR lists what is already noted, with the scene before this passage. Do not repeat it. Add a character, place or term only if it is new. Write a line for something already known only if you learned something new, and then write its full updated summary. Add a fact only if it is new. If you are not sure about something, say so in the line (for example "probably a girl"). Always write the SCENE line.`;
}

/** A person, place or term already known, with the facts noted about it. */
export interface KnownTerm {
  category: TermCategory;
  source: string;
  aliases: string[];
  target: string;
  hint: string;
  facts: string[];
}

const CATEGORY_WORD: Record<TermCategory, string> = { character: "CHARACTER", place: "PLACE", term: "TERM" };

/** The request for one passage, as plain labelled text. */
export function analysisUserMessage(
  known: { terms: readonly KnownTerm[]; previousScene?: { text: string; from: number; to: number } | undefined; rejected?: readonly string[] | undefined },
  passage: string,
): string {
  const lines = known.terms.flatMap((t) => [
    `${CATEGORY_WORD[t.category]}: ${[t.source, ...t.aliases].join(" / ")} = ${t.target}${t.hint ? ` | ${t.hint}` : ""}`,
    ...t.facts.map((f) => `  fact: ${f}`),
  ]);
  const scene = known.previousScene;
  const parts: string[] = [];
  if (lines.length > 0 || scene) {
    const range = scene ? (scene.from === scene.to ? `block ${scene.from}` : `blocks ${scene.from} to ${scene.to}`) : "";
    parts.push(`KNOWN SO FAR:\n${[...lines, ...(scene ? [`The scene before this passage (${range}): ${scene.text}`] : [])].join("\n")}`);
  }
  if (known.rejected && known.rejected.length > 0) {
    parts.push(`REJECTED (the user checked these and they are wrong; do not suggest them again):\n${known.rejected.join("\n")}`);
  }
  parts.push(`PASSAGE:\n${passage}`);
  return parts.join("\n\n");
}

/** How a rejected entry is shown to the model, in the same format it writes its own lines. */
export function rejectedLine(e: KnowledgeEntry, entries: readonly KnowledgeEntry[]): string | null {
  if (e.kind === "term") return `${CATEGORY_WORD[e.category]}: ${[e.source, ...e.aliases].join(" / ")} = ${e.target}${e.hint ? ` | ${e.hint}` : ""}`;
  if (e.kind === "note") {
    const about = e.about ? entries.find((t) => t.id === e.about) : undefined;
    return about ? `FACT: ${about.source} | ${e.text}` : `FACT: ${e.text}`;
  }
  return null;
}

const cleanLine = (line: string): string =>
  line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .trim();

const names = (s: string) => s.split(/[,、，]/).map((n) => n.trim()).filter(Boolean);
const PREFIX = /^(character|person|place|term)\s*[:：]\s*(.+)$/i;

function parseEntity(category: TermCategory, body: string): FoundEntity | null {
  const m = /^(.*?)\s*(?:=>|->|→|=)\s*(.*)$/.exec(body);
  if (!m) return null;
  const written = splitNames(m[1]!);
  const rest = m[2]!;
  const sep = /\s*[|#]\s*/.exec(rest);
  const target = (sep ? rest.slice(0, sep.index) : rest).trim();
  const summary = (sep ? rest.slice(sep.index + sep[0].length) : "").trim().slice(0, MAX_TEXT_CHARS);
  if (written.length === 0 || target === "") return null;
  return { category, names: written, target, summary };
}

/** Reads the model's reply. Anything that is not one of the line kinds is ignored. */
export function parseAnalysisReply(reply: string): AnalysisResult {
  const entities: FoundEntity[] = [];
  const aliases: AnalysisResult["aliases"] = [];
  const facts: AnalysisResult["facts"] = [];
  let scene: AnalysisResult["scene"] = null;
  for (const raw of reply.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (line === "" || /^none\.?$/i.test(line)) continue;
    const word = /^(fact|scene|note|alias)\s*[:：]\s*(.+)$/i.exec(line);
    const kind = word?.[1]?.toLowerCase();
    if (kind === "scene") {
      if (scene) continue;
      const parts = word![2]!.split("|").map((p) => p.trim());
      const flag = /^(continues?|new)$/i.exec(parts[0] ?? "");
      const body = flag ? parts.slice(1) : parts;
      const text = (body.length > 1 ? body.slice(1).join(" | ") : (body[0] ?? "")).trim().slice(0, MAX_TEXT_CHARS);
      if (text !== "") scene = { continues: /^continues?$/i.test(flag?.[1] ?? ""), present: body.length > 1 ? names(body[0]!) : [], text };
    } else if (kind === "fact" || kind === "note") {
      if (facts.length >= MAX_FACTS_PER_PASSAGE) continue;
      const body = word![2]!;
      const bar = body.indexOf("|");
      const about = bar >= 0 ? body.slice(0, bar).trim() : "";
      const text = (bar >= 0 ? body.slice(bar + 1) : body).trim().slice(0, MAX_TEXT_CHARS);
      if (text !== "") facts.push({ about: about !== "" ? about : null, text });
    } else if (kind === "alias") {
      const m = /^(.*?)\s*(?:=>|->|→|=)\s*(.+)$/.exec(word![2]!);
      if (m && m[1]!.trim() !== "" && m[2]!.trim() !== "") aliases.push({ alias: m[1]!.trim(), of: m[2]!.trim() });
    } else {
      const p = PREFIX.exec(line);
      const category: TermCategory = p ? (/^place$/i.test(p[1]!) ? "place" : /^term$/i.test(p[1]!) ? "term" : "character") : "term";
      const e = parseEntity(category, p ? p[2]! : line);
      if (e && entities.length < MAX_ENTITIES_PER_PASSAGE) entities.push(e);
    }
  }
  return { entities, aliases, facts, scene };
}

// ---- matching what was found with what is already known ----

const lower = (s: string) => s.trim().toLocaleLowerCase();
const words = (s: string) => lower(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

/**
 * Finds the existing term that a found name is another way of writing, or undefined if it is new:
 *  1. one of its names is already a main or other way of writing a known term
 *  2. it has the same translation and category
 *  3. it is a person written longer or shorter (花子 and 佐藤花子) with a translation that shares a word
 */
export function findTerm(entries: readonly KnowledgeEntry[], found: Pick<FoundEntity, "category" | "names" | "target">): KnowledgeEntry | undefined {
  const terms = entries.filter((e) => e.kind === "term");
  const exact = terms.find((t) => found.names.some((n) => [t.source, ...t.aliases].some((w) => lower(w) === lower(n))));
  if (exact) return exact;
  const sameTarget = terms.find((t) => t.category === found.category && lower(t.target) === lower(found.target));
  if (sameTarget) return sameTarget;
  if (found.category !== "character") return undefined;
  const targetWords = new Set(words(found.target));
  return terms.find(
    (t) =>
      t.category === "character" &&
      words(t.target).some((w) => targetWords.has(w)) &&
      found.names.some((n) => [t.source, ...t.aliases].some((w) => n.length >= 2 && w.length >= 2 && (w.includes(n) || n.includes(w)))),
  );
}

/** Where a passage is, so what a model found can be tied to it. */
export interface AnalysisScope {
  documentId: string;
  /** The hash of the passage's text. */
  blockHash: string;
  /** The passage's block number, starting at 1. */
  block: number;
}

/**
 * Adds what a model found to the knowledge entries, as suggestions. Nothing the user wrote is changed:
 *  - something already known keeps its place; other ways of writing it become aliases, and a better summary replaces
 *    one that was only suggested (for confirmed entries it is offered as a new fact instead)
 *  - a fact is attached to the entry it is about, and is not repeated
 *  - the scene either continues the one before it, which grows to cover this block, or a new scene starts
 */
export function mergeSuggestions(entries: readonly KnowledgeEntry[], found: AnalysisResult, origin: EntryOrigin, scope: AnalysisScope, deps: EntryDeps, rejected: readonly KnowledgeEntry[] = []): { entries: KnowledgeEntry[]; added: number } {
  let next = [...entries];
  let added = 0;
  const at = deps.now();
  const blank = { source: "", target: "", hint: "", category: "term" as TermCategory, aliases: [] as string[], text: "", about: null, related: [] as string[], scope: null } as const;
  const update = (id: string, patch: Partial<KnowledgeEntry>) => (next = next.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: at } : e)));
  const termByName = (name: string) => next.find((e) => e.kind === "term" && [e.source, ...e.aliases].some((w) => lower(w) === lower(name)));
  const addFact = (about: string | null, text: string, status: "suggested" = "suggested") => {
    if (next.some((e) => e.kind === "note" && e.about === about && lower(e.text) === lower(text))) return;
    next.push({ ...blank, id: deps.newId(), kind: "note", text, about, origin, status, updatedAt: at });
    added++;
  };

  const rejectedTerms = rejected.filter((e) => e.kind === "term");
  const rejectedNotes = rejected.filter((e) => e.kind === "note");
  const nameOf = (id: string | null) => (id ? [...next, ...rejectedTerms].find((t) => t.id === id && t.kind === "term") : undefined);
  const isRejectedFact = (aboutName: string | null, text: string) =>
    rejectedNotes.some((n) => {
      if (lower(n.text) !== lower(text)) return false;
      const t = nameOf(n.about);
      return aboutName === null ? n.about === null : !!t && [t.source, ...t.aliases].some((w) => lower(w) === lower(aboutName));
    });

  for (const f of found.entities) {
    const hit = findTerm(next, f);
    if (!hit && findTerm(rejectedTerms, f)) continue; // the user already said this one is wrong
    if (!hit) {
      next.push({ ...blank, id: deps.newId(), kind: "term", source: f.names[0]!, aliases: f.names.slice(1), target: f.target, hint: f.summary, category: f.category, origin, status: "suggested", updatedAt: at });
      added++;
      continue;
    }
    const known = new Set([hit.source, ...hit.aliases].map(lower));
    const newNames = f.names.filter((n) => !known.has(lower(n)));
    const patch: Partial<KnowledgeEntry> = {};
    if (newNames.length > 0) patch.aliases = [...hit.aliases, ...newNames];
    if (hit.category === "term" && f.category !== "term" && hit.status === "suggested") patch.category = f.category;
    if (f.summary && lower(f.summary) !== lower(hit.hint)) {
      if (hit.hint.trim() === "" || hit.status === "suggested") patch.hint = f.summary;
      else addFact(hit.id, f.summary);
    }
    if (Object.keys(patch).length > 0) {
      update(hit.id, patch);
      added++;
    }
  }
  for (const a of found.aliases) {
    const target = termByName(a.of);
    if (!target || termByName(a.alias)) continue;
    update(target.id, { aliases: [...target.aliases, a.alias] });
    added++;
  }
  for (const f of found.facts) {
    const about = f.about ? (termByName(f.about)?.id ?? null) : null;
    if (f.about && about === null) continue; // about someone who is not listed: skip rather than leave it floating
    if (isRejectedFact(f.about, f.text)) continue;
    addFact(about, f.text);
  }

  if (found.scene) {
    const presentIds = [...new Set(found.scene.present.map((n) => termByName(n)?.id).filter((id): id is string => !!id))];
    const inDocument = next.filter((e) => e.kind === "scene" && e.scope?.documentId === scope.documentId);
    const here = inDocument.find((e) => e.scope?.blockHashes?.includes(scope.blockHash));
    const before = inDocument.find((e) => (e.scope?.blockEnd ?? e.scope?.block) === scope.block - 1);
    if (here) {
      // Read again: refresh a suggested scene, leave one the user confirmed.
      if (here.status === "suggested") update(here.id, { text: found.scene.text, related: [...new Set([...here.related, ...presentIds])], origin });
    } else if (found.scene.continues && before && before.status === "suggested") {
      update(before.id, {
        text: found.scene.text,
        related: [...new Set([...before.related, ...presentIds])],
        scope: { ...before.scope!, blockHashes: [...(before.scope!.blockHashes ?? []), scope.blockHash], blockEnd: scope.block },
        origin,
      });
      added++;
    } else {
      next.push({ ...blank, id: deps.newId(), kind: "scene", text: found.scene.text, related: presentIds, scope: { documentId: scope.documentId, blockHashes: [scope.blockHash], block: scope.block }, origin, status: "suggested", updatedAt: at });
      added++;
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
export function mergeSummary(entries: readonly KnowledgeEntry[], text: string, scope: { documentId: string }, origin: EntryOrigin, deps: EntryDeps): { entries: KnowledgeEntry[]; updated: boolean } {
  const at = deps.now();
  const i = entries.findIndex((e) => e.kind === "summary" && e.scope?.documentId === scope.documentId);
  if (i >= 0) {
    if (entries[i]!.status === "confirmed") return { entries: [...entries], updated: false };
    return { entries: entries.map((e, j) => (j === i ? { ...e, text, origin, updatedAt: at } : e)), updated: true };
  }
  return {
    entries: [...entries, { id: deps.newId(), kind: "summary", source: "", target: "", hint: "", category: "term", aliases: [], text, about: null, related: [], scope: { documentId: scope.documentId }, origin, status: "suggested", updatedAt: at }],
    updated: true,
  };
}
