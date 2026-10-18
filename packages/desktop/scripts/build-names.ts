/**
 * Builds the table of Japanese person names the app reads names with, from JMnedict (the Japanese names dictionary of the JMdict
 * project, © EDRDG, CC BY-SA 4.0: https://www.edrdg.org/edrdg/licence.html).
 *
 *   curl -O http://ftp.edrdg.org/pub/Nihongo/JMnedict.xml.gz && gunzip JMnedict.xml.gz
 *   pnpm --filter @ltw/desktop exec tsx scripts/build-names.ts /path/to/JMnedict.xml
 *
 * Only names written with a kanji, and only of people (surnames, given names, full names, fictional characters): places, stations and
 * companies are left out. Each line of data/names.tsv.gz is a name, a tab, and its readings in katakana, each with its kinds:
 *   水瀬	ミズセ:fs ミナセ:fs
 * s surname, g given name, f female given name, m male given name, p full name of a person, c a character of fiction or myth.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const KINDS: Record<string, string> = { surname: "s", given: "g", fem: "f", masc: "m", person: "p", char: "c", fict: "c", creat: "c", dei: "c", myth: "c", leg: "c" };
const toKatakana = (s: string): string => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

const input = process.argv[2];
if (!input) throw new Error("Give the path to JMnedict.xml.");
const xml = readFileSync(input, "utf8");
const names = new Map<string, Map<string, Set<string>>>();
let entries = 0;
for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
  const e = m[1]!;
  const kinds = [...e.matchAll(/<name_type>&([a-z]+);<\/name_type>/g)].map((x) => KINDS[x[1]!]).filter((k): k is string => k !== undefined);
  if (kinds.length === 0) continue;
  const kebs = [...e.matchAll(/<keb>([^<]*)<\/keb>/g)].map((x) => x[1]!).filter((k) => /\p{Script=Han}/u.test(k));
  const rebs = [...e.matchAll(/<reb>([^<]*)<\/reb>/g)].map((x) => toKatakana(x[1]!));
  if (kebs.length === 0 || rebs.length === 0) continue;
  entries++;
  for (const k of kebs) {
    const byReading = names.get(k) ?? new Map<string, Set<string>>();
    for (const r of rebs) {
      const set = byReading.get(r) ?? new Set<string>();
      for (const kind of kinds) set.add(kind);
      byReading.set(r, set);
    }
    names.set(k, byReading);
  }
}
const lines = [...names].map(([k, byReading]) => `${k}\t${[...byReading].map(([r, kinds]) => `${r}:${[...kinds].sort().join("")}`).join(" ")}`);
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../data/names.tsv.gz");
mkdirSync(dirname(out), { recursive: true });
const data = gzipSync(lines.join("\n") + "\n", { level: 9 });
writeFileSync(out, data);
console.log(`${entries} entries, ${names.size} names, ${(data.length / 1e6).toFixed(1)} MB gzipped -> ${out}`);
