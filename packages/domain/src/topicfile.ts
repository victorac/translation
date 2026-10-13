import { classLabel, parseClasses, type AttributeDef, type ClassDef } from "./classes.js";
import type { EntryDeps, EntryOrigin, KnowledgeEntry } from "./entries.js";

/**
 * Every topic is a small text file, a little like a note in Obsidian: the attributes of its class are written at the
 * top, then a summary, then the facts about it. Links to other topics are written `[[like this]]`.
 *
 *   ---
 *   type: character
 *   name: 花子
 *   english: Hanako
 *   aliases: 花ちゃん
 *   gender: female
 *   family: [[佐藤家]]
 *   ---
 *   The narrator's classmate, speaks politely.
 *
 *   ## Notes
 *   - Addresses [[太郎]] as Taro-kun. ?
 *
 * A "?" after a fact or an attribute, or `status: suggested`, means a model suggested it and nobody has checked it.
 */

export interface DocumentRef {
  id: string;
  title: string;
}

export interface KbProblem {
  /** Line number, starting at 1 (0 when it is about the file as a whole). */
  line: number;
  message: string;
}

export type FileKind = "topic" | "scene" | "summary" | "classes";

export interface FileInfo {
  id: string;
  kind: FileKind;
  /** What it is listed under: the class of a topic, or scene, summary, notes, classes. */
  group: string;
  groupLabel: string;
  title: string;
  subtitle: string;
  suggested: boolean;
  /** For scenes and summaries: the document they belong to. */
  documentId?: string;
}

export interface FileContext {
  /** The entries that are part of the knowledge (not rejected ones). */
  entries: readonly KnowledgeEntry[];
  classes: readonly ClassDef[];
  classesText: string;
  docs: readonly DocumentRef[];
}

const lower = (s: string) => s.trim().toLocaleLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const FLAG = /\s+\?\s*$/;
export const CLASSES_ID = "classes";

const splitList = (s: string) => s.split(/[,、，]/).map((v) => v.trim()).filter(Boolean);
const unlink = (s: string) => s.replace(/^\[\[(.*)\]\]$/, "$1").trim();

const isTopic = (e: KnowledgeEntry) => e.kind === "term";
const nameOf = (e: KnowledgeEntry) => e.source;

/** The topic a name refers to: by its name or another spelling, then by its English name. */
export function resolveName(name: string, entries: readonly KnowledgeEntry[]): KnowledgeEntry | undefined {
  const topics = entries.filter(isTopic);
  return topics.find((t) => [t.source, ...t.aliases].some((w) => same(w, name))) ?? topics.find((t) => same(t.target, name));
}

const docTitle = (docs: readonly DocumentRef[], id: string | undefined) => docs.find((d) => d.id === id)?.title ?? "Unknown document";
const range = (e: KnowledgeEntry) => {
  const from = e.scope?.block ?? 0;
  const to = e.scope?.blockEnd ?? from;
  return to > from ? `${from}-${to}` : `${from}`;
};

// ---- the list of files ----

export function listFiles(ctx: FileContext): FileInfo[] {
  const out: FileInfo[] = [];
  const topics = ctx.entries.filter(isTopic);
  const order = [...ctx.classes.map((c) => c.name), ...topics.map((t) => t.category).filter((c) => !ctx.classes.some((k) => k.name === c))];
  for (const group of [...new Set(order)]) {
    for (const t of topics.filter((x) => x.category === group)) {
      const unchecked = t.status === "suggested" || t.attrFlags.length > 0 || ctx.entries.some((n) => n.kind === "note" && n.about === t.id && n.status === "suggested");
      out.push({ id: t.id, kind: "topic", group, groupLabel: classLabel(group), title: nameOf(t), subtitle: t.target, suggested: unchecked });
    }
  }
  for (const s of ctx.entries.filter((e) => e.kind === "scene").sort((a, b) => (a.scope?.block ?? 0) - (b.scope?.block ?? 0))) {
    out.push({ id: s.id, kind: "scene", group: "scene", groupLabel: "Scenes", title: `Block ${range(s)}`, subtitle: docTitle(ctx.docs, s.scope?.documentId), suggested: s.status === "suggested", ...(s.scope ? { documentId: s.scope.documentId } : {}) });
  }
  for (const s of ctx.entries.filter((e) => e.kind === "summary")) {
    out.push({ id: s.id, kind: "summary", group: "summary", groupLabel: "Summaries", title: docTitle(ctx.docs, s.scope?.documentId), subtitle: "summary", suggested: s.status === "suggested", ...(s.scope ? { documentId: s.scope.documentId } : {}) });
  }
  out.push({ id: CLASSES_ID, kind: "classes", group: "classes", groupLabel: "Other", title: "Classes", subtitle: "kinds of topic and their attributes", suggested: false });
  return out;
}

