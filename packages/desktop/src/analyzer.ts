import {
  readFile,
} from "node:fs/promises";
import {
  createRequire,
} from "node:module";
import {
  gunzipSync,
} from "node:zlib";
import {
  mergeCandidates,
  nameRuns,
  parseNameTable,
  patternCandidates,
  pickReading,
  properNounRuns,
  splitName,
  type NameTable,
  type WordToken,
} from "@ltw/domain";

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

let loadingNames: Promise<NameTable | null> | null = null;

/**
 * Loads the table of Japanese person names (from JMnedict, data/names.tsv.gz, built by scripts/build-names.ts) the first time it is
 * needed. It is found next to the code, run from its source or built. Without it, names are found and read as before.
 */
function loadNames(): Promise<NameTable | null> {
  loadingNames ??= (async () => {
    for (const at of ["../data/names.tsv.gz", "../../data/names.tsv.gz"]) {
      try {
        return parseNameTable(gunzipSync(await readFile(new URL(at, import.meta.url))).toString("utf8"));
      } catch {
        // not there: the next place
      }
    }
    return null;
  })();
  return loadingNames;
}

/**
 * Candidate names in a passage, found without a model: proper nouns the analyzer knows, names that give themselves away, and a surname
 * followed by a given name of the names table that the analyzer cut into common words (水瀬灯).
 */
export async function findCandidateNames(text: string): Promise<string[]> {
  const [tokenizer, names] = await Promise.all([load(), loadNames()]);
  const tokens = tokenizer ? (tokenizer.tokenize(text) as WordToken[]) : [];
  const analyzed = properNounRuns(tokens);
  const people = names ? nameRuns(tokens, names).map((n) => n.name) : [];
  return mergeCandidates(text, analyzed, people, patternCandidates(text));
}

/**
 * The readings (in katakana) of the words of each name. A surname and a given name of the names table are read as names are (水瀬灯,
 * Minase Akari, not Mizu Se Tō); a name alone that the table has as a given name, or else as a surname, too. Otherwise, the analyzer's
 * readings of its words, when it knows every one of them.
 */
export async function readNames(names: readonly string[]): Promise<Record<string, string[]>> {
  const [tokenizer, table] = await Promise.all([load(), loadNames()]);
  const out: Record<string, string[]> = {};
  if (!tokenizer) return out;
  // How the analyzer reads a word it knows as one word (the reading, not the pronunciation, which writes long vowels with ー).
  const usual = (part: string): string | null => {
    const t = tokenizer.tokenize(part);
    return t.length === 1 && t[0]!.details.length >= 8 ? t[0]!.details[7]! : null;
  };
  for (const name of names) {
    const split = table ? splitName(name, table) : null;
    if (table && split && split[0].length >= 2) {
      const surname = pickReading(split[0], "s", table, usual(split[0]));
      const given = pickReading(split[1], "g", table, usual(split[1]));
      if (surname && given) {
        out[name] = [surname, given];
        continue;
      }
    }
    if (table && !split && /^\p{Script=Han}{1,3}$/u.test(name)) {
      const alone = pickReading(name, "g", table, usual(name)) ?? pickReading(name, "s", table, usual(name));
      if (alone) {
        out[name] = [alone];
        continue;
      }
    }
    const tokens = tokenizer.tokenize(name);
    // The words of a name the dictionary does not know have no reading in it.
    const readings = tokens.map((t) => (t.details.length >= 9 && t.details[0] === "名詞" ? t.details[8]! : ""));
    if (tokens.length > 0 && readings.every((r) => /^[\u30A0-\u30FF]+$/.test(r))) out[name] = readings;
  }
  return out;
}
