import type { ClassDef } from "./classes.js";
import type { EntryDeps, EntryOrigin, KnowledgeEntry, TermCategory } from "./entries.js";
import {
  attribute,
  classify,
  describe,
  englishName,
  listNames,
  mergeCandidates,
  parseChoice,
  parseChoiceWithQuote,
  parseNameList,
  parseShortText,
  quoteInPassage,
  related,
  relation,
  reversed,
  role,
  sameAs,
  sameScene,
  sceneText,
  splitSentences,
  supported,
  windowAround,
  type Question,
} from "./steps.js";

/** Something that can answer one question. It answers null when the user stopped, or when the model gave nothing. */
export interface Asker {
  ask(q: Question): Promise<string | null>;
}

export interface ExtractInput {
  /** The knowledge base as it is now (without rejected entries). */
  entries: readonly KnowledgeEntry[];
  /** Entries the user rejected: nothing like them is suggested again. */
  rejected: readonly KnowledgeEntry[];
  classes: readonly ClassDef[];
  passage: string;
  scope: { documentId: string; blockHash: string; block: number };
  origin: EntryOrigin;
  /** Names found without a model (by the word analyzer and by their form). */
  candidates: readonly string[];
  sourceLanguage: string;
  targetLanguage: string;
  asker: Asker;
  deps: EntryDeps;
  /** Ask the model to list names too, in addition to the candidates found without one. */
  listNames?: boolean;
  /** The most new names to look into in one passage. */
  maxNew?: number;
  shouldStop?: () => boolean;
}

export interface ExtractResult {
  entries: KnowledgeEntry[];
  added: number;
  asked: number;
  stopped: boolean;
  /** Answers thrown away because the model did not give the same answer when the options were in another order. */
  disputed: number;
  /** Descriptions thrown away because the passage does not support them. */
  unsupported: number;
}

const PHRASE: Record<string, string> = {
  character: "a person (a character)",
  place: "a place",
  organization: "an organization (a school, company or group)",
  family: "a family or clan",
  term: "another special word (an item, skill, title or term)",
};
const nameSet = (e: KnowledgeEntry) => [e.source, ...e.aliases];
const lower = (s: string) => s.trim().toLocaleLowerCase();

/**
 * Reads one passage for knowledge in layers. The program asks one narrow question at a time, checks each answer
 * (a quote must really be in the passage, a name must really be in the text), and decides what to do with it:
 *  1. candidate names: from the word analyzer and from a model asked only to list names
 *  2. what each new name is (person, place, organization, family, other, or not a name)
 *  3. whether it is one of the known entries written another way
 *  4. its English name and a short description, for a new one
 *  5. what each person does in the passage (acts, is spoken to, is only mentioned)
 *  6. their attributes and links, only the ones not known yet, each with a quote as evidence
 *  7. whether the passage continues the scene before it, and who is present
 */