// ---- writing a file ----

const link = (v: string) => `[[${v}]]`;

function attributeLine(def: AttributeDef, e: KnowledgeEntry): string {
  const values = e.attrs[def.key] ?? [];
  const text = values.map((v) => (def.kind === "link" || def.kind === "links" ? link(v) : v)).join(", ");
  return `${def.key}:${text ? ` ${text}` : ""}${values.length > 0 && e.attrFlags.includes(def.key) ? " ?" : ""}`;
}

function frontMatter(lines: string[]): string {
  return ["---", ...lines, "---"].join("\n");
}

export function fileText(id: string, ctx: FileContext): string | null {
  if (id === CLASSES_ID) return ctx.classesText;
  const e = ctx.entries.find((x) => x.id === id);
  if (!e) return null;
  const status = e.status === "suggested" ? ["status: suggested"] : [];
  if (e.kind === "summary") return `${frontMatter(["type: summary", `document: ${docTitle(ctx.docs, e.scope?.documentId)}`, ...status])}\n${oneLine(e.text)}\n`;
  if (e.kind === "scene") {
    const present = e.related.map((r) => ctx.entries.find((t) => t.id === r)?.source).filter((n): n is string => !!n);
    return `${frontMatter(["type: scene", `document: ${docTitle(ctx.docs, e.scope?.documentId)}`, `blocks: ${range(e)}`, `present: ${present.map(link).join(", ")}`, ...status])}\n${oneLine(e.text)}\n`;
  }
  if (e.kind !== "term") return null;
  const cls = ctx.classes.find((c) => c.name === e.category);
  const defs = cls?.attributes ?? [];
  const known = new Set(defs.map((d) => d.key));
  const extra = Object.keys(e.attrs).filter((k) => !known.has(k));
  const head = [
    `type: ${e.category}`,
    `name: ${e.source}`,
    `english: ${e.target}`,
    `aliases: ${e.aliases.join(", ")}`,
    ...status,
    ...defs.map((d) => attributeLine(d, e)),
    ...extra.map((k) => attributeLine({ key: k, kind: "text" }, e)),
  ];
  const facts = ctx.entries.filter((n) => n.kind === "note" && n.about === e.id);
  return `${frontMatter(head)}\n${oneLine(e.hint)}\n\n## Notes\n${facts.map((f) => `- ${oneLine(f.text)}${f.status === "suggested" ? " ?" : ""}`).join("\n")}${facts.length > 0 ? "\n" : ""}`;
}

export function titleOf(id: string, ctx: FileContext): string {
  const f = listFiles(ctx).find((x) => x.id === id);
  return f ? (f.kind === "topic" ? f.title : f.kind === "scene" ? `${f.title} · ${f.subtitle}` : f.kind === "summary" ? `Summary · ${f.title}` : f.title) : "";
}

// ---- links between files ----

/** The files that link to a topic: through an attribute, a `[[link]]` in their text, or a scene that lists it. */
export function backlinksOf(id: string, ctx: FileContext): { id: string; title: string }[] {
  const target = ctx.entries.find((e) => e.id === id);
  if (!target || !isTopic(target)) return [];
  const names = [target.source, ...target.aliases, target.target];
  const mentions = (s: string) => [...s.matchAll(/\[\[(.*?)\]\]/g)].some((m) => names.some((n) => same(n, m[1]!)));
  const found = new Set<string>();
  for (const e of ctx.entries) {
    if (e.id === id) continue;
    const viaAttr = Object.values(e.attrs).some((vs) => vs.some((v) => names.some((n) => same(n, v))));
    const viaText = mentions(e.hint) || mentions(e.text);
    const viaScene = e.kind === "scene" && e.related.includes(id);
    if (!(viaAttr || viaText || viaScene)) continue;
    // A fact belongs to the file of the topic it is about.
    if (e.kind === "note") {
      if (e.about && ctx.entries.some((t) => t.id === e.about)) found.add(e.about);
    } else found.add(e.id);
  }
  found.delete(id);
  return [...found].map((f) => ({ id: f, title: titleOf(f, ctx) })).filter((b) => b.title !== "");
}

