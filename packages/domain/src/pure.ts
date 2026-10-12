// The parts of the shared package that need nothing from Node, so the app window can use them directly.
export * from "./prompts.js";
export * from "./glossary.js";
export * from "./split.js";
export { BLOCK_SIZES, type BlockSize } from "./defaults.js";
