import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mergeCandidates, patternCandidates, properNounRuns, type WordToken } from "@ltw/domain";

interface Tokenizer {
  tokenize(text: string): { surface: string; details: string[]; byteStart: number; byteEnd: number }[];
}

let loading: Promise<Tokenizer | null> | null = null;

/**
 * Loads the Japanese word analyzer (Lindera with its built-in dictionary) the first time it is needed. It runs inside
 * the app, offline. If it cannot load, finding names falls back to patterns and the model alone.
 */
function load(): Promise<Tokenizer | null> {
  loading ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const lindera = (await import("lindera-wasm-ipadic")) as unknown as {
        default: (init: { module_or_path: Uint8Array }) => Promise<unknown>;
        TokenizerBuilder: new () => { setDictionary(uri: string): void; setMode(mode: string): void; build(): Tokenizer };
      };
      const wasm = await readFile(require.resolve("lindera-wasm-ipadic/lindera_wasm_ipadic_bg.wasm"));
      await lindera.default({ module_or_path: new Uint8Array(wasm) });
      const builder = new lindera.TokenizerBuilder();
      builder.setDictionary("embedded://ipadic");
      builder.setMode("normal");
      return builder.build();
    } catch {
      return null;
    }
  })();
  return loading;
}

/** Candidate names in a passage, found without a model: proper nouns the analyzer knows, plus names that give themselves away. */
export async function findCandidateNames(text: string): Promise<string[]> {
  const tokenizer = await load();
  const analyzed = tokenizer ? properNounRuns(tokenizer.tokenize(text) as WordToken[]) : [];
  return mergeCandidates(text, analyzed, patternCandidates(text));
}

/** The readings (in katakana) of the words of each name, when the analyzer knows every one of them. */
export async function readNames(names: readonly string[]): Promise<Record<string, string[]>> {
  const tokenizer = await load();
  const out: Record<string, string[]> = {};
  if (!tokenizer) return out;
  for (const name of names) {
    const tokens = tokenizer.tokenize(name);
    // The words of a name the dictionary does not know have no reading in it.
    const readings = tokens.map((t) => (t.details.length >= 9 && t.details[0] === "名詞" ? t.details[8]! : ""));
    if (tokens.length > 0 && readings.every((r) => /^[\u30A0-\u30FF]+$/.test(r))) out[name] = readings;
  }
  return out;
}