// ---- reading a file back ----

interface Field {
  key: string;
  value: string;
  line: number;
}
interface Parsed {
  fields: Field[];
  /** The lines after the front matter, with their line numbers. */
  body: { text: string; line: number }[];
  hasFrontMatter: boolean;
}

function splitFile(text: string): Parsed {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: [], body: lines.map((t, i) => ({ text: t, line: i + 1 })), hasFrontMatter: false };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { fields: [], body: lines.map((t, i) => ({ text: t, line: i + 1 })), hasFrontMatter: false };
  const fields: Field[] = [];
  for (let i = 1; i < end; i++) {
    const raw = lines[i]!.replace(/<!--.*?-->/g, "");
    const m = /^([^:]+?)\s*:\s*(.*)$/.exec(raw);
    if (m) fields.push({ key: lower(m[1]!), value: m[2]!.trim(), line: i + 1 });
  }
  return { fields, body: lines.slice(end + 1).map((t, i) => ({ text: t, line: end + 2 + i })), hasFrontMatter: true };
}

/** The summary above "## Notes" and the bullets under it. */
function readBody(body: Parsed["body"], problems: KbProblem[]): { summary: string; facts: { text: string; suggested: boolean }[] } {
  const summary: string[] = [];
  const facts: { text: string; suggested: boolean }[] = [];
  let inNotes = false;
  for (const { text, line } of body) {
    const t = text.replace(/<!--.*?-->/g, "").trim();
    if (t === "") continue;
    if (/^##\s+notes\s*$/i.test(t)) {
      inNotes = true;
      continue;
    }
    if (/^#{1,6}\s/.test(t)) {
      problems.push({ line, message: "Only a summary and a ## Notes list belong here." });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(t);
    if (inNotes) {
      if (!bullet) problems.push({ line, message: "Write each fact as a bullet: - a fact" });
      else {
        const suggested = FLAG.test(` ${bullet[1]}`);
        facts.push({ text: suggested ? bullet[1]!.replace(FLAG, "").trim() : bullet[1]!.trim(), suggested });
      }
    } else if (bullet) {
      problems.push({ line, message: "Facts go under ## Notes." });
    } else summary.push(t);
  }
  return { summary: summary.join(" "), facts };
}

export interface Applied {
  /** Every entry after the edit, including rejected ones. */
  entries: KnowledgeEntry[];
  problems: KbProblem[];
  /** For the classes file: the new text. */
  classesText?: string;
}

const userOrigin: EntryOrigin = { by: "user" };
const statusOf = (suggested: boolean) => (suggested ? ("suggested" as const) : ("confirmed" as const));

/** Replaces `[[old]]` with `[[new]]` in a text. */
const relink = (s: string, from: string, to: string) => s.replace(/\[\[(.*?)\]\]/g, (m, n: string) => (same(n, from) ? `[[${to}]]` : m));

/**
 * Applies an edited file to the entries. Every file is one topic (or scene, summary, the notes, or the classes), so it
 * is recognized by its id, not guessed from its text. Things it could not understand are returned and leave the
 * entry as it was. Renaming a topic updates the links to it in other files.
 */
export function applyFile(existing: readonly KnowledgeEntry[], id: string, text: string, ctx: FileContext, deps: EntryDeps): Applied {
  const at = deps.now();
  const problems: KbProblem[] = [];
  if (id === CLASSES_ID) {
    const parsed = parseClasses(text);
    return { entries: [...existing], problems: parsed.problems, classesText: text };
  }
  const live = existing.filter((e) => e.status !== "rejected");

  const entry = live.find((e) => e.id === id);
  if (!entry) return { entries: [...existing], problems: [{ line: 0, message: "That file no longer exists." }] };
  const parsed = splitFile(text);
  if (!parsed.hasFrontMatter) return { entries: [...existing], problems: [{ line: 1, message: "A file starts with a block between two lines of ---. Nothing was changed." }] };
  const field = (k: string) => parsed.fields.find((f) => f.key === k);
  const flag = field("status") ? /^suggested$/i.test(field("status")!.value) : false;

  const replace = (updated: KnowledgeEntry): Applied => ({ entries: existing.map((e) => (e.id === id ? updated : e)), problems });

  if (entry.kind === "summary") {
    const body = readBody(parsed.body, problems);
    const changed = oneLine(body.summary) !== entry.text;
    return replace({ ...entry, text: body.summary, status: statusOf(flag), origin: changed && entry.origin.by === "model" ? { ...entry.origin, by: "user" } : entry.origin, updatedAt: changed || entry.status !== statusOf(flag) ? at : entry.updatedAt });
  }
  if (entry.kind === "scene") {
    const body = readBody(parsed.body, problems);
    const present = splitList(field("present")?.value ?? "").map(unlink);
    const related: string[] = [];
    for (const name of present) {
      const t = resolveName(name, live);
      if (t) related.push(t.id);
      else problems.push({ line: field("present")?.line ?? 0, message: `No topic called "${name}".` });
    }
    const changed = body.summary !== entry.text || related.join() !== entry.related.join();
    return replace({ ...entry, text: body.summary, related, status: statusOf(flag), origin: changed && entry.origin.by === "model" ? { ...entry.origin, by: "user" } : entry.origin, updatedAt: changed || entry.status !== statusOf(flag) ? at : entry.updatedAt });
  }
  if (entry.kind !== "term") return { entries: [...existing], problems: [{ line: 0, message: "This kind of file cannot be edited here." }] };

  // A topic.
  const name = field("name")?.value.trim() || "";
  const english = field("english")?.value.trim() || "";
  if (name === "") problems.push({ line: field("name")?.line ?? 1, message: "A topic needs a name (as written in the text). It was left as it was." });
  if (english === "") problems.push({ line: field("english")?.line ?? 1, message: "A topic needs an English name. It was left as it was." });
  const newName = name || entry.source;
  const newEnglish = english || entry.target;
  const category = lower(field("type")?.value ?? entry.category) || entry.category;
  if (!ctx.classes.some((c) => c.name === category)) problems.push({ line: field("type")?.line ?? 1, message: `There is no class called "${category}". Add it in Classes, or use one that exists.` });
  const clash = live.find((t) => isTopic(t) && t.id !== id && [t.source, ...t.aliases].some((w) => same(w, newName)));
  if (clash) problems.push({ line: field("name")?.line ?? 1, message: `"${clash.source}" is already another topic with this name.` });
  const aliases = splitList(field("aliases")?.value ?? "").filter((a) => !same(a, newName));

  const cls = ctx.classes.find((c) => c.name === category);
  const defs = new Map((cls?.attributes ?? []).map((d) => [d.key, d]));
  const attrs: Record<string, string[]> = {};
  const attrFlags: string[] = [];
  const reserved = new Set(["type", "name", "english", "aliases", "status"]);
  for (const f of parsed.fields) {
    if (reserved.has(f.key)) continue;
    const def = defs.get(f.key);
    if (!def) problems.push({ line: f.line, message: `"${f.key}" is not an attribute of ${category}. It was kept as plain text.` });
    let value = f.value;
    const suggested = FLAG.test(` ${value}`);
    if (suggested) value = value.replace(FLAG, "").trim();
    if (value === "") continue;
    let values = (def?.kind === "text" || !def ? [value] : splitList(value)).map(unlink);
    if (def?.kind === "link" || def?.kind === "links") {
      if (def.kind === "link") values = values.slice(0, 1);
      for (const v of values) {
        const target = resolveName(v, live);
        if (!target) problems.push({ line: f.line, message: `No topic called "${v}" yet. Click the link to create it.` });
        else if (def.target && target.category !== def.target) problems.push({ line: f.line, message: `"${v}" is a ${target.category}, but ${f.key} should point to a ${def.target}.` });
      }
    } else if (def?.kind === "choice") {
      values = values.slice(0, 1).map((v) => def.choices!.find((c) => same(c, v)) ?? v);
      if (!def.choices!.some((c) => same(c, values[0]!))) problems.push({ line: f.line, message: `"${values[0]}" is not one of: ${def.choices!.join(", ")}.` });
    }
    attrs[f.key] = values;
    if (suggested) attrFlags.push(f.key);
  }

  const body = readBody(parsed.body, problems);
  const changed =
    entry.source !== newName || entry.target !== newEnglish || entry.hint !== body.summary || entry.category !== category || entry.aliases.join("\u0000") !== aliases.join("\u0000") || JSON.stringify(entry.attrs) !== JSON.stringify(attrs) || entry.attrFlags.join() !== attrFlags.join();
  const updated: KnowledgeEntry = {
    ...entry,
    source: newName,
    target: newEnglish,
    category,
    aliases,
    hint: body.summary,
    attrs,
    attrFlags,
    origin: changed && entry.origin.by === "model" ? { ...entry.origin, by: "user" } : entry.origin,
    status: statusOf(flag),
    updatedAt: changed || entry.status !== statusOf(flag) ? at : entry.updatedAt,
  };

  // Facts: recognized by their text; a deleted suggestion is remembered as rejected, a deleted accepted fact is gone.
  const oldFacts = live.filter((n) => n.kind === "note" && n.about === id);
  const claimed = new Set<string>();
  const facts: KnowledgeEntry[] = [];
  for (const f of body.facts) {
    const old = oldFacts.find((n) => !claimed.has(n.id) && same(n.text, f.text));
    if (old) claimed.add(old.id);
    facts.push(old ? { ...old, status: statusOf(f.suggested), updatedAt: old.status === statusOf(f.suggested) ? old.updatedAt : at } : { ...blankEntry(deps.newId(), at), kind: "note", text: f.text, about: id, status: statusOf(f.suggested) });
  }
  const dropped = oldFacts.filter((n) => !claimed.has(n.id));
  const rejected = dropped.filter((n) => n.status === "suggested").map((n) => ({ ...n, status: "rejected" as const }));

  // Renaming a topic updates the links to it.
  const renamed = !same(entry.source, newName);
  const others = existing
    .filter((e) => e.id !== id && !oldFacts.some((n) => n.id === e.id))
    .map((e) => {
      if (!renamed) return e;
      const attrs2 = Object.fromEntries(Object.entries(e.attrs).map(([k, vs]) => [k, vs.map((v) => (same(v, entry.source) ? newName : v))]));
      return { ...e, attrs: attrs2, hint: relink(e.hint, entry.source, newName), text: relink(e.text, entry.source, newName) };
    });
  return { entries: [...mergeInOrder(existing, id, updated, facts, others), ...rejected], problems };
}

/** Puts the edited topic back where it was, with its facts after the others. */
function mergeInOrder(existing: readonly KnowledgeEntry[], id: string, updated: KnowledgeEntry, facts: KnowledgeEntry[], others: KnowledgeEntry[]): KnowledgeEntry[] {
  const oldFactIds = new Set(existing.filter((e) => e.kind === "note" && e.about === id).map((e) => e.id));
  const result: KnowledgeEntry[] = [];
  for (const e of existing) {
    if (e.id === id) result.push(updated);
    else if (oldFactIds.has(e.id)) continue;
    else result.push(others.find((o) => o.id === e.id) ?? e);
  }
  return [...result, ...facts];
}

function blankEntry(id: string, at: string): KnowledgeEntry {
  return { id, kind: "term", source: "", target: "", hint: "", category: "term", aliases: [], attrs: {}, attrFlags: [], text: "", about: null, related: [], scope: null, origin: userOrigin, status: "confirmed", updatedAt: at };
}

/** A new, empty topic of a class, for the user to fill in. */
export function newTopic(type: string, name: string, deps: EntryDeps): KnowledgeEntry {
  return { ...blankEntry(deps.newId(), deps.now()), kind: "term", category: lower(type) || "term", source: name.trim(), target: name.trim() };
}
