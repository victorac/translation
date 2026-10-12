import { blockText, type SourceRevision } from "./revision.js";
import type { BlockOutput, BlockState, ModelRun, OutputVersion } from "./state.js";

/**
 * Turning results into files. Pure functions: they read results and never change them or start any translation.
 *
 *  - text:     one model's translation as plain text
 *  - markdown: one or several models, each in a labelled section
 *  - csv:      a side-by-side comparison, one row per block, with a status column per model
 */
export type ExportFormat = "text" | "markdown" | "csv";
/** `current` is what you see (including your edits); `original` is what the model wrote, ignoring edits. */
export type ExportTextVersion = "current" | "original";

export interface ExportOptions {
  format: ExportFormat;
  runIds: string[];
  textVersion: ExportTextVersion;
  /** Needed when some blocks have no translation. Those blocks are marked instead of silently dropped. */
  allowPartial: boolean;
  /** CSV only: put an apostrophe before text starting with = + - @ so spreadsheets do not treat it as a formula. */
  formulaSafe?: boolean;
  /** Used for the file name and the Markdown title. */
  title: string;
  now?: Date;
}

export interface ExportModelSummary {
  runId: string;
  label: string;
  blocks: number;
  /** Blocks that will have text in the file. */
  included: number;
  missing: number;
  outOfDate: number;
  needsReview: number;
  /** Blocks where your edit differs from the model's own text. */
  edited: number;
}

export interface ExportNote {
  runId: string;
  label: string;
  blockNumber: number;
  status: string;
}

export interface ExportPreview {
  format: ExportFormat;
  fileName: string;
  extension: string;
  models: ExportModelSummary[];
  /** Blocks with no text at all. Blocking unless the user chooses a partial export. */
  gaps: ExportNote[];
  /** Blocks that have text but deserve a look (out of date, needs review, new version waiting). */
  warnings: ExportNote[];
  /** No gaps. */
  complete: boolean;
  /** The start of the file, for a quick look. */
  excerpt: string;
  bytes: number;
  /** Why no file can be made with these choices, or null. */
  problem: string | null;
}

export interface ExportResult {
  preview: ExportPreview;
  /** The whole file, or null when there is a problem or a partial export has not been allowed. */
  content: string | null;
}

const STATE_LABEL: Record<BlockState, string> = {
  pending: "Not translated yet",
  waiting: "Waiting",
  running: "Translating",
  succeeded: "Done",
  needs_review: "Needs review",
  failed: "Failed",
  canceled: "Canceled",
  stale: "Out of date",
};

const EXTENSION: Record<ExportFormat, string> = { text: ".txt", markdown: ".md", csv: ".csv" };

/** The model's own text for a block, following edits back to the version the model produced. */
function originalVersion(o: BlockOutput): OutputVersion | undefined {
  let v = o.versions.find((x) => x.id === o.currentVersionId);
  while (v && v.kind === "manual") {
    const base = v.baseVersionId;
    v = base ? o.versions.find((x) => x.id === base) : undefined;
  }
  return v;
}

interface Resolved {
  text: string | null;
  status: string;
  edited: boolean;
  note: boolean;
}

function resolve(o: BlockOutput, version: ExportTextVersion): Resolved {
  const current = o.versions.find((v) => v.id === o.currentVersionId);
  const chosen = version === "original" ? originalVersion(o) : current;
  const edited = current?.kind === "manual";
  if (!chosen) return { text: null, status: STATE_LABEL[o.state], edited: false, note: false };
  // A failed or canceled retry does not change what is exported: the earlier accepted text is kept.
  const flagged = o.state === "stale" || o.state === "needs_review";
  let status = flagged ? STATE_LABEL[o.state] : "Done";
  if (edited && version === "current" && !flagged) status = "Done (edited by you)";
  if (o.candidate && !flagged) status = `${status}, newer version not chosen`;
  return { text: chosen.text, status, edited, note: flagged || o.candidate !== undefined };
}

const newlineSuffix = (s: string): string => /\n+$/.exec(s)?.[0] ?? "";

