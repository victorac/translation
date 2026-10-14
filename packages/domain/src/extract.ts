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
  plausibleName,
  quoteInPassage,
  related,
  relation,
  reversed,
  role,
  roleByForm,
  sameAs,
  sceneText,
  narratorQuestion,
  firstPersonInNarration,
  findQuotes,
  addressedIn,
  speakerByForm,
  takeTurns,
  speakerQuestion,
  type Speaker,
  splitSentences,
  supported,
  windowAround,
  type Question,
} from "./steps.js";

/** Which of `count` options a reply chose, or null. */
export const classifyReply = parseChoice;

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
  /** Things that were left out or could not be done, in plain words, for the user. */
  problems: string[];
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
const CJK = /[\u3040-\u30FF\u4E00-\u9FFF]/;
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
 *  7. who is telling it, and what happens (one scene per passage; neighbouring ones are joined afterwards)
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
  const problems: string[] = [];
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

    // The English name must be a plain, short name. One more try, with a stricter instruction, before giving up.
    const askName = async (strict: boolean): Promise<string | null> => {
      const reply = await ask(englishName(c, category, context, input.targetLanguage, strict));
      const name = reply === null ? null : parseShortText(reply, 60, true);
      return reply !== null && name !== null && plausibleName(reply, name) && !(latin && CJK.test(name)) ? name : null;
    };
    let target = await askName(false);
    if (!target && !stop()) target = await askName(true);
    if (!target) {
      problems.push(`「${c}」 was left out: the model did not give a usable ${input.targetLanguage} name for it.`);
      continue;
    }
    // A short description, in the language of the translation. One more try if it comes back in the language of the passage.
    const askSummary = async (strict: boolean): Promise<string | null> => {
      const reply = await ask(describe(c, category, context, input.targetLanguage, strict));
      const text = reply === null ? null : parseShortText(reply, 200);
      if (!text) return null;
      if (latin && CJK.test(text)) {
        unsupported++;
        return null;
      }
      return text;
    };
    let summary = (await askSummary(false)) ?? (stop() ? null : await askSummary(true)) ?? "";
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
    // Often the way the name is written settles it (は or が after it: acting; inside a quotation before 」: spoken to).
    const r = roleByForm(sentences, nameSet(p)) ?? (await pick(role(p.source, windowAround(sentences, nameSet(p)))));
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
        // Only a person and a thing named in the same sentence can be shown to be related by it.
        const together = (o: KnowledgeEntry) => sentences.some((s) => nameSet(p).some((n) => s.text.includes(n)) && nameSet(o).some((n) => s.text.includes(n)));
        const others = terms().filter((o) => o.id !== p.id && o.category === a.target && mentioned.has(o.id) && together(o)).slice(0, 2);
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

  // ---- 7. who is telling it, and what happens ----
  // Every passage gets a scene of its own. Joining neighbouring ones into one scene is a second step (see mergeScenes).
  if (!stop()) {
    const present = people.filter((p) => (roles.get(p.id) ?? 9) <= 1);
    const sceneEntries = entries.filter((e) => e.kind === "scene" && e.scope?.documentId === scope.documentId);
    const here = sceneEntries.find((e) => e.scope?.blockHashes?.includes(scope.blockHash));
    if (!here) {
      // A passage told as "I" is hard to follow unless it is known who "I" is, and the model gets the direction of who waits for whom wrong without it.
      let narrator: { word: string; name: string; id: string } | null = null;
      const word = firstPersonInNarration(passage);
      if (word) {
        const known = terms().find((t) => t.category === "character" && (t.attrs["role"] ?? []).some((r) => /narrator/i.test(r)));
        if (known) narrator = { word, name: known.target, id: known.id };
        else if (people.length > 0) {
          const chosen = await pickAgreed(narratorQuestion(word, people.map((p) => `${p.source} (${p.target})`), windowAround(sentences, [word]) || passage.slice(0, 600)));
          if (chosen !== null && chosen < people.length) {
            const who = people[chosen]!;
            narrator = { word, name: who.target, id: who.id };
            const def = classes.find((c) => c.name === who.category);
            if (def?.attributes.some((x) => x.key === "role") && (who.attrs["role"] ?? []).length === 0) update(who.id, { attrs: { ...who.attrs, role: ["narrator"] }, attrFlags: [...new Set([...who.attrFlags, "role"])] });
          }
        }
      }
      // Who says each line. Bare quotations are where the model loses track of who is talking to whom.
      let spoken = passage;
      let labelled = false;
      const speakers: Speaker[] = present.map((p) => ({ id: p.id, label: p.target, names: [p.source, ...p.aliases] }));
      if (narrator && !speakers.some((s) => s.id === narrator!.id)) speakers.push({ id: narrator.id, label: narrator.name, names: [] });
      if (narrator) speakers.find((s) => s.id === narrator!.id)!.names.push(narrator.word);
      const quotes = findQuotes(passage);
      if (speakers.length >= 2 && quotes.length > 0) {
        let who: (string | null)[] = quotes.map((q) => speakerByForm(passage, q, speakers, quotes));
        // A line that names one of two people as spoken to is said by the other.
        quotes.forEach((q, i) => {
          if (who[i] !== null) return;
          const left = speakers.filter((s) => !addressedIn(q.text, speakers).has(s.id));
          if (speakers.length === 2 && left.length === 1) who[i] = left[0]!.id;
        });
        who = takeTurns(passage, quotes, who, speakers);
        const render = (from: number, to: number, mark: number): string => {
          let out = "";
          let at = from;
          quotes.forEach((q, i) => {
            if (q.end <= from || q.start >= to) return;
            const label = speakers.find((s) => s.id === who[i])?.label;
            out += passage.slice(at, q.start) + (i === mark ? ">>" : "") + (label ? `[${label}] ` : "") + q.text + (i === mark ? "<<" : "");
            at = q.end;
          });
          return out + passage.slice(at, to);
        };
        let budget = 14;
        for (let i = 0; i < quotes.length && budget > 0 && !stop(); i++) {
          if (who[i] !== null) continue;
          budget--;
          const addressed = addressedIn(quotes[i]!.text, speakers);
          const options = speakers.filter((s) => !addressed.has(s.id));
          if (options.length === 0) continue;
          const lo = Math.max(0, (quotes[Math.max(0, i - 2)]?.start ?? 0) - 40);
          const chosen = await pickAgreed(speakerQuestion(quotes[i]!.text, options.map((s) => s.label), render(lo, Math.min(passage.length, quotes[i]!.end + 120), i)));
          if (chosen !== null && chosen < options.length) who[i] = options[chosen]!.id;
        }
        if (who.some((w) => w !== null)) {
          spoken = render(0, passage.length, -1);
          labelled = true;
        }
      }
      // The names of everyone in the passage, so that the description does not fall back on the original script.
      const names = terms()
        .filter((t) => mentioned.has(t.id) || t.id === narrator?.id)
        .map((t) => ({ source: t.source, target: t.target }));
      const describeScene = async (strict: boolean): Promise<string | null> => {
        const reply = await ask(sceneText(spoken, input.targetLanguage, names, narrator ? { word: narrator.word, name: narrator.name } : null, strict, labelled));
        const text = reply === null ? null : parseShortText(reply, 400);
        if (!text) return null;
        // The description is made from the passage and the names given, and the program checks its language. It is not
        // judged "supported": a small model's yes or no to that is too unsteady, and it threw good descriptions away.
        if (latin && CJK.test(text)) {
          unsupported++;
          return null;
        }
        return text;
      };
      let text = await describeScene(false);
      if (!text && !stop()) text = await describeScene(true);
      if (!stopped) {
        if (!text) problems.push(`Block ${scope.block}: a description of what happens could not be written, so the scene has no description yet. You can write it yourself.`);
        const related = [...new Set([...present.map((p) => p.id), ...(narrator ? [narrator.id] : [])])];
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
          text: text ?? "",
          about: null,
          related,
          scope: { documentId: scope.documentId, blockHashes: [scope.blockHash], block: scope.block },
          origin,
          status: "suggested",
          updatedAt: at,
        });
        added++;
      }
    }
  }
  if (disputed > 0) problems.push(`${disputed} ${disputed === 1 ? "answer was" : "answers were"} not used in block ${scope.block}: the model answered differently when the options were in another order.`);
  return { entries, added, asked, stopped, disputed, unsupported, problems };
}
