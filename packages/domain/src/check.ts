import type { ClassDef } from "./classes.js";
import type { EntryDeps, KnowledgeEntry } from "./entries.js";
import { resolveName } from "./topicfile.js";

/** Something in the knowledge base that looks wrong and is worth a person's attention. */
export interface CheckIssue {
  /** The topic it is about. */
  about: string;
  text: string;
}

export const CHECK_PREFIX = "Check: ";

const lower = (s: string) => s.trim().toLocaleLowerCase();
const names = (e: KnowledgeEntry) => [e.source, ...e.aliases];

/**
 * Looks over the whole knowledge base for things that cannot all be right, without asking a model:
 *  - two topics that share a name or another spelling
 *  - two topics of one kind with the same English name (probably one person written two ways)
 *  - a link that leads nowhere, or to the wrong kind of topic
 *  - a value that is not one of the choices of its attribute
 *  - a topic with no English name
 */
export function checkKnowledge(entries: readonly KnowledgeEntry[], classes: readonly ClassDef[]): CheckIssue[] {
  const live = entries.filter((e) => e.status !== "rejected");
  const topics = live.filter((e) => e.kind === "term");
  const issues: CheckIssue[] = [];
  const pairs = new Set<string>();
  const once = (a: KnowledgeEntry, b: KnowledgeEntry, text: string, about: KnowledgeEntry) => {
    const key = [a.id, b.id].sort().join("|") + text;
    if (pairs.has(key)) return;
    pairs.add(key);
    issues.push({ about: about.id, text });
  };

  topics.forEach((a, i) => {
    for (const b of topics.slice(i + 1)) {
      const shared = names(a).find((n) => names(b).some((m) => lower(m) === lower(n)));
      if (shared) once(a, b, `${CHECK_PREFIX}"${shared}" is a name of both ${a.source} and ${b.source}. Are they the same?`, b);
      else if (a.category === b.category && a.target.trim() !== "" && lower(a.target) === lower(b.target)) once(a, b, `${CHECK_PREFIX}${a.source} and ${b.source} are both translated as "${a.target}". Are they the same?`, b);
    }
  });

  for (const t of topics) {
    if (t.target.trim() === "") issues.push({ about: t.id, text: `${CHECK_PREFIX}this topic has no English name.` });
    const cls = classes.find((c) => c.name === t.category);
    for (const def of cls?.attributes ?? []) {
      for (const v of t.attrs[def.key] ?? []) {
        if (def.kind === "choice" && def.choices && !def.choices.some((c) => lower(c) === lower(v))) issues.push({ about: t.id, text: `${CHECK_PREFIX}"${v}" is not a choice for ${def.key} (${def.choices.join(", ")}).` });
        if (def.kind === "link" || def.kind === "links") {
          const target = resolveName(v, live);
          if (!target) issues.push({ about: t.id, text: `${CHECK_PREFIX}${def.key} points to "${v}", but there is no such topic.` });
          else if (def.target && target.category !== def.target) issues.push({ about: t.id, text: `${CHECK_PREFIX}${def.key} points to "${v}", which is a ${target.category}, not a ${def.target}.` });
        }
      }
    }
  }
  return issues;
}

/**
 * Makes the issues visible as suggested notes on the topics they are about, beginning with "Check:". An issue that was
 * already noted (or that the user deleted from the notes) is not added again, and a check note whose issue has been
 * fixed goes away by itself.
 */
export function applyChecks(entries: readonly KnowledgeEntry[], rejected: readonly KnowledgeEntry[], issues: readonly CheckIssue[], deps: EntryDeps): { entries: KnowledgeEntry[]; added: number; removed: number } {
  const wanted = new Set(issues.map((i) => `${i.about}\u0000${i.text}`));
  const isCheck = (e: KnowledgeEntry) => e.kind === "note" && e.text.startsWith(CHECK_PREFIX);
  const gone = entries.filter((e) => isCheck(e) && e.status === "suggested" && !wanted.has(`${e.about}\u0000${e.text}`));
  const kept = entries.filter((e) => !gone.includes(e));
  const known = new Set([...kept, ...rejected].filter(isCheck).map((e) => `${e.about}\u0000${e.text}`));
  const at = deps.now();
  const fresh = issues
    .filter((i) => !known.has(`${i.about}\u0000${i.text}`))
    .map(
      (i): KnowledgeEntry => ({ id: deps.newId(), kind: "note", source: "", target: "", hint: "", category: "term", aliases: [], attrs: {}, attrFlags: [], text: i.text, about: i.about, related: [], scope: null, origin: { by: "model", model: "checks" }, status: "suggested", updatedAt: at }),
    );
  return { entries: [...kept, ...fresh], added: fresh.length, removed: gone.length };
}