/** A file name that is safe on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 80);
  return cleaned === "" ? "translation" : cleaned;
}

function csvField(value: string, formulaSafe: boolean): string {
  const v = formulaSafe && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildExport(revision: SourceRevision, runs: ModelRun[], options: ExportOptions): ExportResult {
  const chosen: ModelRun[] = [];
  let problem: string | null = null;
  for (const id of options.runIds) {
    const r = runs.find((x) => x.id === id);
    if (r) chosen.push(r);
    else problem = "One of the chosen models is not part of this project.";
  }
  if (!problem && chosen.length === 0) problem = "Choose at least one model to export.";
  if (!problem && options.format === "text" && chosen.length > 1) problem = "Plain text holds one model at a time. Choose one model, or use Markdown or CSV for several.";

  const blocks = revision.blocks;
  const models: ExportModelSummary[] = [];
  const gaps: ExportNote[] = [];
  const warnings: ExportNote[] = [];
  const grid = new Map<string, Resolved[]>();

  for (const run of chosen) {
    const row: Resolved[] = blocks.map((b) => resolve(run.outputs[b.id] ?? { blockId: b.id, state: "pending", attempts: [], versions: [] }, options.textVersion));
    grid.set(run.id, row);
    const s: ExportModelSummary = { runId: run.id, label: run.label, blocks: blocks.length, included: 0, missing: 0, outOfDate: 0, needsReview: 0, edited: 0 };
    row.forEach((r, i) => {
      const out = run.outputs[blocks[i]!.id];
      const note = { runId: run.id, label: run.label, blockNumber: i + 1, status: r.status };
      if (r.text === null) {
        s.missing++;
        gaps.push(note);
      } else {
        s.included++;
        if (r.note) warnings.push(note);
      }
      if (out?.state === "stale") s.outOfDate++;
      if (out?.state === "needs_review") s.needsReview++;
      const cur = out?.versions.find((v) => v.id === out.currentVersionId);
      if (cur?.kind === "manual") s.edited++;
    });
    models.push(s);
  }

  const complete = gaps.length === 0;
  const extension = EXTENSION[options.format];
  const base = safeFileName(options.title);
  const fileName =
    options.format === "text" && chosen[0]
      ? `${base} - ${safeFileName(chosen[0].label)}${extension}`
      : options.format === "csv"
        ? `${base} - comparison${extension}`
        : `${base}${extension}`;

  let content: string | null = null;
  if (!problem && (complete || options.allowPartial)) {
    content = render(revision, chosen, grid, options);
  }
  const preview: ExportPreview = {
    format: options.format,
    fileName,
    extension,
    models,
    gaps,
    warnings,
    complete,
    excerpt: content ? content.replace(/^﻿/, "").slice(0, 600) : "",
    bytes: content ? new TextEncoder().encode(content).length : 0,
    problem,
  };
  return { preview, content };
}

function render(revision: SourceRevision, runs: ModelRun[], grid: Map<string, Resolved[]>, options: ExportOptions): string {
  const blocks = revision.blocks;
  const sources = blocks.map((b) => blockText(revision, b));

  /** One model's translation as running text, keeping the paragraph breaks the source had. */
  const body = (run: ModelRun, italicGaps: boolean): string =>
    grid
      .get(run.id)!
      .map((r, i) => {
        const last = i === blocks.length - 1;
        const suffix = last ? "" : (newlineSuffix(sources[i]!) || "\n");
        const text = r.text !== null ? r.text : italicGaps ? `*[Block ${i + 1} missing: ${r.status}]*` : `[Block ${i + 1} missing: ${r.status}]`;
        return text.endsWith("\n") ? text : text + suffix;
      })
      .join("");

  if (options.format === "text") return body(runs[0]!, false);

  if (options.format === "markdown") {
    const when = (options.now ?? new Date()).toISOString().slice(0, 10);
    const head = `# ${options.title}\n\n*${revision.sourceLanguage} → ${revision.targetLanguage} · exported ${when}*\n`;
    const sections = runs.map((run) => `\n## ${run.label}\n\n${body(run, true).replace(/\n*$/, "")}\n`);
    return head + sections.join("");
  }

  const safe = options.formulaSafe ?? true;
  const header = ["Block", `Source (${revision.sourceLanguage})`, ...runs.flatMap((r) => [r.label, `${r.label} status`])];
  const rows: string[][] = [header];
  blocks.forEach((_, i) => {
    rows.push([String(i + 1), sources[i]!, ...runs.flatMap((run) => {
      const r = grid.get(run.id)![i]!;
      return [r.text ?? "", r.status];
    })]);
  });
  // RFC 4180: comma separated, CRLF line ends, quotes doubled. The byte-order mark lets Excel read Japanese correctly.
  return "﻿" + rows.map((row, ri) => row.map((f, ci) => csvField(f, safe && ri > 0 && (ci === 1 || (ci >= 2 && ci % 2 === 0)))).join(",")).join("\r\n") + "\r\n";
}
