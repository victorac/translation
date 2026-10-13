import type { KnowledgeEntry } from "./entries.js";
import { estimateTokens } from "./tokens.js";

/**
 * Choosing the background for a block is a job for a model: it reads the block and a numbered list of everything
 * known about the story, and says which entries matter for translating this block (including people who are only
 * implied, such as a speaker who is never named).
 */
export function researchSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  return `You prepare background for a translator who will translate fiction from ${sourceLanguage} to ${targetLanguage}. You are given a passage and a numbered list of what is known about the story: names, terms with hints, and notes.

Choose the entries that would help translate this passage correctly. Include people and terms that appear in it, people who are implied but not named (for example a speaker or someone being addressed), and notes that bear on this scene, such as who speaks to whom or how someone talks. Leave out entries that have nothing to do with this passage.

Reply with only the numbers of the entries you chose, separated by commas. If none apply, reply with NONE. Do not translate the passage and do not explain.`;
}

/** One line of the numbered list a model reads. */
export function entryLine(e: KnowledgeEntry): string {
  return e.kind === "term" ? `${e.source} = ${e.target}${e.hint ? ` (${e.hint})` : ""}` : `note: ${e.text}`;
}

export function researchUserMessage(passage: string, entries: readonly KnowledgeEntry[]): string {
  return `KNOWN SO FAR:\n${entries.map((e, i) => `${i + 1}. ${entryLine(e)}`).join("\n")}\n\nPASSAGE:\n${passage}`;
}

/** The entries a reply chose, by position in the list it was shown. Numbers outside the list are ignored. */
export function parseResearchReply(reply: string, count: number): number[] {
  if (/^\s*none\b/i.test(reply)) return [];
  const chosen = new Set<number>();
  for (const m of reply.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n >= 1 && n <= count) chosen.add(n - 1);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** Splits a long list into parts that each fit, with room left for the passage, the instructions and the reply. */
export function researchBatches(entries: readonly KnowledgeEntry[], budgetTokens: number): KnowledgeEntry[][] {
  const batches: KnowledgeEntry[][] = [];
  let current: KnowledgeEntry[] = [];
  let used = 0;
  for (const e of entries) {
    const cost = estimateTokens(entryLine(e)) + 4;
    if (current.length > 0 && used + cost > budgetTokens) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(e);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** What is remembered about one passage: which entries were chosen, and which were looked at when. */
export interface ResearchRecord {
  /** Entries chosen for the passage. */
  ids: string[];
  /** Every entry that was considered, so only new or changed ones need looking at next time. */
  seen: string[];
  /** When it was last looked at. */
  at: string;
}

/** The entries that still need to be considered for a passage: ones never seen, or changed since. */
export function entriesToConsider(entries: readonly KnowledgeEntry[], record: ResearchRecord | undefined): KnowledgeEntry[] {
  const candidates = entries.filter((e) => !e.pinned);
  if (!record) return candidates;
  const seen = new Set(record.seen);
  return candidates.filter((e) => !seen.has(e.id) || e.updatedAt > record.at);
}

/** The new record after considering `considered` and choosing `chosen` from them. */
export function updateRecord(record: ResearchRecord | undefined, entries: readonly KnowledgeEntry[], considered: readonly KnowledgeEntry[], chosen: readonly string[], at: string): ResearchRecord {
  const redone = new Set(considered.map((e) => e.id));
  const alive = new Set(entries.map((e) => e.id));
  const kept = (record?.ids ?? []).filter((id) => alive.has(id) && !redone.has(id));
  return { ids: [...new Set([...kept, ...chosen])], seen: entries.filter((e) => !e.pinned).map((e) => e.id), at };
}

/** The background for a block: what was chosen for it plus everything pinned. Null if nobody has looked at the block yet. */
export function chosenEntries(entries: readonly KnowledgeEntry[], record: ResearchRecord | undefined): KnowledgeEntry[] | null {
  const pinned = entries.filter((e) => e.pinned);
  if (!record) return entries.length === 0 ? [] : null;
  const ids = new Set(record.ids);
  return [...entries.filter((e) => ids.has(e.id) && !e.pinned), ...pinned];
}
