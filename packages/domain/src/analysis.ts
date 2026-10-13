import type { EntryDeps, EntryOrigin, KnowledgeEntry } from "./entries.js";

// ---- the summary of a whole document ----

/** Stores a generated summary for a document. A summary the user wrote or confirmed is kept, unless a rewrite was asked for. */
export function mergeSummary(entries: readonly KnowledgeEntry[], text: string, scope: { documentId: string }, origin: EntryOrigin, deps: EntryDeps, rewrite = false): { entries: KnowledgeEntry[]; updated: boolean } {
  const at = deps.now();
  const i = entries.findIndex((e) => e.kind === "summary" && e.scope?.documentId === scope.documentId);
  if (i >= 0) {
    if (entries[i]!.status === "confirmed" && !rewrite) return { entries: [...entries], updated: false };
    return { entries: entries.map((e, j) => (j === i ? { ...e, text, origin, status: "suggested" as const, updatedAt: at } : e)), updated: true };
  }
  return {
    entries: [...entries, { id: deps.newId(), kind: "summary", source: "", target: "", hint: "", category: "term", aliases: [], attrs: {}, attrFlags: [], text, about: null, related: [], scope: { documentId: scope.documentId }, origin, status: "suggested", updatedAt: at }],
    updated: true,
  };
}
