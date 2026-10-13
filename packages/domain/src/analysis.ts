import type { EntryDeps, EntryOrigin, KnowledgeEntry } from "./entries.js";

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
    entries: [...entries, { id: deps.newId(), kind: "summary", source: "", target: "", hint: "", category: "term", aliases: [], attrs: {}, attrFlags: [], text, about: null, related: [], scope: { documentId: scope.documentId }, origin, status: "suggested", updatedAt: at }],
    updated: true,
  };
}
