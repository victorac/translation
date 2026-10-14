import type { Gender, GuidedLine, GuidedName, Interpretation, NameKind } from "./guided.js";

/**
 * What was read from a block, written as a small text the user edits like any other file:
 *
 *     told as: ぼく
 *     narrator: 山田太郎
 *
 *     ## Names
 *     山田太郎 = Taro Yamada | person | he | aliases: 山田
 *     桜台学園 = | organization        # reads: sakuradai gakuen
 *
 *     ## Lines
 *     1. 「山田、お待たせいたし…」 : 花子
 *     2. 「遅かったな、花子」 : ?
 *
 * Everything after a # on a line is a comment. The text of the lines cannot be changed here, only who says them.
 */

export interface TextProblem {
  line: number;
  message: string;
}

const KIND_WORD: Record<NameKind, string> = { character: "person", family: "family", place: "place", organization: "organization", term: "other" };
const WORD_KIND: Record<string, NameKind> = { person: "character", character: "character", family: "family", place: "place", organization: "organization", other: "term", term: "term" };
const GENDER_WORD: Record<string, Gender> = { he: "male", she: "female", male: "male", female: "female" };

const shorten = (text: string, n: number): string => (Array.from(text).length > n ? `${Array.from(text).slice(0, n).join("")}…` : text);

export function interpretationToText(interp: Interpretation): string {
  const out: string[] = [];
  if (interp.narratorWord) {
    out.push(`told as: ${interp.narratorWord}`);
    out.push(`narrator: ${interp.narrator ?? ""}`);
    out.push("");
  }
  out.push("## Names");
  for (const n of interp.names) {
    const fields = [KIND_WORD[n.kind]];
    if (n.kind === "character" && n.gender) fields.push(n.gender === "female" ? "she" : "he");
    if (n.aliases.length > 0) fields.push(`aliases: ${n.aliases.join(", ")}`);
    const hint = n.reading ? `        # reads: ${n.reading}` : n.known ? "        # in the glossary" : "";
    out.push(`${n.source} =${n.english ? ` ${n.english}` : ""} | ${fields.join(" | ")}${hint}`);
  }
  out.push("");
  out.push("## Lines");
  interp.lines.forEach((l, i) => out.push(`${i + 1}. ${shorten(l.text, 24)} : ${l.speaker ?? "?"}`));
  return `${out.join("\n")}\n`;
}

/** Reads the text back into what it describes, with what is wrong with it. The lines' own text always comes from `original`. */
export function interpretationFromText(text: string, original: Interpretation): { interpretation: Interpretation; problems: TextProblem[] } {
  const problems: TextProblem[] = [];
  const names: GuidedName[] = [];
  const lines: GuidedLine[] = original.lines.map((l) => ({ text: l.text, speaker: null }));
  let narrator: string | null = null;
  let narratorLine = 0;
  let section: "head" | "names" | "lines" = "head";
  const seen = new Set<string>();
  const lineSpeakers: { n: number; at: number; who: string }[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const at = i + 1;
    const body = raw.replace(/\s+#.*$/, "").trim();
    if (body === "" || body.startsWith("#") && !body.startsWith("##")) return;
    if (/^##\s*names\s*$/i.test(body)) return void (section = "names");
    if (/^##\s*lines\s*$/i.test(body)) return void (section = "lines");
    if (body.startsWith("##")) return void problems.push({ line: at, message: "Unknown heading. Use ## Names and ## Lines." });

    if (section === "head") {
      const m = /^(told as|narrator)\s*:\s*(.*)$/i.exec(body);
      if (!m) return void problems.push({ line: at, message: "Expected \"narrator: name\" here, or a ## heading." });
      if (m[1]!.toLowerCase() === "narrator") {
        narrator = m[2]!.trim() === "" ? null : m[2]!.trim();
        narratorLine = at;
      }
      return;
    }

    if (section === "names") {
      const eq = body.indexOf("=");
      if (eq <= 0) return void problems.push({ line: at, message: "Write a name like: 花子 = Hanako | person | she" });
      const source = body.slice(0, eq).trim();
      const [english = "", ...fields] = body
        .slice(eq + 1)
        .split("|")
        .map((f) => f.trim());
      if (seen.has(source)) return void problems.push({ line: at, message: `「${source}」 is listed twice.` });
      seen.add(source);
      let kind: NameKind = "character";
      let gender: Gender | null = null;
      let aliases: string[] = [];
      for (const f of fields) {
        if (f === "") continue;
        const lower = f.toLowerCase();
        if (lower.startsWith("aliases:")) aliases = f.slice(8).split(/[,、]/).map((a) => a.trim()).filter((a) => a !== "" && a !== source);
        else if (WORD_KIND[lower]) kind = WORD_KIND[lower]!;
        else if (GENDER_WORD[lower]) gender = GENDER_WORD[lower]!;
        else problems.push({ line: at, message: `Not understood: "${f}". Use person, family, place, organization or other; he or she; or aliases: a, b.` });
      }
      const before = original.names.find((n) => n.source === source);
      names.push({ source, english, kind, aliases, reading: before?.reading ?? "", known: before?.known ?? false, gender: kind === "character" ? gender : null });
      return;
    }

    // section === "lines"
    const colon = body.lastIndexOf(" : ");
    const m = /^(\d+)\./.exec(body);
    if (!m || colon < 0) return void problems.push({ line: at, message: "Write a line like: 1. 「…」 : name" });
    const n = Number(m[1]);
    if (n < 1 || n > lines.length) return void problems.push({ line: at, message: `There is no line ${n}.` });
    lineSpeakers.push({ n: n - 1, at, who: body.slice(colon + 3).trim() });
  });

  /** A name as the person wrote it: the original name, its English form, or one of its aliases. */
  const resolve = (who: string): string | null => {
    const lower = who.toLowerCase();
    return names.find((n) => n.source === who || n.english.toLowerCase() === lower || n.aliases.includes(who))?.source ?? null;
  };
  if (narrator !== null) {
    const found = resolve(narrator);
    if (found === null) {
      problems.push({ line: narratorLine, message: `「${narrator}」 is not in the names below.` });
      narrator = null;
    } else narrator = found;
  }
  for (const s of lineSpeakers) {
    if (s.who === "" || s.who === "?") continue;
    const found = resolve(s.who);
    if (found === null) problems.push({ line: s.at, message: `「${s.who}」 is not in the names above.` });
    else lines[s.n]!.speaker = found;
  }
  return { interpretation: { names, narrator, narratorWord: original.narratorWord, lines }, problems };
}
