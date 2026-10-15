import {
  estimateTokens,
} from "./tokens.js";

export const CHUNKER_VERSION = "1";

/** How the block ended. `quote` = a split inside a Japanese quote pair; `hard` = Unicode scalar split. */
export type BoundaryKind =
  | "chapter"
  | "paragraph"
  | "sentence"
  | "quote"
  | "line"
  | "whitespace"
  | "hard"
  | "end";

export interface ChunkOptions {
  /** Pack toward this many estimated tokens. Default 600. */
  targetTokens?: number;
  /** Hard ceiling per block (caller passes min(900, shared model budget)). Default 900. */
  maxTokens?: number;
  estimateTokens?: (text: string) => number;
  /** Receives one line without its newline. Default: 3+ repeats of one divider character. */
  isChapterSeparator?: (line: string) => boolean;
}

/** Offsets are UTF-16 code units into the exact source passed to `chunkSource`. */
export interface ChunkBlock {
  index: number;
  startOffset: number;
  endOffset: number;
  boundaryKind: BoundaryKind;
  estimatedTokens: number;
}

interface Unit {
  start: number;
  end: number;
  kind: BoundaryKind;
  /** Starts a new chapter section; packing never crosses it. */
  barrier: boolean;
}

const SEPARATOR_RE = /^\s*([-*=_~＊◆◇■□○●★☆※#])(?:\s*\1){2,}\s*$/u;
export const defaultIsChapterSeparator = (line: string): boolean => SEPARATOR_RE.test(line);

const TERMINATORS = new Set(["。", "！", "？", "．", ".", "!", "?", "…"]);
const QUOTE_OPEN = new Set(["「", "『", "（"]);
const QUOTE_CLOSE = new Set(["」", "』", "）"]);
/** Closing characters that stay attached to the sentence they follow. */
const TRAILING = new Set(["」", "』", "）", "〉", "》", "】", ")", '"', "'", "”", "’"]);

const isWs = (c: string | undefined): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "　";

function skipWs(text: string, i: number, e: number): number {
  while (i < e && isWs(text[i])) i++;
  return i;
}

export function chunkSource(text: string, options: ChunkOptions = {}): ChunkBlock[] {
  const est = options.estimateTokens ?? estimateTokens;
  const isSep = options.isChapterSeparator ?? defaultIsChapterSeparator;
  const maxTokens = options.maxTokens ?? 900;
  const targetTokens = Math.min(options.targetTokens ?? 600, maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError("maxTokens must be a positive integer");
  }
  if (!Number.isInteger(targetTokens) || targetTokens < 1) {
    throw new RangeError("targetTokens must be a positive integer");
  }
  if (text.length === 0) return [];

  const slice = (s: number, e: number) => text.slice(s, e);

  // 1. Paragraph units, with chapter separator lines as barriers.
  const units = splitParagraphs(text, isSep);

  // 2. Replace oversized units by finer pieces.
  const flat: Unit[] = [];
  for (const u of units) flat.push(...fit(u, 0));

  // 3. Greedy packing toward the target, never across a barrier.
  const blocks: ChunkBlock[] = [];
  let cur: { start: number; end: number; kind: BoundaryKind } | null = null;
  const flush = (kind: BoundaryKind) => {
    if (!cur) return;
    blocks.push({
      index: blocks.length,
      startOffset: cur.start,
      endOffset: cur.end,
      boundaryKind: kind,
      estimatedTokens: est(slice(cur.start, cur.end)),
    });
    cur = null;
  };
  for (const u of flat) {
    if (cur && u.barrier) flush("chapter");
    if (!cur) {
      cur = { start: u.start, end: u.end, kind: u.kind };
    } else if (est(slice(cur.start, u.end)) <= targetTokens) {
      cur.end = u.end;
      cur.kind = u.kind;
    } else {
      flush(cur.kind);
      cur = { start: u.start, end: u.end, kind: u.kind };
    }
  }
  flush("end");
  if (blocks.length > 0) blocks[blocks.length - 1]!.boundaryKind = "end";

  // Invariant 1: contiguous and complete.
  let pos = 0;
  for (const b of blocks) {
    if (b.startOffset !== pos || b.endOffset <= b.startOffset) throw new Error("chunker invariant violated");
    pos = b.endOffset;
  }
  if (pos !== text.length) throw new Error("chunker invariant violated");
  return blocks;

  // ---- helpers closed over text/est/maxTokens ----

  function fit(unit: Unit, level: number): Unit[] {
    if (est(slice(unit.start, unit.end)) <= maxTokens) return [unit];
    for (let l = level; l < LEVELS.length; l++) {
      const level_ = LEVELS[l]!;
      const cuts = level_.cuts(text, unit.start, unit.end, maxTokens, est);
      if (cuts.length < 2) continue;
      const kind = level_.kind(slice(unit.start, unit.end));
      const out: Unit[] = [];
      let s = unit.start;
      cuts.forEach((c, i) => {
        const piece: Unit = {
          start: s,
          end: c,
          kind: i === cuts.length - 1 ? unit.kind : kind,
          barrier: i === 0 && unit.barrier,
        };
        out.push(...fit(piece, l + 1));
        s = c;
      });
      return out;
    }
    return [unit]; // a single scalar larger than maxTokens: cannot split further
  }
}

function splitParagraphs(text: string, isSep: (line: string) => boolean): Unit[] {
  const units: Unit[] = [];
  let start = 0;
  let sepUnit = false;
  let prevBlank = false;
  let pos = 0;
  const cut = (at: number) => {
    if (at > start) units.push({ start, end: at, kind: "paragraph", barrier: sepUnit });
    start = at;
  };
  while (pos < text.length) {
    let eol = text.indexOf("\n", pos);
    eol = eol === -1 ? text.length : eol + 1;
    const body = text.slice(pos, eol).replace(/\n$/, "");
    if (body.trim() === "") {
      prevBlank = true;
    } else if (isSep(body)) {
      cut(pos);
      sepUnit = true;
      prevBlank = false;
    } else {
      // First content line after a blank run or after a separator starts a new unit.
      if (pos > start && (prevBlank || sepUnit)) {
        cut(pos);
        sepUnit = false;
      }
      prevBlank = false;
    }
    pos = eol;
  }
  cut(text.length);

  // Whitespace-only units merge into the previous unit (or the next one at document start).
  const merged: Unit[] = [];
  let carry: number | null = null;
  for (const u of units) {
    const wsOnly = text.slice(u.start, u.end).trim() === "" && !u.barrier;
    if (wsOnly) {
      const prev = merged[merged.length - 1];
      if (prev) prev.end = u.end;
      else carry = carry ?? u.start;
      continue;
    }
    merged.push(carry === null ? { ...u } : { ...u, start: carry });
    carry = null;
  }
  if (merged.length === 0) return [{ start: 0, end: text.length, kind: "paragraph", barrier: false }];
  return merged;
}

interface Level {
  cuts: (
    text: string,
    s: number,
    e: number,
    max: number,
    est: (t: string) => number,
  ) => number[];
  kind: (unitText: string) => BoundaryKind;
}

const hasQuote = (t: string) => /[「『（]/.test(t);

const LEVELS: Level[] = [
  { cuts: (t, s, e) => sentenceCuts(t, s, e, true), kind: () => "sentence" },
  { cuts: (t, s, e) => sentenceCuts(t, s, e, false), kind: (u) => (hasQuote(u) ? "quote" : "sentence") },
  { cuts: lineCuts, kind: () => "line" },
  { cuts: whitespaceCuts, kind: () => "whitespace" },
  { cuts: hardCuts, kind: () => "hard" },
];

/** Returns cumulative end offsets (last === e). Quote-aware mode never cuts inside 「」『』（） pairs. */
function sentenceCuts(text: string, s: number, e: number, aware: boolean): number[] {
  const cuts: number[] = [];
  let depth = 0;
  let i = s;
  const push = (at: number) => {
    if (at > (cuts[cuts.length - 1] ?? s)) cuts.push(at);
  };
  while (i < e) {
    const c = text[i]!;
    if (aware && QUOTE_OPEN.has(c)) {
      depth++;
      i++;
      continue;
    }
    if (aware && QUOTE_CLOSE.has(c) && depth > 0) {
      depth--;
      if (depth === 0) {
        // A quote that ends a sentence-like unit: cut after it when what follows starts afresh.
        let k = i - 1;
        while (k >= s && TRAILING.has(text[k]!)) k--;
        let j = i + 1;
        while (j < e && TRAILING.has(text[j]!)) j++;
        const next = text[j];
        const endsSentence = (k >= s && TERMINATORS.has(text[k]!)) || next === "\n";
        if (endsSentence && (j >= e || QUOTE_OPEN.has(next!) || isWs(next))) {
          j = skipWs(text, j, e);
          push(j);
          i = j;
          continue;
        }
      }
      i++;
      continue;
    }
    if (TERMINATORS.has(c) && (!aware || depth === 0)) {
      let j = i + 1;
      while (j < e && (TERMINATORS.has(text[j]!) || TRAILING.has(text[j]!))) j++;
      if (c === "." && !(j >= e || isWs(text[j]))) {
        i++; // decimal point, abbreviation, etc.
        continue;
      }
      j = skipWs(text, j, e);
      push(j);
      i = j;
      continue;
    }
    i++;
  }
  push(e);
  return cuts;
}

function lineCuts(text: string, s: number, e: number): number[] {
  const cuts: number[] = [];
  for (let i = s; i < e; i++) if (text[i] === "\n") cuts.push(i + 1);
  if (cuts[cuts.length - 1] !== e) cuts.push(e);
  return cuts;
}

function whitespaceCuts(text: string, s: number, e: number): number[] {
  const cuts: number[] = [];
  for (let i = s; i < e - 1; i++) if (isWs(text[i]) && !isWs(text[i + 1])) cuts.push(i + 1);
  cuts.push(e);
  return cuts;
}

/** Splits on Unicode scalar boundaries: never inside a surrogate pair. */
function hardCuts(
  text: string,
  s: number,
  e: number,
  max: number,
  est: (t: string) => number,
): number[] {
  const pos: number[] = [];
  for (let i = s; i < e; ) {
    pos.push(i);
    i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  }
  pos.push(e);
  const n = pos.length - 1;
  const cuts: number[] = [];
  let from = 0;
  while (from < n) {
    let lo = from + 1; // always make progress
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (est(text.slice(pos[from]!, pos[mid]!)) <= max) lo = mid;
      else hi = mid - 1;
    }
    cuts.push(pos[lo]!);
    from = lo;
  }
  return cuts;
}
