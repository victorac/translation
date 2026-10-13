import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { entryProblems, newId, normalizeEntry, type EntryCounts, type EntryDeps, type EntryInput, type EntryOrigin, type EntryQuery, type KnowledgeEntry } from "@ltw/domain";
import { UserError } from "./errors.js";

interface Row {
  id: string;
  seq: number;
  kind: string;
  source: string;
  target: string;
  hint: string;
  category: string;
  aliases: string;
  about: string | null;
  related: string;
  scope: string | null;
  text: string;
  origin: string;
  status: string;
  updated_at: string;
}

const toEntry = (r: Row): KnowledgeEntry => ({
  id: r.id,
  kind: (["term", "note", "scene", "summary"].includes(r.kind) ? r.kind : "term") as KnowledgeEntry["kind"],
  source: r.source,
  target: r.target,
  hint: r.hint,
  category: r.category === "character" || r.category === "place" ? r.category : "term",
  aliases: JSON.parse(r.aliases) as string[],
  text: r.text,
  about: r.about,
  related: JSON.parse(r.related) as string[],
  scope: r.scope ? (JSON.parse(r.scope) as KnowledgeEntry["scope"]) : null,
  origin: JSON.parse(r.origin) as EntryOrigin,
  status: r.status === "suggested" ? "suggested" : r.status === "rejected" ? "rejected" : "confirmed",
  updatedAt: r.updated_at,
});

/**
 * The project's names, hints and notes, kept in a small SQLite database that lives in memory while the project is
 * open. The project file is where it is saved: entries are written into it and loaded back when it is opened.
 */
export class KnowledgeStore {
  private readonly db = new DatabaseSync(":memory:");
  private seq = 0;
  /** Goes up on every change, so the window knows to ask again. */
  rev = 0;

  constructor(private readonly deps: EntryDeps = { newId, now: () => new Date().toISOString() }) {
    this.db.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, hint TEXT NOT NULL,
      category TEXT NOT NULL, aliases TEXT NOT NULL, about TEXT, related TEXT NOT NULL, scope TEXT, text TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }

