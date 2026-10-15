/**
 * Translation styles. A style is guidance for the tone and wording of the translation, sent with every paragraph; the task itself
 * (translate this paragraph into the empty place) is built in. `{sourceLanguage}` and `{targetLanguage}` are filled in.
 */
export interface PromptPreset {
  id: string;
  name: string;
  /** One line shown in the picker. */
  description: string;
  /** Instructions. `{sourceLanguage}` and `{targetLanguage}` are filled in. */
  template: string;
}

export const STANDARD_PROMPT_ID = "standard";

export const BUILTIN_PROMPTS: readonly PromptPreset[] = [
  {
    id: STANDARD_PROMPT_ID,
    name: "Standard",
    description: "The default instructions: faithful, no commentary.",
    template: `Translate from {sourceLanguage} into {targetLanguage} faithfully and completely: keep the meaning, speaker intent, names and tone.
Do not omit or sanitize source content, and do not invent missing context.`,
  },
  {
    id: "literary",
    name: "Natural, literary",
    description: "Fluent prose that reads as if written in the target language.",
    template: `You are a skilled literary translator working from {sourceLanguage} into {targetLanguage}.
Write natural, fluent prose that reads as if it had been written in {targetLanguage}, while keeping the meaning, tone, each speaker's voice and the subtext.
Convey what is implied (for example resignation, hesitation, irony or affection) instead of translating word for word.
Keep the paragraph structure. Use the glossary for names and terms.`,
  },
  {
    id: "literal",
    name: "Close to the source",
    description: "Stays near the source wording and structure.",
    template: `Translate from {sourceLanguage} into {targetLanguage} staying as close to the source as natural {targetLanguage} allows.
Keep the source's sentence order and structure where possible, keep repetitions and sentence fragments, and do not smooth over or reinterpret anything.
Keep the paragraph structure. Use the glossary for names and terms.`,
  },
  {
    id: "nuance",
    name: "Nuance-aware",
    description: "Pays attention to particles, hedges, politeness and tone.",
    template: `You translate from {sourceLanguage} into {targetLanguage}.
Pay close attention to small words that carry attitude: sentence-final particles, hedges, fillers, confirmations and softeners, the level of politeness, and who is speaking to whom. Express that attitude in natural {targetLanguage} wording (tone, rhythm, contractions, short interjections) instead of dropping it or translating it literally.
Keep names, honorific relationships and the paragraph structure. Use the glossary for names and terms.`,
  },
];

const placeholders = (text: string, source: string, target: string): string =>
  text.replaceAll("{sourceLanguage}", () => source).replaceAll("{targetLanguage}", () => target);

export function renderPrompt(prompt: Pick<PromptPreset, "template">, sourceLanguage: string, targetLanguage: string): string {
  return placeholders(prompt.template, sourceLanguage, targetLanguage);
}

export const MAX_PROMPT_CHARS = 4000;

/** Why a custom style cannot be used, or null. */
export function validatePrompt(p: Pick<PromptPreset, "name" | "template">): string | null {
  if (p.name.trim() === "") return "Give the prompt a name.";
  if (p.name.length > 80) return "The prompt name is too long (80 characters at most).";
  if (p.template.trim() === "") return `The prompt "${p.name}" has no instructions.`;
  if (p.template.length > MAX_PROMPT_CHARS) return `The prompt "${p.name}" is too long (${MAX_PROMPT_CHARS} characters at most).`;
  return null;
}

/** Built-in styles first, then the user's own. A custom style cannot shadow a built-in id. */
export function allPrompts(custom: readonly PromptPreset[]): PromptPreset[] {
  const builtinIds = new Set(BUILTIN_PROMPTS.map((p) => p.id));
  return [...BUILTIN_PROMPTS, ...custom.filter((c) => !builtinIds.has(c.id))];
}

export const STANDARD_PROMPT: PromptPreset = BUILTIN_PROMPTS[0]!;

