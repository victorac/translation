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
export * from "./state.js";
export {
  PROMPT_VERSION,
  SYSTEM_PROMPT_V1,
  buildPrompt,
  computeContext,
  configHash,
  contextHashFor,
  renderSystemPrompt,
  type BuiltPrompt,
  type RequestContext,
} from "./prompt.js";
export { newId, sha256Hex } from "./platform.js";
