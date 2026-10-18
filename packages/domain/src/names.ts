import type {
  WordToken,
} from "./steps.js";

/**
 * Japanese person names from a names dictionary (JMnedict): which surnames and given names there are, and how each can be read. The
 * general dictionary the app splits text with knows few names, so it cuts 水瀬灯 into the common nouns 水 and 瀬 and a suffix; this finds
 * it as the surname 水瀬 and the given name 灯, read Minase Akari.
 *
 * Almost any two kanji are some surname and some given name in a list of names this long (今日 would be 今 and 日), so a name is only
 * found where the general dictionary did not know the words as one: see {@link nameRuns}. Tried on 45 names of fiction, it found 34 (31
 * before) and read 26 of them right (23 before); in the 64 paragraphs of the eval story, it took nothing for a name that was not one.
 */

/** How a name can be read (in katakana), and as what: s surname, g given name, f female, m male, p full name, c a character of fiction. */
export interface NameReading {
  reading: string;
  kinds: string;
}

export interface NameTable {
  names: ReadonlyMap<string, readonly NameReading[]>;
  /** How many names share each reading as a surname, and as a given name: how usual a reading is, the list having no counts of its own. */
  spread: ReadonlyMap<string, { s: number; g: number }>;
}

type Role = "s" | "g";
const fits = (kinds: string, role: Role): boolean => (role === "s" ? kinds.includes("s") : /[gfm]/.test(kinds));

/** The table from its text: one name a line, a tab, then its readings, each `reading:kinds`, separated by spaces. */
export function parseNameTable(text: string): NameTable {
  const names = new Map<string, NameReading[]>();
  const spread = new Map<string, { s: number; g: number }>();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const readings = line
      .slice(tab + 1)
      .split(" ")
      .map((x) => {
        const [reading, kinds] = x.split(":");
        return { reading: reading ?? "", kinds: kinds ?? "" };
      })
      .filter((r) => r.reading !== "");
    names.set(line.slice(0, tab), readings);
    for (const r of readings) {
      const n = spread.get(r.reading) ?? { s: 0, g: 0 };
      if (fits(r.kinds, "s")) n.s++;
      if (fits(r.kinds, "g")) n.g++;
      spread.set(r.reading, n);
    }
  }
  return { names, spread };
}

/** Endings of the names of shops, halls, temples and places (白鷺堂, the bookshop Shirasagi-dō): such a name is not a person's. */
const PLACE_ENDINGS = /(?:堂|館|屋|亭|寺|院|店|社|城|村|町|市|県|駅|島|山|川|橋|園|荘|宮|殿|閣|庵)$/;

/**
 * Where a name is a surname followed by a given name, by the table: the longest surname first (the given name taking the rest). For a
 * name alone (凛), null.
 */
export function splitName(name: string, table: NameTable): [string, string] | null {
  if (PLACE_ENDINGS.test(name)) return null;
  for (let i = name.length - 1; i >= 1; i--) {
    const surname = name.slice(0, i);
    const given = name.slice(i);
    if ((table.names.get(surname) ?? []).some((r) => fits(r.kinds, "s")) && (table.names.get(given) ?? []).some((r) => fits(r.kinds, "g"))) return [surname, given];
  }
  return null;
}

/**
 * The person names in a run of words as the general dictionary split them: kanji nouns that are not numbers, counters, pronouns or
 * words that need another, two or more of them in a row (a name the general dictionary knows as one word is its own business, and a
 * word it knows, 今日 or 魔法, is not a name), splitting at a word into a surname of two characters or more and a given name, both in
 * the table, not ending like a shop or a place.
 */
export function nameRuns(tokens: readonly WordToken[], table: NameTable): { name: string; surname: string; given: string }[] {
  const out: { name: string; surname: string; given: string }[] = [];
  let words: string[] = [];
  const flush = () => {
    if (words.length >= 2 && !PLACE_ENDINGS.test(words.join(""))) {
      for (let i = words.length - 1; i >= 1; i--) {
        const surname = words.slice(0, i).join("");
        const given = words.slice(i).join("");
        if (surname.length < 2) continue;
        if ((table.names.get(surname) ?? []).some((r) => fits(r.kinds, "s")) && (table.names.get(given) ?? []).some((r) => fits(r.kinds, "g"))) {
          out.push({ name: surname + given, surname, given });
          break;
        }
      }
    }
    words = [];
  };
  for (const t of tokens) {
    const [pos, sub, sub2] = t.details;
    const plain = pos === "名詞" && !["数", "代名詞", "副詞可能", "非自立"].includes(sub ?? "") && !(sub === "接尾" && sub2 === "助数詞");
    if (plain && /^[\p{Script=Han}々ヶノ]+$/u.test(t.surface)) words.push(t.surface);
    else flush();
  }
  flush();
  return out;
}

/**
 * How a surname, or a given name, is most likely read: of the readings the table gives it as such, the one the general dictionary reads it
 * as (`usual`, when it knows the word), else the one most names share; null when the table does not have it as such. Tried on 45 names,
 * this was the best of six ways (the list's own order got 4 of them right).
 */
export function pickReading(part: string, role: Role, table: NameTable, usual: string | null): string | null {
  const readings = (table.names.get(part) ?? []).filter((r) => fits(r.kinds, role));
  if (readings.length === 0) return null;
  const known = usual ? readings.find((r) => r.reading === usual) : undefined;
  if (known) return known.reading;
  const share = (r: NameReading) => table.spread.get(r.reading)?.[role] ?? 0;
  return [...readings].sort((a, b) => share(b) - share(a))[0]!.reading;
}
