/** Spec 01 "Defaults and limits" and 04 "Chunking and budgets". */
export const DEFAULTS = {
  targetBlockTokens: 600,
  maxBlockTokens: 900,
  outputReserveTokens: 1536,
  contextLimitTokens: 4096,
  temperature: 0.2,
  /** Each of source tail and translation tail. */
  contextTailTokens: 256,
  /** Fixed per-request message framing, deliberately generous (estimate, not measured). */
  messageOverheadTokens: 64,
  safetyMarginMinTokens: 256,
  safetyMarginFraction: 0.1,
  maxSourceBytes: 1024 * 1024,
  maxBlocks: 2000,
  maxRunsPerRevision: 8,
} as const;

/** The block sizes the user can choose. The model's own limits can still make blocks smaller. */
export const BLOCK_SIZES = {
  small: { targetTokens: 300, maxTokens: 450 },
  normal: { targetTokens: 600, maxTokens: 900 },
  large: { targetTokens: 1200, maxTokens: 1800 },
} as const;
export type BlockSize = keyof typeof BLOCK_SIZES;
