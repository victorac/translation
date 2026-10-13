import type { EntryDeps, EntryOrigin, KnowledgeEntry, TermCategory } from "./entries.js";
import { splitNames } from "./knowledge.js";

/**
 * The knowledge base as a text document, written in a small markdown-like format:
 *
 *   # Characters
 *   ## 花子 / 花ちゃん = Hanako ?
 *   girl, the narrator's classmate, speaks politely
 *   - Addresses Taro as Taro-kun.
 *   - Is the class president. ?
 *
 *   # Places
 *   # Terms
 *   # Notes
 *   - A note that is not about one entry.
 *
 *   # Document: Chapter 1
 *   ## Summary
 *   An abridged version of the chapter.
 *   ## Blocks 1-3 | 花子, 太郎
 *   What is happening in this scene.
 *
 * A "?" at the end of a heading or a bullet means a model suggested it and nobody has checked it. Take the "?" away to
 * accept the entry. Delete the entry to reject it: a suggestion that is deleted will not be suggested again.
 */

export interface DocumentRef {
  id: string;
  title: string;
}

export interface KbProblem {
  /** Line number, starting at 1. */
  line: number;
  message: string;
}

const SECTION_FOR: Record<TermCategory, string> = { character: "Characters", place: "Places", term: "Terms" };
const FLAG = /\s+\?\s*$/;

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** Writes the entries as a document. Rejected entries are left out; they are not part of the knowledge. */
export function entriesToDocument(entries: readonly KnowledgeEntry[], docs: readonly DocumentRef[]): string {
  const live = entries.filter((e) => e.status !== "rejected");
  const flag = (e: KnowledgeEntry) => (e.status === "suggested" ? " ?" : "");
  const where = (e: KnowledgeEntry) => {
    if (e.status !== "suggested" || e.origin.by !== "model") return "";
    const parts = [e.origin.model, e.origin.documentTitle, e.origin.block ? `block ${e.origin.block}` : undefined].filter(Boolean);
    return parts.length > 0 ? `  <!-- ${parts.join(" · ")} -->` : "";
  };
  const out: string[] = [];
  const termById = new Map(live.filter((e) => e.kind === "term").map((e) => [e.id, e]));

  for (const category of ["character", "place", "term"] as const) {
    const terms = live.filter((e) => e.kind === "term" && e.category === category);
    if (terms.length === 0) continue;
    out.push(`# ${SECTION_FOR[category]}`, "");
    for (const t of terms) {
      out.push(`## ${[t.source, ...t.aliases].join(" / ")} = ${t.target}${flag(t)}${where(t)}`);
      if (t.hint.trim() !== "") out.push(oneLine(t.hint));
      for (const f of live.filter((e) => e.kind === "note" && e.about === t.id)) out.push(`- ${oneLine(f.text)}${flag(f)}`);
      out.push("");
    }
  }
  const loose = live.filter((e) => e.kind === "note" && (e.about === null || !termById.has(e.about)));
  if (loose.length > 0) {
    out.push("# Notes", "");
    for (const n of loose) out.push(`- ${oneLine(n.text)}${flag(n)}`);
    out.push("");
  }
  for (const doc of docs) {
    const summary = live.find((e) => e.kind === "summary" && e.scope?.documentId === doc.id);
    const scenes = live.filter((e) => e.kind === "scene" && e.scope?.documentId === doc.id).sort((a, b) => (a.scope?.block ?? 0) - (b.scope?.block ?? 0));
    if (!summary && scenes.length === 0) continue;
    out.push(`# Document: ${doc.title}`, "");
    if (summary) out.push(`## Summary${flag(summary)}${where(summary)}`, oneLine(summary.text), "");
    for (const s of scenes) {
      const from = s.scope?.block ?? 0;
      const to = s.scope?.blockEnd ?? from;
      const present = s.related.map((id) => termById.get(id)?.source).filter(Boolean);
      out.push(`## ${to > from ? `Blocks ${from}-${to}` : `Block ${from}`}${present.length > 0 ? ` | ${present.join(", ")}` : ""}${flag(s)}${where(s)}`, oneLine(s.text), "");
    }
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

// ---- reading it back ----

interface DraftFact {
  text: string;
  suggested: boolean;
}
interface DraftTerm {
  category: TermCategory;
  names: string[];
  target: string;
  summary: string;
  suggested: boolean;
  facts: DraftFact[];
}
interface DraftScene {
  docTitle: string;
  from: number;
  to: number;
  present: string[];
  text: string;
  suggested: boolean;
}
interface DraftSummary {
  docTitle: string;
  text: string;
  suggested: boolean;
}

export interface ParsedDocument {
  terms: DraftTerm[];
  notes: DraftFact[];
  scenes: DraftScene[];
  summaries: DraftSummary[];
  /** Documents that have a section in the text. Documents without one are left as they are. */
  documentsSeen: string[];
  problems: KbProblem[];
}

type Section = { kind: "term"; category: TermCategory } | { kind: "notes" } | { kind: "document"; title: string } | { kind: "unknown" };
type Open = { kind: "term"; term: DraftTerm } | { kind: "scene"; scene: DraftScene } | { kind: "summary"; summary: DraftSummary } | null;

const stripComments = (s: string) => s.replace(/<!--.*?-->/g, "").trimEnd();

export function parseDocument(text: string): ParsedDocument {
  const result: ParsedDocument = { terms: [], notes: [], scenes: [], summaries: [], documentsSeen: [], problems: [] };
  let section: Section | null = null;
  let open: Open = null;
  const problem = (line: number, message: string) => result.problems.push({ line, message });

  text.split("\n").forEach((raw, i) => {
    const n = i + 1;
    const line = stripComments(raw);
    const trimmed = line.trim();
    if (trimmed === "") return;

    const h1 = /^#\s+(.+)$/.exec(trimmed);
    const h2 = /^##\s+(.+)$/.exec(trimmed);
    if (h1 && !trimmed.startsWith("##")) {
      open = null;
      const title = h1[1]!.trim();
      const doc = /^document\s*:\s*(.+)$/i.exec(title);
      if (/^characters?$/i.test(title)) section = { kind: "term", category: "character" };
      else if (/^places?$/i.test(title)) section = { kind: "term", category: "place" };
      else if (/^terms?$/i.test(title)) section = { kind: "term", category: "term" };
      else if (/^notes?$/i.test(title)) section = { kind: "notes" };
      else if (doc) {
        section = { kind: "document", title: doc[1]!.trim() };
        result.documentsSeen.push(section.title);
      } else {
        section = { kind: "unknown" };
        problem(n, `Unknown section "${title}". Use Characters, Places, Terms, Notes or Document: <name>.`);
      }
      return;
    }
    if (h2) {
      open = null;
      let heading = h2[1]!.trim();
      const suggested = FLAG.test(` ${heading}`);
      if (suggested) heading = heading.replace(FLAG, "").trim();
      if (!section) return problem(n, "This entry is not under a section. Start with # Characters, # Places, # Terms, # Notes or # Document: <name>.");
      if (section.kind === "term") {
        const m = /^(.*?)\s*(?:=>|->|→|=)\s*(.+)$/.exec(heading);
        const names = splitNames(m?.[1] ?? "");
        if (!m || names.length === 0 || m[2]!.trim() === "") return problem(n, "Write the heading as: name / other spelling = translation");
        const term: DraftTerm = { category: section.category, names, target: m[2]!.trim(), summary: "", suggested, facts: [] };
        result.terms.push(term);
        open = { kind: "term", term };
      } else if (section.kind === "document") {
        const summary = /^summary$/i.exec(heading);
        const scene = /^blocks?\s+(\d+)(?:\s*[-–—]\s*(\d+))?\s*(?:\|\s*(.*))?$/i.exec(heading);
        if (summary) {
          const d: DraftSummary = { docTitle: section.title, text: "", suggested };
          result.summaries.push(d);
          open = { kind: "summary", summary: d };
        } else if (scene) {
          const from = Number(scene[1]);
          const to = scene[2] ? Number(scene[2]) : from;
          const d: DraftScene = { docTitle: section.title, from, to: Math.max(from, to), present: (scene[3] ?? "").split(/[,、，]/).map((s) => s.trim()).filter(Boolean), text: "", suggested };
          result.scenes.push(d);
          open = { kind: "scene", scene: d };
        } else problem(n, "Under a document, write ## Summary or ## Blocks 1-3 | names present");
      } else if (section.kind === "notes") problem(n, "Notes are written as bullets (- a note), not as headings.");
      return;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      let body = bullet[1]!.trim();
      const suggested = FLAG.test(` ${body}`);
      if (suggested) body = body.replace(FLAG, "").trim();
      if (section?.kind === "notes") result.notes.push({ text: body, suggested });
      else if (open?.kind === "term") open.term.facts.push({ text: body, suggested });
      else problem(n, "A bullet belongs under a ## entry (a fact about it) or in the # Notes section.");
      return;
    }

    // Anything else is the body of the entry above it.
    if (open?.kind === "term") open.term.summary = `${open.term.summary} ${trimmed}`.trim();
    else if (open?.kind === "scene") open.scene.text = `${open.scene.text} ${trimmed}`.trim();
    else if (open?.kind === "summary") open.summary.text = `${open.summary.text} ${trimmed}`.trim();
    else problem(n, "This line does not belong to any entry. Put it under a ## heading, or write it as a bullet in # Notes.");
  });
  return result;
}

// ---- applying it to the entries ----

const lower = (s: string) => s.trim().toLocaleLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);

export interface Reconciled {
  /** Every entry after the edit, including rejected ones. */
  entries: KnowledgeEntry[];
  problems: KbProblem[];
}

/**
 * Applies an edited document to the existing entries. Entries keep their identity (and where they came from) when
 * they are recognized by their name, text or block. A suggestion that was deleted becomes a rejected entry, so that a
 * model does not suggest it again; a confirmed entry that was deleted is removed.
 */
export function reconcileDocument(existing: readonly KnowledgeEntry[], parsed: ParsedDocument, docs: readonly DocumentRef[], deps: EntryDeps): Reconciled {
  const at = deps.now();
  const problems = [...parsed.problems];
  const userOrigin: EntryOrigin = { by: "user" };
  const out: KnowledgeEntry[] = [];
  const blank = { source: "", target: "", hint: "", category: "term" as TermCategory, aliases: [] as string[], text: "", about: null as string | null, related: [] as string[], scope: null, origin: userOrigin, updatedAt: at };
  const status = (suggested: boolean) => (suggested ? ("suggested" as const) : ("confirmed" as const));
  const docByTitle = (t: string) => docs.find((d) => same(d.title, t));

  const oldTerms = existing.filter((e) => e.kind === "term" && e.status !== "rejected");
  const claimed = new Set<string>();
  const nameSet = (e: KnowledgeEntry) => [e.source, ...e.aliases];
  const termIds = new Map<DraftTerm, string>();

  // Terms, in the order of the document.
  for (const d of parsed.terms) {
    const old = oldTerms.find((t) => !claimed.has(t.id) && d.names.some((n) => nameSet(t).some((w) => same(w, n))));
    if (old) claimed.add(old.id);
    const changed = !old || old.source !== d.names[0] || old.target !== d.target || old.hint !== d.summary || old.aliases.join("\u0000") !== d.names.slice(1).join("\u0000") || old.category !== d.category;
    const keepOrigin = old && (!changed || old.origin.by === "user");
    const entry: KnowledgeEntry = {
      ...blank,
      id: old?.id ?? deps.newId(),
      kind: "term",
      source: d.names[0]!,
      aliases: d.names.slice(1),
      target: d.target,
      hint: d.summary,
      category: d.category,
      origin: keepOrigin ? old.origin : old?.origin.by === "model" ? { ...old.origin, by: "user" } : userOrigin,
      status: status(d.suggested),
      updatedAt: old && !changed && old.status === status(d.suggested) ? old.updatedAt : at,
    };
    termIds.set(d, entry.id);
    out.push(entry);
  }
  const resolve = (name: string) => out.find((e) => e.kind === "term" && nameSet(e).some((w) => same(w, name)))?.id;

  // Facts, under their terms.
  const oldNotes = existing.filter((e) => e.kind === "note" && e.status !== "rejected");
  const claimedNotes = new Set<string>();
  const addNote = (text: string, about: string | null, suggested: boolean) => {
    const old = oldNotes.find((n) => !claimedNotes.has(n.id) && n.about === about && same(n.text, text));
    if (old) claimedNotes.add(old.id);
    out.push({ ...blank, id: old?.id ?? deps.newId(), kind: "note", text, about, origin: old?.origin ?? userOrigin, status: status(suggested), updatedAt: old && old.status === status(suggested) ? old.updatedAt : at });
  };
  for (const d of parsed.terms) for (const f of d.facts) addNote(f.text, termIds.get(d) ?? null, f.suggested);
  for (const n of parsed.notes) addNote(n.text, null, n.suggested);

  // Scenes and summaries, for the documents that appear in the text.
  const seen = new Set(parsed.documentsSeen.map((t) => docByTitle(t)?.id).filter((id): id is string => !!id));
  for (const t of parsed.documentsSeen) if (!docByTitle(t)) problems.push({ line: 0, message: `There is no document called "${t}".` });
  const oldScenes = existing.filter((e) => e.kind === "scene" && e.scope && seen.has(e.scope.documentId));
  for (const d of parsed.scenes) {
    const doc = docByTitle(d.docTitle);
    if (!doc) continue;
    const old = oldScenes.find((s) => s.scope!.documentId === doc.id && s.scope!.block === d.from);
    if (!old) {
      problems.push({ line: 0, message: `Block ${d.from} of "${d.docTitle}" has no scene to edit. Scenes are written by Extract knowledge; you can edit them here but not add new ones.` });
      continue;
    }
    const related = d.present.map(resolve).filter((id): id is string => !!id);
    const changed = old.text !== d.text || old.related.join() !== related.join();
    out.push({ ...old, text: d.text, related, origin: changed && old.origin.by === "model" ? { ...old.origin, by: "user" } : old.origin, status: status(d.suggested), updatedAt: changed || old.status !== status(d.suggested) ? at : old.updatedAt });
  }
  for (const d of parsed.summaries) {
    const doc = docByTitle(d.docTitle);
    if (!doc) continue;
    const old = existing.find((e) => e.kind === "summary" && e.scope?.documentId === doc.id && e.status !== "rejected");
    const changed = !old || old.text !== d.text;
    out.push({ ...blank, ...(old ?? {}), id: old?.id ?? deps.newId(), kind: "summary", text: d.text, scope: old?.scope ?? { documentId: doc.id }, origin: old ? (changed && old.origin.by === "model" ? { ...old.origin, by: "user" } : old.origin) : userOrigin, status: status(d.suggested), updatedAt: changed ? at : old!.updatedAt });
  }
  // Scenes and summaries of documents that have no section were not touched.
  for (const e of existing) {
    if ((e.kind === "scene" || e.kind === "summary") && e.status !== "rejected" && !(e.scope && seen.has(e.scope.documentId))) out.push(e);
  }

  // What disappeared: a deleted suggestion is remembered as rejected; a deleted confirmed entry is gone.
  const keptIds = new Set(out.map((e) => e.id));
  const removedTerms = oldTerms.filter((t) => !keptIds.has(t.id));
  const removedTermIds = new Set(removedTerms.map((t) => t.id));
  const rejected: KnowledgeEntry[] = existing.filter((e) => e.status === "rejected" && !out.some((n) => e.kind === "term" && n.kind === "term" && nameSet(n).some((w) => nameSet(e).some((x) => same(w, x)))));
  for (const t of removedTerms) if (t.status === "suggested") rejected.push({ ...t, status: "rejected" });
  for (const n of oldNotes) {
    if (keptIds.has(n.id)) continue;
    if (n.status === "suggested") rejected.push({ ...n, status: "rejected" });
  }
  // A scene that listed someone who is gone no longer lists them.
  const gone = removedTermIds;
  const cleaned = out.map((e) => (e.kind === "scene" && e.related.some((r) => gone.has(r)) ? { ...e, related: e.related.filter((r) => !gone.has(r)) } : e));
  return { entries: [...cleaned, ...rejected], problems };
}
