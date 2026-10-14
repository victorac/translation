import type { Backend, BlockSize, DemoOptions, ModelSetting, ProjectSettings, PromptPreset, RunView, StartJobInput } from "@ltw/domain";
import { allPrompts, runLabel } from "@ltw/domain/pure";

/** Everything the user has chosen: the working text and how to translate it. */
export interface SetupState {
  /** The text in the editor. It becomes a version of the project when Run is pressed. */
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  backend: Backend;
  models: ModelSetting[];
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
  glossary: [], // the project's names, hints and notes are kept by the background process
  prompts: s.prompts,
  blockSize: s.blockSize,
  rerun,
  demo: s.demo,
});

export const labelOf = (m: ModelSetting, s: Pick<SetupState, "prompts">): string => runLabel(m, allPrompts(s.prompts));

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

/** The choices that belong to the project (the same fields, in the same order, as the project saves them). */
export const settingsOf = (s: SetupState): ProjectSettings => ({
  sourceLanguage: s.sourceLanguage,
  targetLanguage: s.targetLanguage,
  blockSize: s.blockSize,
  models: s.models,
  glossary: [],
  prompts: s.prompts,
});

/** Takes the project's choices over the window's own. The translator choice and practice controls stay as they are. */
export const withSettings = (s: SetupState, p: ProjectSettings): SetupState => {
  const { glossary: _glossary, notes: _notes, knowledge: _knowledge, ...rest } = p;
  return { ...s, ...rest, models: p.models.map((m) => ({ ...newModel(m.name), ...m })) };
};

const KEY = "ltw.setup.v3";

/**
 * Remembers languages, models, glossary and your own styles between launches, as the starting choices for a new project.
 * The text is not kept here: it belongs to the project's document. Failure is harmless.
 */
export function loadSetup(): SetupState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SetupState>;
      return {
        ...initialSetup,
        ...(typeof s.sourceLanguage === "string" ? { sourceLanguage: s.sourceLanguage } : {}),
        ...(typeof s.targetLanguage === "string" ? { targetLanguage: s.targetLanguage } : {}),
        ...(s.backend === "practice" || s.backend === "provider" ? { backend: s.backend } : {}),
        ...(Array.isArray(s.models) ? { models: s.models.map((m) => ({ ...newModel(String(m.name ?? "")), ...m })) } : {}),
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
    const { text: _text, ...rest } = s;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    /* storage unavailable: fine */
  }
}
