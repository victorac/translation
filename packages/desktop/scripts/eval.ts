/**
 * Scores translations against human reference translations, so that prompt variants and models can be compared on quality rather than
 * on whether a model gives the same answer twice.
 *
 * The paragraphs are translated by the app's own WorkspaceService (workSync + workTranslate), so the prompt, the context that fits, the
 * retry when a glossary name is missing and the joining of several paragraphs are exactly what the app does on this checkout. To compare
 * a branch with main, run this in each checkout with --out, then --compare the two files.
 *
 *   pnpm --filter @ltw/desktop eval --fixture fixtures/eval-example.json --model qwen/qwen3-4b-2507 --prompt standard --prompt literary
 *   pnpm --filter @ltw/desktop eval --fixture my.local.json --model a --model b --out runs/today.json --label main
 *   pnpm --filter @ltw/desktop eval --compare runs/main.json runs/branch.json
 *
 * Options: --fixture FILE, --model ID (repeatable), --prompt ID (repeatable; the app's translation styles), --base-url URL (default
 * http://localhost:1234/v1), --practice (no server: the app's practice translator), --temperature N (default 0), --context N (default
 * 4096), --max-output N (default 1536), --label NAME, --out FILE, --compare FILE..., --show N (worst paragraphs listed, default 3),
 * --judge-url URL and --judge-model ID (a stronger model on an OpenAI-compatible endpoint scores each paragraph 1-5; key in
 * EVAL_JUDGE_KEY).
 *
 * The fixture is JSON: { sourceLanguage?, targetLanguage?, glossary: [{ source, target, kind?, note?, aliases? }], passages: [{ id,
 * source: string[], reference: string[], edits?, checks? }] }. Each passage is translated as one text, in order, so the paragraphs before
 * carry the model's own translations as context, as in the app. `edits` ({ "3": "text" }) are paragraphs the user translated before the
 * run: they are set as the user's own (and so can be sent as examples) and are not scored. `notes` ({ "0": "Told by Noah." }) are the
 * user's notes from a paragraph on. `checks` ([{ at, must?, not?, why }]) are
 * patterns (case-sensitive regular expressions) that the translation of paragraph `at` must or must not match: a pointed test of one
 * thing (a term in lowercase in prose, a speaker, a name that must not appear), more telling than chrF on a small set.
 * Do not commit fixtures made of someone's book: name them *.local.json.
 *
 * --compare also gives the change in chrF from the first run to each other one with a 95% interval (paired bootstrap over paragraphs):
 * an interval that contains 0 means the difference may be noise.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { missingNames, type PromptRecord } from "@ltw/domain";
import { ProviderService } from "../src/provider-service.js";
import { WorkspaceService } from "../src/service.js";
import { MemoryCredentialStore, MemorySettingsStore } from "../src/storage.js";

interface GlossaryItem {
  source: string;
  target: string;
  kind?: string;
  note?: string;
  aliases?: string[];
}
interface Fixture {
  sourceLanguage?: string;
  targetLanguage?: string;
  glossary: GlossaryItem[];
  passages: { id: string; source: string[]; reference: string[]; edits?: Record<string, string>; notes?: Record<string, string>; checks?: Check[] }[];
}
interface Check {
  at: number;
  must?: string[];
  not?: string[];
  why: string;
}
/** One paragraph as translated in one run. */
interface Row {
  passage: string;
  index: number;
  source: string;
  reference: string;
  output: string;
  /** What the app flagged (a missing name, several paragraphs joined), or null. */
  issue: string | null;
  /** Requests sent for this paragraph: 2 means the answer was refused once and asked again. */
  attempts: number;
  /** Some reply had more than one line (the app joins them). */
  multiLine: boolean;
  judge: number | null;
  /** The checks of this paragraph that failed, by their `why`. */
  failed?: string[];
  checks?: number;
}
interface Run {
  label: string;
  model: string;
  prompt: string;
  backend: "provider" | "practice";
  temperature: number;
  fixture: string;
  at: string;
  rows: Row[];
}

// ---- chrF (Popović 2015, as sacrebleu computes it: character n-grams 1..6, beta 2, whitespace removed, corpus statistics) ----

const CHAR_ORDER = 6;
const BETA = 2;