export async function extractBlock(input: ExtractInput): Promise<ExtractResult> {
  const { passage, classes, deps, origin, scope } = input;
  const sentences = splitSentences(passage);
  let entries = [...input.entries];
  let added = 0;
  let asked = 0;
  let stopped = false;
  let disputed = 0;
  let unsupported = 0;
  const at = deps.now();
  const latin = !/japan|chinese|korean|mandarin|cantonese/i.test(input.targetLanguage);

  const stop = () => {
    stopped = stopped || input.shouldStop?.() === true;
    return stopped;
  };
  const ask = async (q: Question): Promise<string | null> => {
    if (stop()) return null;
    asked++;
    const reply = await input.asker.ask(q);
    if (reply === null) stopped = stopped || input.shouldStop?.() === true;
    return reply;
  };
  /** A choice, asked again once if the reply was not one of the options. */
  const pick = async (q: Question): Promise<number | null> => {
    const n = q.options!.length;
    const reply = await ask(q);
    if (reply === null) return null;
    const first = parseChoice(reply, n);
    if (first !== null) return first;
    const again = await ask({ ...q, user: `${q.user}\n\nYour reply must be just one letter from the list.` });
    return again === null ? null : parseChoice(again, n);
  };
  const pickWithQuote = async (q: Question): Promise<{ index: number; quote: string } | null> => {
    const n = q.options!.length;
    const reply = await ask(q);
    return reply === null ? null : parseChoiceWithQuote(reply, n);
  };
  /** A choice asked twice, the second time with the options in the opposite order. Only an answer given both ways counts. */
  const pickAgreed = async (q: Question): Promise<number | null> => {
    const first = await pick(q);
    if (first === null) return null;
    const r = reversed(q);
    const second = await pick(r.question);
    if (second === null) return null;
    if (r.back[second] !== first) {
      disputed++;
      return null;
    }
    return first;
  };
  const pickWithQuoteAgreed = async (q: Question): Promise<{ index: number; quote: string } | null> => {
    const first = await pickWithQuote(q);
    if (first === null) return null;
    const r = reversed(q);
    const second = await pickWithQuote(r.question);
    if (second === null) return null;
    if (r.back[second.index] !== first.index) {
      disputed++;
      return null;
    }
    return first;
  };
  /** Does the passage support this statement? Anything else is not kept. */
  const isSupported = async (statement: string, subject: string, context: string): Promise<boolean> => {
    const answer = await pick(supported(statement, subject, context));
    if (answer !== 0) unsupported++;
    return answer === 0;
  };
  const update = (id: string, patch: Partial<KnowledgeEntry>) => {
    entries = entries.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: at } : e));
  };
  const terms = () => entries.filter((e) => e.kind === "term");

  // ---- 1. candidate names ----
  const known = terms();
  let found = [...input.candidates];
  if (input.listNames !== false && !stop()) {
    const reply = await ask(listNames(passage, input.sourceLanguage));
    if (reply !== null) found = [...found, ...parseNameList(reply)];
  }
  const knownNames = known.flatMap(nameSet);
  const rejectedNames = input.rejected.filter((e) => e.kind === "term").flatMap(nameSet);
  const candidates = mergeCandidates(passage, found)
    .filter((c) => !knownNames.some((k) => lower(k) === lower(c)))
    .filter((c) => !rejectedNames.some((k) => lower(k) === lower(c)))
    // A word that only ever appears inside a longer known name in this passage is not a new name.
    .filter((c) => !knownNames.some((k) => k.length > c.length && k.includes(c) && passage.split(k).join("").indexOf(c) < 0))
    .slice(0, input.maxNew ?? 10);

  // ---- 2 to 4. what the new names are, and whether they are new ----
  const classNames = classes.length > 0 ? classes.map((c) => c.name).slice(0, 8) : ["character", "place", "organization", "family", "term"];
  const classOptions = [...classNames.map((c) => PHRASE[c] ?? `a ${c}`), "not a name"];
  const mentioned = new Set<string>(known.filter((e) => nameSet(e).some((n) => passage.includes(n))).map((e) => e.id));

  for (const c of candidates) {
    if (stop()) break;
    const context = windowAround(sentences, [c]);
    const kindIndex = await pickAgreed(classify(c, context, classOptions));
    if (kindIndex === null || kindIndex >= classNames.length) continue;
    const category: TermCategory = classNames[kindIndex]!;

    const similar = terms()
      .filter((e) => e.category === category && nameSet(e).some((n) => related(c, n)))
      .slice(0, 5);
    if (similar.length > 0) {
      const which = await pickAgreed(sameAs(c, context, similar.map((e) => ({ label: `${e.source}${e.aliases.length > 0 ? ` (${e.aliases.join(", ")})` : ""} = ${e.target}${e.hint ? ` — ${e.hint}` : ""}` }))));
      if (which !== null && which < similar.length) {
        const hit = similar[which]!;
        update(hit.id, { aliases: [...hit.aliases, c] });
        mentioned.add(hit.id);
        added++;
        continue;
      }
      if (which === null) continue;
    }

    const nameReply = await ask(englishName(c, category, context, input.targetLanguage));
    const target = nameReply === null ? null : parseShortText(nameReply, 60);
    // An English name with Japanese characters in it is not a translation.
    if (!target || (latin && /[\u3040-\u30FF\u4E00-\u9FFF]/.test(target))) continue;
    const descReply = await ask(describe(c, context));
    let summary = descReply === null ? "" : (parseShortText(descReply, 200) ?? "");
    if (summary !== "" && !(await isSupported(summary, c, context))) summary = "";
    const created: KnowledgeEntry = {
      id: deps.newId(),
      kind: "term",
      source: c,
      target,
      hint: summary,
      category,
      aliases: [],
      attrs: {},
      attrFlags: [],
      text: "",
      about: null,
      related: [],
      scope: null,
      origin,
      status: "suggested",
      updatedAt: at,
    };
    entries.push(created);
    mentioned.add(created.id);
    added++;
  }

  // ---- 5. what each person does in the passage ----
  const people = terms().filter((e) => e.category === "character" && mentioned.has(e.id));
  const roles = new Map<string, number>();
  for (const p of people) {
    if (stop()) break;
    const r = await pick(role(p.source, windowAround(sentences, nameSet(p))));
    if (r !== null) roles.set(p.id, r);
  }

  // ---- 6. attributes and links, only what is not known yet ----
  for (const p of people) {
    if (stop()) break;
    const r = roles.get(p.id);
    if (r === undefined || r > 2) continue;
    const def = classes.find((c) => c.name === p.category);
    const context = windowAround(sentences, nameSet(p));
    let budget = 4;
    for (const a of def?.attributes ?? []) {
      if (stop() || budget <= 0) break;
      const current = entries.find((e) => e.id === p.id)!;
      if ((current.attrs[a.key] ?? []).length > 0) continue;
      if (a.kind === "choice" && a.choices) {
        budget--;
        const got = await pickWithQuoteAgreed(attribute(p.source, a.key, a.choices, context));
        if (!got || got.index >= a.choices.length || !quoteInPassage(passage, got.quote)) continue;
        update(p.id, { attrs: { ...current.attrs, [a.key]: [a.choices[got.index]!] }, attrFlags: [...new Set([...current.attrFlags, a.key])] });
        added++;
      } else if ((a.kind === "link" || a.kind === "links") && a.target) {
        const others = terms().filter((o) => o.id !== p.id && o.category === a.target && mentioned.has(o.id)).slice(0, 2);
        for (const o of others) {
          if (stop() || budget <= 0) break;
          budget--;
          const got = await pickWithQuoteAgreed(relation(p.source, a.key, o.source, context));
          if (!got || got.index !== 0 || !quoteInPassage(passage, got.quote)) continue;
          const now = entries.find((e) => e.id === p.id)!;
          update(p.id, { attrs: { ...now.attrs, [a.key]: [...(now.attrs[a.key] ?? []), o.source] }, attrFlags: [...new Set([...now.attrFlags, a.key])] });
          added++;
          if (a.kind === "link") break;
        }
      }
    }
  }

  // ---- 7. the scene ----
  if (!stop()) {
    const present = people.filter((p) => (roles.get(p.id) ?? 9) <= 1);
    const sceneEntries = entries.filter((e) => e.kind === "scene" && e.scope?.documentId === scope.documentId);
    const here = sceneEntries.find((e) => e.scope?.blockHashes?.includes(scope.blockHash));
    const before = sceneEntries.find((e) => (e.scope?.blockEnd ?? e.scope?.block) === scope.block - 1);
    if (!here) {
      let continues = false;
      if (before && before.status === "suggested") {
        const same = await pick(sameScene(before.text, passage));
        continues = same === 0;
      }
      if (continues && before) {
        update(before.id, {
          related: [...new Set([...before.related, ...present.map((p) => p.id)])],
          scope: { ...before.scope!, blockHashes: [...(before.scope!.blockHashes ?? []), scope.blockHash], blockEnd: scope.block },
        });
        added++;
      } else if (!stopped) {
        const reply = await ask(sceneText(passage, present.map((p) => p.target), input.targetLanguage));
        const text = reply === null ? null : parseShortText(reply, 300);
        if (text && (await isSupported(text, "this scene", passage.slice(0, 1500)))) {
          entries.push({
            id: deps.newId(),
            kind: "scene",
            source: "",
            target: "",
            hint: "",
            category: "term",
            aliases: [],
            attrs: {},
            attrFlags: [],
            text,
            about: null,
            related: present.map((p) => p.id),
            scope: { documentId: scope.documentId, blockHashes: [scope.blockHash], block: scope.block },
            origin,
            status: "suggested",
            updatedAt: at,
          });
          added++;
        }
      }
    }
  }
  return { entries, added, asked, stopped, disputed, unsupported };
}
