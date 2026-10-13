import type { Backend, BlockSize, DemoOptions, GlossaryEntry, ModelSetting, PromptPreset, RunView, StartJobInput } from "@ltw/domain";
import { allPrompts, runLabel } from "@ltw/domain/pure";

/** Everything the user has chosen: the working text and how to translate it. */
export interface SetupState {
  /** The text in the editor. It becomes a version of the project when Run is pressed. */
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  backend: Backend;
  models: ModelSetting[];
  glossary: GlossaryEntry[];
  /** The user's own translation styles. */
  prompts: PromptPreset[];
  blockSize: BlockSize;
  demo: DemoOptions;
}

export const newModel = (name: string, promptId = "standard"): ModelSetting => ({
  name,
  contextLimit: 4096,
  maxOutputTokens: 1536,
  temperature: 0.2,
  promptId,
  useGlossary: true,
});

export const initialSetup: SetupState = {
  text: "",
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  backend: "provider",
  models: [],
  glossary: [],
  prompts: [],
  blockSize: "normal",
  demo: { speed: "normal", smallBlocks: true, failBlockOnce: null, firstModelUnloaded: false },
};

export const toStartInput = (s: SetupState, rerun: string[] = []): StartJobInput => ({
  text: s.text,
  sourceLanguage: s.sourceLanguage,
  targetLanguage: s.targetLanguage,
  backend: s.backend,
  models: s.models,
  glossary: s.glossary,
  prompts: s.prompts,
  blockSize: s.blockSize,
  rerun,
  demo: s.demo,
});

export const labelOf = (m: ModelSetting, s: Pick<SetupState, "prompts" | "glossary">): string => runLabel(m, allPrompts(s.prompts), s.glossary.length);

/** The model list a project's runs imply. */
export const modelsFromRuns = (runs: RunView[]): ModelSetting[] =>
  runs.map((r) => ({
    name: r.settings.modelId,
    contextLimit: r.settings.contextLimit,
    maxOutputTokens: r.settings.maxOutputTokens,
    temperature: r.settings.temperature,
    promptId: r.settings.promptId,
    useGlossary: r.settings.useGlossary,
  }));

/** Adds a configuration for every run that does not have one yet (for example after restoring a removed model). */
export function mergeRunModels(s: SetupState, runs: RunView[]): ModelSetting[] {
  const have = new Set(s.models.map((m) => labelOf(m, s)));
  const extra = modelsFromRuns(runs).filter((m) => !have.has(labelOf(m, s)));
  return extra.length > 0 ? [...s.models, ...extra] : s.models;
}

const KEY = "ltw.setup.v2";

/** Remembers the working text, languages, models, glossary and your own styles between launches. Failure is harmless. */
export function loadSetup(): SetupState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SetupState>;
      return {
        ...initialSetup,
        ...(typeof s.text === "string" ? { text: s.text } : {}),
        ...(typeof s.sourceLanguage === "string" ? { sourceLanguage: s.sourceLanguage } : {}),
        ...(typeof s.targetLanguage === "string" ? { targetLanguage: s.targetLanguage } : {}),
        ...(s.backend === "practice" || s.backend === "provider" ? { backend: s.backend } : {}),
        ...(Array.isArray(s.models) ? { models: s.models.map((m) => ({ ...newModel(String(m.name ?? "")), ...m })) } : {}),
        ...(Array.isArray(s.glossary) ? { glossary: s.glossary } : {}),
        ...(Array.isArray(s.prompts) ? { prompts: s.prompts } : {}),
        ...(s.blockSize === "small" || s.blockSize === "normal" || s.blockSize === "large" ? { blockSize: s.blockSize } : {}),
        ...(s.demo && typeof s.demo === "object" ? { demo: { ...initialSetup.demo, ...s.demo } } : {}),
      };
    }
  } catch {
    /* nothing saved yet */
  }
  return initialSetup;
}

export function saveSetup(s: SetupState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: fine */
  }
}