function ngrams(s: string, n: number): Map<string, number> {
  const chars = Array.from(s.replace(/\s+/g, ""));
  const out = new Map<string, number>();
  for (let i = 0; i + n <= chars.length; i++) {
    const g = chars.slice(i, i + n).join("");
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Per order: [hypothesis n-grams, reference n-grams, matching n-grams]. */
function chrfStats(hyp: string, ref: string): [number, number, number][] {
  const stats: [number, number, number][] = [];
  for (let n = 1; n <= CHAR_ORDER; n++) {
    const h = ngrams(hyp, n);
    const r = ngrams(ref, n);
    let match = 0;
    for (const [g, c] of h) match += Math.min(c, r.get(g) ?? 0);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    stats.push([sum(h), sum(r), match]);
  }
  return stats;
}

function chrfScore(stats: [number, number, number][]): number {
  const b2 = BETA * BETA;
  let score = 0;
  let orders = 0;
  for (const [hyp, ref, match] of stats) {
    if (hyp === 0 || ref === 0) continue;
    orders++;
    const p = match / hyp;
    const r = match / ref;
    if (p + r > 0) score += ((1 + b2) * p * r) / (b2 * p + r);
  }
  return orders === 0 ? 0 : (100 * score) / orders;
}

export function chrf(hyps: string[], refs: string[]): number {
  const total = Array.from({ length: CHAR_ORDER }, (): [number, number, number] => [0, 0, 0]);
  hyps.forEach((h, i) => chrfStats(h, refs[i]!).forEach((s, n) => s.forEach((v, j) => (total[n]![j]! += v))));
  return chrfScore(total);
}

// ---- other checks ----

/** Quotations in the source (「…」; 『…』 is left out, as it is mostly a title or a quote inside a quote) and in the translation ("…" or “…”). */
const sourceQuotes = (s: string): number => (s.match(/「/g) ?? []).length;
const targetQuotes = (s: string): number => (s.match(/“/g) ?? []).length + Math.floor((s.match(/"/g) ?? []).length / 2);

/** Text that does not belong in the translation: Japanese left in it, or a label or section from the prompt. */
const LEAK = /[぀-ヿ一-鿿]|\b(JAPANESE|ENGLISH|CONTEXT|NEXT|GLOSSARY|NOTES|PARAGRAPH TO TRANSLATE|REJECTED VERSION)\b|^(Translation|Here is)\b/m;

interface Scores {
  chrf: number;
  glossary: { hit: number; wanted: number };
  quotes: { ok: number; of: number };
  multiLine: number;
  leaks: number;
  retries: number;
  flagged: number;
  judge: number | null;
  paragraphs: number;
  checks: { ok: number; of: number };
}

function score(run: Run, glossary: GlossaryItem[]): Scores {
  const rows = run.rows;
  let hit = 0;
  let wanted = 0;
  let qOk = 0;
  let qOf = 0;
  for (const r of rows) {
    // The names whose full form or a short form stands in the source paragraph, not only inside a longer glossary word (灯 in 灯籠祭);
    // the ones the translation does not use are missing.
    for (const g of glossary) {
      const own = [g.source, ...(g.aliases ?? [])];
      const longer = glossary.flatMap((o) => (o === g ? [] : [o.source, ...(o.aliases ?? [])])).filter((w) => own.some((n) => w.length > n.length && w.includes(n)));
      const masked = longer.sort((a, b) => b.length - a.length).reduce((t, w) => t.split(w).join("\u0000"), r.source);
      if (!own.some((n) => masked.includes(n))) continue;
      wanted++;
      if (missingNames([g], masked, r.output).length === 0) hit++;
    }
    const sq = sourceQuotes(r.source);
    const tq = targetQuotes(r.output);
    if (sq > 0 || tq > 0) {
      qOf++;
      // As many quotations as the source, measured against the source rather than the reference, which may split or join them.
      if (sq === tq) qOk++;
    }
  }
  const judged = rows.filter((r) => r.judge !== null);
  return {
    chrf: chrf(rows.map((r) => r.output), rows.map((r) => r.reference)),
    glossary: { hit, wanted },
    quotes: { ok: qOk, of: qOf },
    multiLine: rows.filter((r) => r.multiLine).length,
    leaks: rows.filter((r) => LEAK.test(r.output)).length,
    retries: rows.filter((r) => r.attempts > 1).length,
    flagged: rows.filter((r) => r.issue !== null).length,
    judge: judged.length === 0 ? null : judged.reduce((a, r) => a + r.judge!, 0) / judged.length,
    paragraphs: rows.length,
    checks: { of: rows.reduce((n, r) => n + (r.checks ?? 0), 0), ok: rows.reduce((n, r) => n + (r.checks ?? 0) - (r.failed?.length ?? 0), 0) },
  };
}

// ---- translating ----

async function reachable(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id);
  } catch {
    return null;
  }
}

async function translatePassage(
  fixture: Fixture,
  passage: Fixture["passages"][number],
  opts: { backend: "provider" | "practice"; baseUrl: string; model: string; prompt: string; temperature: number; context: number; maxOutput: number },
): Promise<Omit<Row, "judge">[]> {
  const provider = new ProviderService(new MemorySettingsStore(), new MemoryCredentialStore());
  if (opts.backend === "provider") provider.save({ baseUrl: opts.baseUrl, allowRemote: true });
  const service = new WorkspaceService({ provider, speedMs: 0 });
  // The glossary is what the user confirmed: topics in the knowledge base, with their short forms.
  for (const g of fixture.glossary) {
    const { id } = service.knowledgeCreate(g.kind ?? "term", g.source, g.target, g.note);
    if (g.aliases?.length) service.knowledgeSetFile(id, service.knowledgeFile(id).text.replace(/^aliases:.*$/m, `aliases: ${g.aliases.join(", ")}`));
  }
  const known = new Set(fixture.glossary.flatMap((g) => [g.source, ...(g.aliases ?? [])]));
  const synced = await service.workSync({ documentId: service.snapshot().activeDocumentId, text: passage.source.join("\n\n") });
  if (!synced || synced.paragraphs.length !== passage.source.length) {
    throw new Error(`${passage.id}: the app reads ${synced?.paragraphs.length ?? 0} paragraphs, the fixture has ${passage.source.length} (each paragraph must be one line).`);
  }
  // Words the app found that are not in the fixture's glossary are left out, as a user would ignore them, so every run gets the same glossary.
  for (const w of synced.words) if (!known.has(w.source)) service.workSetUse(w.source, false);
  // What the user translated before: their own text, which the run keeps and does not score.
  const edits = new Map(Object.entries(passage.edits ?? {}).map(([k, v]) => [Number(k), v]));
  for (const [k, text] of edits) service.workSetPart(k, text);
  for (const [k, note] of Object.entries(passage.notes ?? {})) service.workSetNote(Number(k), note);
  const done = await service.workTranslate({
    backend: opts.backend,
    modelId: opts.model,
    contextLimit: opts.context,
    maxOutputTokens: opts.maxOutput,
    temperature: opts.temperature,
    promptId: opts.prompt,
    sourceLanguage: fixture.sourceLanguage ?? "Japanese",
    targetLanguage: fixture.targetLanguage ?? "English",
  });
  const log: PromptRecord[] = service.promptLog();
  return done.paragraphs.flatMap((p, k) => {
    if (edits.has(k)) return [];
    const asked = log.filter((r) => r.purpose === `Translation of paragraph ${k + 1}`);
    const checks = (passage.checks ?? []).filter((c) => c.at === k);
    const failed = checks.filter((c) => (c.must ?? []).some((m) => !new RegExp(m).test(p.translation)) || (c.not ?? []).some((m) => new RegExp(m).test(p.translation))).map((c) => c.why);
    return [{
      passage: passage.id,
      index: k,
      source: p.text,
      reference: passage.reference[k] ?? "",
      output: p.translation,
      issue: p.issue ?? null,
      attempts: asked.length,
      multiLine: asked.some((r) => (r.reply ?? "").trim().split(/\n+/).filter((l) => l.trim() !== "").length > 1),
      checks: checks.length,
      failed,
    }];
  });
}

// ---- judge ----

const JUDGE_SYSTEM = `You grade translations of fiction. You get a source paragraph, a reference translation by a professional, and a candidate translation. Judge the candidate on meaning (nothing added, left out or wrong), names and who does what, and natural, fitting English. The reference is one good translation, not the only one: different wording is fine. Reply with one digit from 1 to 5 and nothing else: 5 as good as the reference, 4 small issues, 3 a real error or clumsy, 2 several errors, 1 wrong or unusable.`;

async function judge(url: string, model: string, row: Omit<Row, "judge">): Promise<number | null> {
  const key = process.env["EVAL_JUDGE_KEY"];
  const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2048,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: `SOURCE:\n${row.source}\n\nREFERENCE:\n${row.reference}\n\nCANDIDATE:\n${row.output}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`judge: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const d = /[1-5]/.exec(text);
  return d ? Number(d[0]) : null;
}

// ---- is a difference real? ----

/**
 * The change in chrF from run `a` to run `b` with a 95% interval, by paired bootstrap: the paragraphs both runs translated are drawn again
 * with replacement many times, and the change is measured on each draw. Runs on different paragraphs cannot be compared.
 */
function delta(a: Run, b: Run): string {
  // The same paragraph with the same reference, whichever checkout's copy of the fixture the run read.
  const key = (r: Row) => `${r.passage}#${r.index}\u0000${r.source}\u0000${r.reference}`;
  const inB = new Map(b.rows.map((r) => [key(r), r]));
  const pairs = a.rows.filter((r) => inB.has(key(r))).map((r) => [r, inB.get(key(r))!] as const);
  if (pairs.length < 2) return "not comparable";
  const statsA = pairs.map(([x]) => chrfStats(x.output, x.reference));
  const statsB = pairs.map(([, y]) => chrfStats(y.output, y.reference));
  const corpus = (stats: [number, number, number][][], pick: number[]) => {
    const total = Array.from({ length: CHAR_ORDER }, (): [number, number, number] => [0, 0, 0]);
    for (const i of pick) stats[i]!.forEach((st, n) => st.forEach((v, j) => (total[n]![j]! += v)));
    return chrfScore(total);
  };
  const all = pairs.map((_, i) => i);
  const d = corpus(statsB, all) - corpus(statsA, all);
  // A fixed seed, so the same two runs always give the same interval.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const draws: number[] = [];
  for (let t = 0; t < 1000; t++) {
    const pick = all.map(() => Math.floor(rand() * all.length));
    draws.push(corpus(statsB, pick) - corpus(statsA, pick));
  }
  draws.sort((x, y) => x - y);
  const lo = draws[25]!;
  const hi = draws[974]!;
  const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  return `${sign(d)} [${sign(lo)}, ${sign(hi)}]${lo > 0 || hi < 0 ? "" : " (may be noise)"}`;
}

// ---- table ----

function table(runs: Run[], fixtures: Map<string, Fixture>, show: number): string {
  const scores = runs.map((r) => score(r, fixtures.get(r.fixture)?.glossary ?? []));
  const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(0)}% (${a}/${b})`);
  const lines: [string, ...string[]][] = [
    ["", ...runs.map((r) => r.label)],
    ["model", ...runs.map((r) => r.model)],
    ["prompt", ...runs.map((r) => r.prompt)],
    ["backend", ...runs.map((r) => (r.backend === "practice" ? "practice (stub)" : `server, t=${r.temperature}`))],
    ["chrF ↑", ...scores.map((s) => s.chrf.toFixed(1))],
    ["chrF change vs first (95%)", ...runs.map((r, i) => (i === 0 ? "-" : delta(runs[0]!, r)))],
    ["checks passed ↑", ...scores.map((s) => pct(s.checks.ok, s.checks.of))],
    ["judge 1-5 ↑", ...scores.map((s) => (s.judge === null ? "-" : s.judge.toFixed(2)))],
    ["glossary names used ↑", ...scores.map((s) => pct(s.glossary.hit, s.glossary.wanted))],
    ["quoted speech kept ↑", ...scores.map((s) => pct(s.quotes.ok, s.quotes.of))],
    ["several lines ↓", ...scores.map((s) => pct(s.multiLine, s.paragraphs))],
    ["leaks (Japanese/labels) ↓", ...scores.map((s) => pct(s.leaks, s.paragraphs))],
    ["asked twice ↓", ...scores.map((s) => pct(s.retries, s.paragraphs))],
    ["flagged by the app ↓", ...scores.map((s) => pct(s.flagged, s.paragraphs))],
  ];
  const head = lines[0]!;
  const widths = head.map((_, c) => Math.max(...lines.map((l) => (l[c] ?? "").length)));
  const fmt = (l: string[]) => l.map((x, c) => x.padEnd(widths[c]!)).join("  ").trimEnd();
  const out = [fmt(head), widths.map((w) => "-".repeat(w)).join("  "), ...lines.slice(1).map(fmt)];
  for (const r of runs) {
    const failed = r.rows.filter((row) => (row.failed ?? []).length > 0);
    if (failed.length === 0) continue;
    out.push("", `Failed checks, ${r.label}:`);
    for (const row of failed) out.push(`  ${row.passage}#${row.index + 1}  ${row.failed!.join("; ")}`, `    out: ${row.output}`);
  }
  if (show > 0) {
    for (const r of runs) {
      const worst = r.rows
        .map((row) => ({ row, s: chrf([row.output], [row.reference]) }))
        .sort((a, b) => a.s - b.s)
        .slice(0, show);
      out.push("", `Lowest chrF, ${r.label}:`);
      for (const { row, s } of worst) {
        out.push(`  ${row.passage}#${row.index + 1}  chrF ${s.toFixed(1)}${row.judge !== null ? `  judge ${row.judge}` : ""}${row.issue ? `  [${row.issue}]` : ""}`);
        out.push(`    out: ${row.output}`, `    ref: ${row.reference}`);
      }
    }
  }
  return out.join("\n");
}

// ---- main ----

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      fixture: { type: "string" },
      model: { type: "string", multiple: true },
      prompt: { type: "string", multiple: true },
      "base-url": { type: "string", default: "http://localhost:1234/v1" },
      practice: { type: "boolean", default: false },
      temperature: { type: "string", default: "0" },
      context: { type: "string", default: "4096" },
      "max-output": { type: "string", default: "1536" },
      label: { type: "string" },
      out: { type: "string" },
      compare: { type: "string", multiple: true },
      show: { type: "string", default: "3" },
      "judge-url": { type: "string" },
      "judge-model": { type: "string" },
    },
    allowPositionals: true,
  });
  const show = Number(values.show);
  const fixtures = new Map<string, Fixture>();
  const load = (f: string) => {
    if (!fixtures.has(f)) fixtures.set(f, JSON.parse(readFileSync(f, "utf8")) as Fixture);
    return fixtures.get(f)!;
  };

  // Comparing runs saved before (on main and on a branch, say): one column each.
  // `--compare a.json b.json` gives the first file to the option and the others as positionals: all of them are compared.
  if (values.compare?.length) {
    const runs = [...values.compare, ...positionals].flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { runs: Run[] }).runs);
    for (const r of runs) load(r.fixture);
    console.log(table(runs, fixtures, show));
    return;
  }

  if (!values.fixture) throw new Error("Give --fixture FILE (see fixtures/eval-example.json), or --compare FILE...");
  const fixturePath = resolve(values.fixture);
  const fixture = load(fixturePath);
  for (const p of fixture.passages) {
    if (p.source.length !== p.reference.length) throw new Error(`${p.id}: ${p.source.length} paragraphs but ${p.reference.length} references.`);
    for (const c of p.checks ?? []) if (c.at < 0 || c.at >= p.source.length || Object.hasOwn(p.edits ?? {}, String(c.at))) throw new Error(`${p.id}: a check is on paragraph ${c.at}, which is not a paragraph that is translated.`);
  }

  const baseUrl = values["base-url"].replace(/\/$/, "");
  const served = values.practice ? null : await reachable(baseUrl);
  const backend = served === null ? "practice" : "provider";
  if (backend === "practice") console.error(values.practice ? "Using the practice translator." : `No model server at ${baseUrl}: using the practice translator, so the scores say nothing about quality.`);
  const models = values.model?.length ? values.model : served?.length ? [served.find((m) => !/embed/i.test(m)) ?? served[0]!] : ["practice"];
  // A variant (qwen/qwen3-4b-2507@4bit) is listed only once it is loaded, but LM Studio loads it when asked.
  for (const m of models) if (served && !served.includes(m) && !served.includes(m.split("@")[0]!)) throw new Error(`${baseUrl} does not have the model "${m}". It has: ${served.join(", ")}.`);
  const prompts = values.prompt?.length ? values.prompt : ["standard"];
  const temperature = Number(values.temperature);
  const judgeUrl = values["judge-url"];
  const judgeModel = values["judge-model"];
  if (!!judgeUrl !== !!judgeModel) throw new Error("A judge needs both --judge-url and --judge-model.");

  const runs: Run[] = [];
  for (const model of models) {
    for (const prompt of prompts) {
      const label = [values.label, models.length > 1 ? model.split("/").pop() : "", prompts.length > 1 ? prompt : ""].filter(Boolean).join(" ") || model.split("/").pop()!;
      const started = Date.now();
      const rows: Row[] = [];
      for (const passage of fixture.passages) {
        process.stderr.write(`${label}: ${passage.id}...`);
        const done = await translatePassage(fixture, passage, { backend, baseUrl, model, prompt, temperature, context: Number(values.context), maxOutput: Number(values["max-output"]) });
        for (const row of done) rows.push({ ...row, judge: judgeUrl && judgeModel ? await judge(judgeUrl, judgeModel, row) : null });
        process.stderr.write(" done\n");
      }
      console.error(`${label}: ${rows.length} paragraphs in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      runs.push({ label, model, prompt, backend, temperature, fixture: fixturePath, at: new Date().toISOString(), rows });
    }
  }

  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, JSON.stringify({ runs }, null, 2));
    console.error(`Saved to ${values.out}`);
  }
  console.log(table(runs, fixtures, show));
}

if (process.argv[1]?.endsWith("eval.ts")) main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
