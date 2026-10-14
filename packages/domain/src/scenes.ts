import type { EntryDeps, KnowledgeEntry } from "./entries.js";
import type { Asker } from "./extract.js";
import { parseChoice } from "./steps.js";
import { reversed, sameSceneByDescription } from "./steps.js";
import { buildSummary } from "./summary.js";

export interface MergedScenes {
  entries: KnowledgeEntry[];
  /** How many scenes were joined into the one before them. */
  joined: number;
  canceled: boolean;
}

/**
 * Second step of the scenes. Every passage has a scene description of its own; here neighbouring ones that belong
 * together are joined into one scene. Each pair of neighbours gets one small question (asked in both orders, and the
 * pair is only joined if both answers say yes), and the joined scene's description is the descriptions put together,
 * shortened only if they get long. Scenes the user accepted, or that have no description, are left alone.
 */
export async function mergeScenes(input: {
  entries: readonly KnowledgeEntry[];
  documentId: string;
  title: string;
  targetLanguage: string;
  asker: Asker;
  room: number;
  deps: EntryDeps;
  shouldStop?: () => boolean;
}): Promise<MergedScenes> {
  const at = input.deps.now();
  const scenes = input.entries
    .filter((e) => e.kind === "scene" && e.scope?.documentId === input.documentId)
    .sort((a, b) => (a.scope?.block ?? 0) - (b.scope?.block ?? 0));
  const free = (e: KnowledgeEntry) => e.status === "suggested" && e.text.trim() !== "";
  const runs: KnowledgeEntry[][] = [];
  for (const s of scenes) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    let together = false;
    if (run && last && free(last) && free(s) && (last.scope?.blockEnd ?? last.scope?.block ?? 0) + 1 === (s.scope?.block ?? -1)) {
      if (input.shouldStop?.()) return { entries: [...input.entries], joined: 0, canceled: true };
      const q = sameSceneByDescription(last.text, s.text);
      const first = await input.asker.ask(q);
      if (first === null) return { entries: [...input.entries], joined: 0, canceled: true };
      const firstChoice = parseChoice(first, 2);
      if (firstChoice === 0) {
        const r = reversed(q);
        const second = await input.asker.ask(r.question);
        const secondChoice = second === null ? null : parseChoice(second, 2);
        together = secondChoice !== null && r.back[secondChoice] === 0;
      }
    }
    if (together) run!.push(s);
    else runs.push([s]);
  }

  const replacements = new Map<string, KnowledgeEntry | null>();
  let joined = 0;
  for (const run of runs) {
    if (run.length < 2) continue;
    const text = (await buildSummary({ scenes: run.map((s) => s.text), title: input.title, targetLanguage: input.targetLanguage, asker: input.asker, room: input.room, ...(input.shouldStop ? { shouldStop: input.shouldStop } : {}) })).text;
    const first = run[0]!;
    const last = run.at(-1)!;
    replacements.set(first.id, {
      ...first,
      text,
      related: [...new Set(run.flatMap((s) => s.related))],
      scope: { ...first.scope!, blockHashes: run.flatMap((s) => s.scope?.blockHashes ?? []), blockEnd: last.scope?.blockEnd ?? last.scope?.block ?? first.scope!.block ?? 0 },
      updatedAt: at,
    });
    for (const s of run.slice(1)) replacements.set(s.id, null);
    joined += run.length - 1;
  }
  const entries = input.entries.flatMap((e) => (replacements.has(e.id) ? (replacements.get(e.id) ? [replacements.get(e.id)!] : []) : [e]));
  return { entries, joined, canceled: false };
}