  private insert(e: KnowledgeEntry, seq: number = ++this.seq): void {
    this.db
      .prepare("INSERT OR REPLACE INTO entries (id, seq, kind, source, target, hint, category, aliases, about, related, scope, text, origin, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(e.id, seq, e.kind, e.source, e.target, e.hint, e.category, JSON.stringify(e.aliases), e.about, JSON.stringify(e.related), e.scope ? JSON.stringify(e.scope) : null, e.text, JSON.stringify(e.origin), e.status, e.updatedAt);
  }

  /** Replaces everything, for example when a project is opened. Does not count as a change. */
  load(entries: readonly KnowledgeEntry[]): void {
    this.db.exec("DELETE FROM entries");
    this.seq = 0;
    for (const e of entries) this.insert(normalizeEntry(e));
    this.rev++;
  }

  /** Every entry that is part of the knowledge, in the order they were added. Rejected entries are not. */
  all(): KnowledgeEntry[] {
    return (this.db.prepare("SELECT * FROM entries WHERE status != 'rejected' ORDER BY seq").all() as unknown as Row[]).map(toEntry);
  }

  /** Entries the user checked and found wrong, kept so that a model does not suggest them again. */
  rejected(): KnowledgeEntry[] {
    return (this.db.prepare("SELECT * FROM entries WHERE status = 'rejected' ORDER BY seq").all() as unknown as Row[]).map(toEntry);
  }

  /** Entries that are part of the knowledge and entries that were rejected, for saving. */
  everything(): KnowledgeEntry[] {
    return (this.db.prepare("SELECT * FROM entries ORDER BY seq").all() as unknown as Row[]).map(toEntry);
  }

  list(q: EntryQuery = {}, limit = 5000): { entries: KnowledgeEntry[]; total: number } {
    const where: string[] = ["status != 'rejected'"];
    const args: SQLInputValue[] = [];
    if (q.kind) (where.push("kind = ?"), args.push(q.kind));
    if (q.status) (where.push("status = ?"), args.push(q.status));
    if (q.by) (where.push("json_extract(origin, '$.by') = ?"), args.push(q.by));
    const text = q.text?.trim();
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(source LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR hint LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like, like);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM entries${clause}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM entries${clause} ORDER BY seq LIMIT ${Math.max(1, Math.floor(limit))}`).all(...args) as unknown as Row[];
    return { entries: rows.map(toEntry), total };
  }

  counts(): EntryCounts {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const live = "status != 'rejected'";
    return {
      terms: n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'term' AND " + live),
      notes: n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'note' AND " + live),
      scenes: n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'scene' AND " + live),
      summaries: n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'summary' AND " + live),
      suggested: n("SELECT COUNT(*) AS n FROM entries WHERE status = 'suggested'"),
    };
  }

  private get(id: string): KnowledgeEntry | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? toEntry(row) : undefined;
  }

  /**
   * Adds an entry or changes one. Whatever the user saves counts as confirmed, and as the user's own work
   * unless a model wrote it and nothing but the status changed.
   */
  save(input: EntryInput): KnowledgeEntry {
    const problems = entryProblems(input);
    if (problems.length > 0) throw new UserError("bad_entry", problems[0]!);
    const clean = { kind: input.kind, source: input.source.trim(), target: input.target.trim(), hint: input.hint.trim(), category: input.kind === "term" ? input.category : ("term" as const), aliases: input.kind === "term" ? input.aliases.map((a) => a.trim()).filter((a) => a !== "" && a !== input.source.trim()) : [], text: input.text.trim(), about: input.kind === "note" ? input.about : null };
    const before = input.id ? this.get(input.id) : undefined;
    if (input.id && !before) throw new UserError("no_entry", "That entry no longer exists.");
    if (!before && clean.kind === "term" && this.all().some((e) => e.kind === "term" && e.source === clean.source)) {
      throw new UserError("duplicate_entry", `"${clean.source}" is already listed. Edit that entry instead.`);
    }
    const unchanged = before && JSON.stringify([before.kind, before.source, before.target, before.hint, before.category, before.aliases, before.text, before.about]) === JSON.stringify([clean.kind, clean.source, clean.target, clean.hint, clean.category, clean.aliases, clean.text, clean.about]);
    const entry: KnowledgeEntry = {
      id: before?.id ?? this.deps.newId(),
      ...clean,
      related: before?.related ?? [],
      scope: before?.scope ?? (input.kind === "summary" && input.documentId ? { documentId: input.documentId } : null),
      origin: before ? (unchanged ? before.origin : before.origin.by === "model" ? { ...before.origin, by: "user" } : before.origin) : { by: "user" },
      status: "confirmed",
      updatedAt: this.deps.now(),
    };
    // An edited entry keeps its place in the list.
    const place = before ? (this.db.prepare("SELECT seq FROM entries WHERE id = ?").get(before.id) as { seq: number }).seq : undefined;
    this.insert(entry, place);
    if (entry.kind === "term") this.db.prepare("DELETE FROM entries WHERE status = 'rejected' AND kind = 'term' AND source = ?").run(entry.source);
    this.rev++;
    return entry;
  }

  /** Removes entries. Facts about a removed term go with it, and scenes stop listing it as present. */
  remove(ids: readonly string[]): number {
    const gone = new Set(ids);
    for (const e of this.all()) if (e.kind === "note" && e.about !== null && gone.has(e.about)) gone.add(e.id);
    let n = 0;
    for (const id of gone) n += Number(this.db.prepare("DELETE FROM entries WHERE id = ?").run(id).changes);
    if (n > 0) {
      for (const e of this.all()) {
        if (e.kind === "scene" && e.related.some((r) => gone.has(r))) {
          this.db.prepare("UPDATE entries SET related = ? WHERE id = ?").run(JSON.stringify(e.related.filter((r) => !gone.has(r))), e.id);
        }
      }
      this.rev++;
    }
    return n;
  }

  /** Marks entries as looked at. With no ids, every suggested entry is confirmed. */
  confirm(ids?: readonly string[]): number {
    const now = this.deps.now();
    let n = 0;
    if (!ids) n = Number(this.db.prepare("UPDATE entries SET status = 'confirmed', updated_at = ? WHERE status = 'suggested'").run(now).changes);
    else for (const id of ids) n += Number(this.db.prepare("UPDATE entries SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'suggested'").run(now, id).changes);
    if (n > 0) this.rev++;
    return n;
  }

  /** Replaces the stored entries with a list that was worked out from them (for example after adding suggestions). */
  replaceWith(entries: readonly KnowledgeEntry[]): void {
    if (JSON.stringify(this.everything()) === JSON.stringify(entries)) return;
    this.db.exec("DELETE FROM entries");
    this.seq = 0;
    for (const e of entries) this.insert(e);
    this.rev++;
  }

  /** Replaces the entries that are part of the knowledge and keeps the rejected ones. */
  replaceLive(entries: readonly KnowledgeEntry[]): void {
    this.replaceWith([...entries, ...this.rejected()]);
  }

  /**
   * Throws away what a model suggested from one document, so that reading it again starts from what was confirmed.
   * A suggestion that something confirmed depends on (a fact about it, a scene listing it) is kept.
   */
  discardSuggested(documentId: string, documentTitle: string): number {
    const live = this.all();
    const fromHere = (e: KnowledgeEntry) =>
      e.status === "suggested" && e.origin.by === "model" && (e.scope?.documentId === documentId || e.origin.documentId === documentId || (e.origin.documentId === undefined && e.origin.documentTitle === documentTitle));
    const needed = new Set<string>();
    for (const e of live) {
      if (e.status === "confirmed" && e.about) needed.add(e.about);
      if (e.status === "confirmed") for (const r of e.related) needed.add(r);
    }
    const gone = new Set(live.filter((e) => fromHere(e) && !needed.has(e.id)).map((e) => e.id));
    for (const e of live) if (e.kind === "note" && e.about && gone.has(e.about)) gone.add(e.id);
    if (gone.size === 0) return 0;
    this.replaceLive(live.filter((e) => !gone.has(e.id)).map((e) => (e.kind === "scene" && e.related.some((r) => gone.has(r)) ? { ...e, related: e.related.filter((r) => !gone.has(r)) } : e)));
    return gone.size;
  }

  /** Adds entries that are not yet there (a term with the same source, or a note with the same text, is skipped). Returns how many were added. */
  addMany(entries: readonly KnowledgeEntry[]): number {
    const have = this.all();
    let added = 0;
    for (const e of entries) {
      const dup = have.some((h) => h.kind === e.kind && (e.kind === "term" ? h.source === e.source : h.text.toLocaleLowerCase() === e.text.toLocaleLowerCase()));
      if (dup) continue;
      this.insert(e);
      have.push(e);
      added++;
    }
    if (added > 0) this.rev++;
    return added;
  }

  close(): void {
    this.db.close();
  }
}
