import type { Backend, BlockSize, ModelSetting, ProjectSettings, PromptPreset } from "@ltw/domain";

/** Everything the user has chosen: the working text and how to translate it. */
export interface SetupState {
  /** The text in the editor, which belongs to the open document. */
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  backend: Backend;
  models: ModelSetting[];
  /** The user's own translation styles. */
  prompts: PromptPreset[];
  blockSize: BlockSize;
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
};

/** The choices that belong to the project (the same fields, in the same order, as the project saves them). */
export const settingsOf = (s: SetupState): ProjectSettings => ({
  sourceLanguage: s.sourceLanguage,
  targetLanguage: s.targetLanguage,
  blockSize: s.blockSize,
  models: s.models,
  glossary: [],
  prompts: s.prompts,
});

/** Takes the project's choices over the window's own. The translator choice and practice controls stay as they are, and so do the remembered models and styles when the project has none. */
export const withSettings = (s: SetupState, p: ProjectSettings): SetupState => {
  const { glossary: _glossary, notes: _notes, knowledge: _knowledge, ...rest } = p;
  // A project that has no models of its own (a new one, or one saved before any was added) keeps the ones remembered from last time.
  const models = p.models.length > 0 ? p.models.map((m) => ({ ...newModel(m.name), ...m })) : s.models;
  const prompts = p.prompts.length > 0 ? p.prompts : s.prompts;
  return { ...s, ...rest, models, prompts };
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
