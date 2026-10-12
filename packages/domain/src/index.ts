export { normalizeSource } from "./normalize.js";
export { estimateTokens } from "./tokens.js";
export { DEFAULTS } from "./defaults.js";
export {
  CHUNKER_VERSION,
  chunkSource,
  defaultIsChapterSeparator,
  type BoundaryKind,
  type ChunkBlock,
  type ChunkOptions,
} from "./chunker.js";
export {
  RevisionError,
  blockText,
  createRevision,
  verifyRevision,
  type Block,
  type ChunkSettings,
  type CreateRevisionInput,
  type RevisionDeps,
  type RevisionProblem,
  type SourceRevision,
} from "./revision.js";
export {
  contextAllowance,
  modelBudget,
  planChunking,
  preflightRevision,
  safetyMargin,
  type BudgetIssue,
  type ChunkPlan,
  type ModelBudget,
  type ModelBudgetInput,
} from "./budget.js";
