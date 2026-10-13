import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { entryProblems, newId, type EntryCounts, type EntryDeps, type EntryInput, type EntryOrigin, type EntryQuery, type KnowledgeEntry } from "@ltw/domain";
import { UserError } from "./errors.js";

interface Row {
  id: string;
  seq: number;
  kind: string;
  source: string;
  target: string;
  hint: string;
  keys: string;
  text: string;
  origin: string;
  status: string;
  updated_at: string;
}

const toEntry = (r: Row): KnowledgeEntry => ({
  id: r.id,
  kind: r.kind === "note" ? "note" : "term",
  source: r.source,
  target: r.target,
  hint: r.hint,
  keys: JSON.parse(r.keys) as string[],
  text: r.text,
  origin: JSON.parse(r.origin) as EntryOrigin,
  status: r.status === "suggested" ? "suggested" : "confirmed",
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
      keys TEXT NOT NULL, text TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }

  private insert(e: KnowledgeEntry, seq: number = ++this.seq): void {
    this.db
      .prepare("INSERT OR REPLACE INTO entries (id, seq, kind, source, target, hint, keys, text, origin, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(e.id, seq, e.kind, e.source, e.target, e.hint, JSON.stringify(e.keys), e.text, JSON.stringify(e.origin), e.status, e.updatedAt);
  }

  /** Replaces everything, for example when a project is opened. Does not count as a change. */
  load(entries: readonly KnowledgeEntry[]): void {
    this.db.exec("DELETE FROM entries");
    this.seq = 0;
    for (const e of entries) this.insert(e);
    this.rev++;
  }

  /** Every entry, in the order they were added. */
  all(): KnowledgeEntry[] {
    return (this.db.prepare("SELECT * FROM entries ORDER BY seq").all() as unknown as Row[]).map(toEntry);
  }

  list(q: EntryQuery = {}, limit = 5000): { entries: KnowledgeEntry[]; total: number } {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (q.kind) (where.push("kind = ?"), args.push(q.kind));
    if (q.status) (where.push("status = ?"), args.push(q.status));
    if (q.by) (where.push("json_extract(origin, '$.by') = ?"), args.push(q.by));
    const text = q.text?.trim();
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(source LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR hint LIKE ? ESCAPE '\\' OR keys LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like, like);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM entries${clause}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM entries${clause} ORDER BY seq LIMIT ${Math.max(1, Math.floor(limit))}`).all(...args) as unknown as Row[];
    return { entries: rows.map(toEntry), total };
  }

  counts(): EntryCounts {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      terms: n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'term'"),
      notes: n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'note'"),
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
    const keys = input.keys.map((k) => k.trim()).filter(Boolean);
    const clean = { kind: input.kind, source: input.source.trim(), target: input.target.trim(), hint: input.hint.trim(), keys, text: input.text.trim() };
    const before = input.id ? this.get(input.id) : undefined;
    if (input.id && !before) throw new UserError("no_entry", "That entry no longer exists.");
    if (!before && clean.kind === "term" && this.all().some((e) => e.kind === "term" && e.source === clean.source)) {
      throw new UserError("duplicate_entry", `"${clean.source}" is already listed. Edit that entry instead.`);
    }
    const unchanged = before && JSON.stringify([before.kind, before.source, before.target, before.hint, before.keys, before.text]) === JSON.stringify([clean.kind, clean.source, clean.target, clean.hint, clean.keys, clean.text]);
    const entry: KnowledgeEntry = {
      id: before?.id ?? this.deps.newId(),
      ...clean,
      origin: before ? (unchanged ? before.origin : before.origin.by === "model" ? { ...before.origin, by: "user" } : before.origin) : { by: "user" },
      status: "confirmed",
      updatedAt: this.deps.now(),
    };
    // An edited entry keeps its place in the list.
    const place = before ? (this.db.prepare("SELECT seq FROM entries WHERE id = ?").get(before.id) as { seq: number }).seq : undefined;
    this.insert(entry, place);
    this.rev++;
    return entry;
  }

  remove(ids: readonly string[]): number {
    let n = 0;
    for (const id of ids) n += Number(this.db.prepare("DELETE FROM entries WHERE id = ?").run(id).changes);
    if (n > 0) this.rev++;
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
    const before = JSON.stringify(this.all());
    if (before === JSON.stringify(entries)) return;
    this.db.exec("DELETE FROM entries");
    this.seq = 0;
    for (const e of entries) this.insert(e);
    this.rev++;
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
