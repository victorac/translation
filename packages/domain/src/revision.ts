import { chunkSource, CHUNKER_VERSION, type BoundaryKind, type ChunkOptions } from "./chunker.js";
import { DEFAULTS } from "./defaults.js";
import { normalizeSource } from "./normalize.js";
import { newId, sha256Hex } from "./platform.js";

export interface Block {
  id: string;
  revisionId: string;
  index: number;
  startOffset: number;
  endOffset: number;
  textHash: string;
  boundaryKind: BoundaryKind;
  estimatedTokens: number;
}

export interface ChunkSettings {
  targetTokens: number;
  maxTokens: number;
  /** Which estimator produced `estimatedTokens`; MVP is the cautious scalar count. */
  estimator: "scalar-v1";
}

export interface SourceRevision {
  id: string;
  parentId?: string;
  /** Normalized per amendment A1 (line endings are `\n`). */
  exactText: string;
  sha256: string;
  sourceLanguage: string;
  targetLanguage: string;
  chunkerVersion: string;
  chunkSettings: ChunkSettings;
  blocks: Block[];
}

export type RevisionErrorCode = "empty" | "too_large" | "too_many_blocks" | "invalid_options";

export class RevisionError extends Error {
  constructor(
    readonly code: RevisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RevisionError";
  }
}

export interface CreateRevisionInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  parentId?: string;
  targetTokens?: number;
  maxTokens?: number;
  isChapterSeparator?: ChunkOptions["isChapterSeparator"];
  maxSourceBytes?: number;
  maxBlocks?: number;
}

export interface RevisionDeps {
  newId?: () => string;
  sha256?: (text: string) => string;
}

/** Freezes a source snapshot: normalizes, enforces guardrails, chunks once, assigns IDs and hashes. */
export function createRevision(input: CreateRevisionInput, deps: RevisionDeps = {}): SourceRevision {
  const id_ = deps.newId ?? newId;
  const hash = deps.sha256 ?? sha256Hex;
  const maxBytes = input.maxSourceBytes ?? DEFAULTS.maxSourceBytes;
  const maxBlocks = input.maxBlocks ?? DEFAULTS.maxBlocks;

  const exactText = normalizeSource(input.text);
  if (exactText.trim() === "") throw new RevisionError("empty", "Source is empty or whitespace only.");
  const bytes = new TextEncoder().encode(exactText).length;
  if (bytes > maxBytes) {
    throw new RevisionError("too_large", `Source is ${bytes} bytes; the limit is ${maxBytes}.`);
  }

  const maxTokens = input.maxTokens ?? DEFAULTS.maxBlockTokens;
  const targetTokens = Math.min(input.targetTokens ?? DEFAULTS.targetBlockTokens, maxTokens);
  let chunks;
  try {
    chunks = chunkSource(exactText, {
      targetTokens,
      maxTokens,
      ...(input.isChapterSeparator ? { isChapterSeparator: input.isChapterSeparator } : {}),
    });
  } catch (e) {
    if (e instanceof RangeError) throw new RevisionError("invalid_options", e.message);
    throw e;
  }
  if (chunks.length > maxBlocks) {
    throw new RevisionError("too_many_blocks", `Source produced ${chunks.length} blocks; the limit is ${maxBlocks}.`);
  }

  const revisionId = id_();
  return {
    id: revisionId,
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    exactText,
    sha256: hash(exactText),
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    chunkerVersion: CHUNKER_VERSION,
    chunkSettings: { targetTokens, maxTokens, estimator: "scalar-v1" },
    blocks: chunks.map((c) => ({
      id: id_(),
      revisionId,
      index: c.index,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      textHash: hash(exactText.slice(c.startOffset, c.endOffset)),
      boundaryKind: c.boundaryKind,
      estimatedTokens: c.estimatedTokens,
    })),
  };
}

export const blockText = (rev: Pick<SourceRevision, "exactText">, b: Pick<Block, "startOffset" | "endOffset">): string =>
  rev.exactText.slice(b.startOffset, b.endOffset);

export interface RevisionProblem {
  code:
    | "text_not_normalized"
    | "hash_mismatch"
    | "block_gap"
    | "block_empty"
    | "block_index"
    | "block_revision"
    | "block_hash_mismatch"
    | "block_splits_surrogate"
    | "block_duplicate_id"
    | "incomplete_coverage";
  message: string;
  blockId?: string;
}

/**
 * Load-time validation (spec 03). Never repairs and never rechunks: it only reports,
 * so a damaged project is offered for backup recovery instead of silently changed.
 */
export function verifyRevision(rev: SourceRevision, hash: (t: string) => string = sha256Hex): RevisionProblem[] {
  const problems: RevisionProblem[] = [];
  const add = (p: RevisionProblem) => problems.push(p);
  const text = rev.exactText;

  if (text.includes("\r")) add({ code: "text_not_normalized", message: "Source contains carriage returns." });
  if (hash(text) !== rev.sha256) add({ code: "hash_mismatch", message: "Source hash does not match its text." });

  const seen = new Set<string>();
  let pos = 0;
  rev.blocks.forEach((b, i) => {
    const at = { blockId: b.id };
    if (seen.has(b.id)) add({ code: "block_duplicate_id", message: `Duplicate block id ${b.id}.`, ...at });
    seen.add(b.id);
    if (b.index !== i) add({ code: "block_index", message: `Block at position ${i} has index ${b.index}.`, ...at });
    if (b.revisionId !== rev.id) add({ code: "block_revision", message: "Block belongs to another revision.", ...at });
    if (b.startOffset !== pos) add({ code: "block_gap", message: `Block ${i} starts at ${b.startOffset}, expected ${pos}.`, ...at });
    if (!(b.endOffset > b.startOffset) || b.endOffset > text.length) {
      add({ code: "block_empty", message: `Block ${i} has invalid range.`, ...at });
    } else {
      if (hash(text.slice(b.startOffset, b.endOffset)) !== b.textHash) {
        add({ code: "block_hash_mismatch", message: `Block ${i} text does not match its hash.`, ...at });
      }
      if (i > 0) {
        const hi = text.charCodeAt(b.startOffset - 1);
        const lo = text.charCodeAt(b.startOffset);
        if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
          add({ code: "block_splits_surrogate", message: `Block ${i} starts inside a surrogate pair.`, ...at });
        }
      }
    }
    pos = b.endOffset;
  });
  if (pos !== text.length) add({ code: "incomplete_coverage", message: `Blocks cover ${pos} of ${text.length} code units.` });
  return problems;
}
