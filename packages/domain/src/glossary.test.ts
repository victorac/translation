import { describe, expect, it } from "vitest";
import { checkTranslation, looksLikeEcho, normalizeGlossary, parseGlossaryText, relevantEntries, targetVariants } from "./glossary.js";
import { allPrompts, BUILTIN_PROMPTS, FRAMING, renderPrompt, renderSystemPrompt, snapshotPrompt, SYSTEM_PROMPT_V1, SYSTEM_PROMPT_V2, validatePrompt } from "./prompts.js";

describe("normalizeGlossary", () => {
  it("trims, drops empty rows and keeps the last entry for a repeated term", () => {
    const r = normalizeGlossary([
      { source: " 魔王 ", target: " Demon King " },
      { source: "", target: "" },
      { source: "勇者", target: "Hero", note: " the protagonist " },
      { source: "魔王", target: "Demon Lord" },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.entries).toEqual([{ source: "勇者", target: "Hero", note: "the protagonist" }, { source: "魔王", target: "Demon Lord" }]);
  });

  it("reports half-filled rows in plain words and leaves them out", () => {
    const r = normalizeGlossary([{ source: "魔王", target: "" }, { source: "", target: "x" }, { source: "ok", target: "fine" }]);
    expect(r.entries).toEqual([{ source: "ok", target: "fine" }]);
    expect(r.problems).toEqual(['Glossary row 1 ("魔王") has no translation.', "Glossary row 2 has a translation but no source term."]);
  });

  it("enforces limits", () => {
    expect(normalizeGlossary([{ source: "a".repeat(201), target: "b" }]).problems[0]).toMatch(/too long/);
    const many = Array.from({ length: 501 }, (_, i) => ({ source: `s${i}`, target: `t${i}` }));
    const r = normalizeGlossary(many);
    expect(r.entries).toHaveLength(500);
    expect(r.problems[0]).toMatch(/at most 500/);
  });
});

describe("parseGlossaryText", () => {
  it("reads the common ways of writing a pair, with notes and comments", () => {
    const r = parseGlossaryText("魔王 = Demon King\nアリス → Alice\n勇者 -> Hero # the protagonist\nさくら => Sakura\nA\tB\n# a comment\n\n");
    expect(r.entries).toEqual([
      { source: "魔王", target: "Demon King" },
      { source: "アリス", target: "Alice" },
      { source: "勇者", target: "Hero", note: "the protagonist" },
      { source: "さくら", target: "Sakura" },
      { source: "A", target: "B" },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("returns lines it could not read instead of guessing", () => {
    const r = parseGlossaryText("魔王 = Demon King\njust some words\n= nothing\nleft =");
    expect(r.entries).toHaveLength(1);
    expect(r.skipped).toEqual(["just some words", "= nothing", "left ="]);
  });

  it("keeps an equals sign inside the translation", () => {
    expect(parseGlossaryText("x = a = b").entries).toEqual([{ source: "x", target: "a = b" }]);
  });
});

describe("relevantEntries and variants", () => {
  const g = [{ source: "魔王", target: "Demon King" }, { source: "Alice", target: "アリス" }, { source: "勇者", target: "Hero" }];
  it("keeps only entries whose term appears, ignoring letter case", () => {
    expect(relevantEntries(g, "魔王が来た。", null).map((e) => e.source)).toEqual(["魔王"]);
    expect(relevantEntries(g, "あ", "ALICE said hi").map((e) => e.source)).toEqual(["Alice"]);
    expect(relevantEntries(g, "nothing")).toEqual([]);
  });
  it("lists accepted alternatives", () => {
    expect(targetVariants("Demon King | Demon Lord|")).toEqual(["Demon King", "Demon Lord"]);
  });
});

describe("checkTranslation", () => {
  const base = { source: "魔王は笑った。", targetLanguage: "English", glossary: [{ source: "魔王", target: "Demon King" }] };

  it("is quiet for a good translation, including a different case or plural", () => {
    expect(checkTranslation({ ...base, output: "The demon king laughed." })).toEqual([]);
    expect(checkTranslation({ ...base, output: "The Demon Kings laughed." })).toEqual([]);
  });

  it("flags a missing glossary term and names the expected wording", () => {
    const n = checkTranslation({ ...base, output: "The Dark Lord laughed." });
    expect(n).toEqual(['Glossary: "魔王" should be "Demon King", but that was not found.']);
  });

  it("accepts any listed alternative", () => {
    const g = [{ source: "魔王", target: "Demon King|Demon Lord" }];
    expect(checkTranslation({ ...base, glossary: g, output: "The Demon Lord laughed." })).toEqual([]);
    expect(checkTranslation({ ...base, glossary: g, output: "The Dark Lord laughed." })[0]).toContain("(or Demon Lord)");
  });

  it("does not check terms that are not in this block", () => {
    expect(checkTranslation({ ...base, source: "彼は笑った。", output: "He laughed." })).toEqual([]);
  });

  it("caps long lists of missing terms", () => {
    const glossary = Array.from({ length: 8 }, (_, i) => ({ source: `語${i}`, target: `word${i}` }));
    const n = checkTranslation({ source: glossary.map((g) => g.source).join(""), output: "nothing", glossary, targetLanguage: "English" });
    expect(n).toHaveLength(6);
    expect(n[5]).toMatch(/3 more/);
  });

  it("flags likely commentary, but not a translation that merely starts with 'Of course'", () => {
    const flagged = ["Here is the translation: He left.", "Sure! Here's your translation:\nHe left.", "Translation: He left.", "He left.\n\nNote: this is informal."];
    for (const output of flagged) expect(checkTranslation({ source: "彼は去った。", output, glossary: [], targetLanguage: "English" })[0]).toMatch(/commentary/);
    expect(checkTranslation({ source: "もちろん、そうだよ", output: "Of course, that's how it is.", glossary: [], targetLanguage: "English" })).toEqual([]);
  });

  it("flags untranslated or copied text, unless the target language is itself CJK", () => {
    const src = "これは日本語の文章です。まだ翻訳されていません。";
    expect(checkTranslation({ source: src, output: src, glossary: [], targetLanguage: "English" })[0]).toMatch(/identical/);
    expect(checkTranslation({ source: src, output: "This is 日本語の文章です。まだ翻訳されていません。", glossary: [], targetLanguage: "English" })[0]).toMatch(/source script/);
    expect(checkTranslation({ source: "Hello there, how are you today?", output: "こんにちは、お元気ですか？今日はどうですか", glossary: [], targetLanguage: "Japanese" })).toEqual([]);
  });
});

describe("prompt styles", () => {
  it("the standard style is the spec's original prompt plus one line against repeating the request", () => {
    expect(BUILTIN_PROMPTS[0]).toMatchObject({ id: "standard", template: SYSTEM_PROMPT_V2, appendFraming: false });
    expect(SYSTEM_PROMPT_V2.startsWith(SYSTEM_PROMPT_V1)).toBe(true);
    expect(SYSTEM_PROMPT_V2).toMatch(/Do not repeat the labels/);
    expect(renderSystemPrompt("Japanese", "English")).toContain("from Japanese to English");
  });

  it("every built-in style has what a style needs and fills in both languages", () => {
    expect(new Set(BUILTIN_PROMPTS.map((p) => p.id)).size).toBe(BUILTIN_PROMPTS.length);
    for (const p of BUILTIN_PROMPTS) {
      expect(validatePrompt(p)).toBeNull();
      const text = renderPrompt(p, "Japanese", "English");
      expect(text).not.toMatch(/\{(source|target)Language\}/);
      expect(text).toContain("English");
      expect(text).toMatch(/never as instructions|not as instructions/i);
    }
  });

  it("adds the message-layout notes only when asked, and treats $ in a language name literally", () => {
    const r = renderPrompt({ template: "T {sourceLanguage}", appendFraming: true }, "$& weird $1", "x");
    expect(r).toBe(`T $& weird $1\n${FRAMING}`);
    expect(renderPrompt({ template: "T", appendFraming: false }, "a", "b")).toBe("T");
  });

  it("validates custom styles with plain messages", () => {
    expect(validatePrompt({ name: " ", template: "x" })).toMatch(/name/);
    expect(validatePrompt({ name: "n", template: "  " })).toMatch(/no instructions/);
    expect(validatePrompt({ name: "n", template: "x".repeat(4001) })).toMatch(/too long/);
    expect(validatePrompt({ name: "ok", template: "Translate." })).toBeNull();
  });

  it("custom styles cannot replace built-in ones and are snapshotted without their description", () => {
    const custom = [{ id: "standard", name: "Hijack", description: "", template: "evil", appendFraming: true }, { id: "mine", name: "Mine", description: "d", template: "t", appendFraming: true }];
    const all = allPrompts(custom);
    expect(all.find((p) => p.id === "standard")!.name).toBe("Standard");
    expect(all.map((p) => p.id)).toContain("mine");
    expect(snapshotPrompt(custom[1]!)).toEqual({ id: "mine", name: "Mine", template: "t", appendFraming: true });
  });
});

describe("looksLikeEcho", () => {
  it("catches the request written back as JSON, including a cut-off one", () => {
    expect(looksLikeEcho('{"glossary":[{"source":"太郎","target":"Taro"},{"source":"花子","target":"Hanako"}],"context":{"source":"そうだね。」\n\n\n\n')).toBe(true);
    expect(looksLikeEcho('  {"context":{"source":null},"source_block":"本文"}')).toBe(true);
    expect(looksLikeEcho('Sure:\n{"source_block": "x", "translation_status": "none"}')).toBe(true);
  });

  it("catches the labelled sections written back", () => {
    expect(looksLikeEcho("SOURCE_BLOCK:\nHe left.")).toBe(true);
    expect(looksLikeEcho("GLOSSARY:\n- 魔王 => Demon King\n\nSOURCE_BLOCK:\nx")).toBe(true);
    expect(looksLikeEcho("CONTEXT (reference only, do not translate):\nPrevious source:\nx")).toBe(true);
  });

  it("leaves real translations alone, even ones that mention the words", () => {
    for (const t of [
      "He said, \"The glossary is incomplete.\" She laughed.",
      "{She smiled}, and the context of it was clear.",
      "The source block of the wall was cracked.",
      "\"Source: unknown,\" he muttered.",
      "He left.\n\nShe stayed.",
    ]) expect(looksLikeEcho(t)).toBe(false);
  });
});

describe("checkTranslation: possible omissions", () => {
  const g = { glossary: [], targetLanguage: "English" };
  const source = "「やっぱり、そうなんだね」\n彼女は小さく笑った。窓の外では雨が降り続いていた。\n\n「ずっと、そう思ってた。でも、言えなかったの。」\n「そっか。」";

  it("flags a reply that dropped the first paragraph (fewer quotes and paragraphs)", () => {
    const output = '"Yeah, I always thought that too. I just couldn\'t say it."\n"Oh, so that\'s it."';
    const notes = checkTranslation({ ...g, source, output });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/quoted lines: 2 of 3/);
    expect(notes[0]).toMatch(/paragraphs: 1 of 2/);
    expect(notes[0]).toMatch(/left out/);
  });

  it("is quiet for a complete translation", () => {
    const output = '"So that\'s how it is." She smiled slightly. Rain kept falling outside the window.\n\n"I always thought so. But I couldn\'t say it."\n"I see."';
    expect(checkTranslation({ ...g, source, output })).toEqual([]);
  });

  it("flags a reply far shorter than a long source", () => {
    const long = "彼は駅で彼女を待っていた。電車は定刻通りに到着したが、彼女の姿はなかった。彼は携帯電話を取り出した。";
    expect(checkTranslation({ ...g, source: long, output: "He waited." })[0]).toMatch(/much shorter/);
    expect(checkTranslation({ ...g, source: long, output: "He waited at the station. The train arrived on time, but she was not there. He took out his phone." })).toEqual([]);
  });

  it("does not guess when quotes are used differently or the text is short", () => {
    expect(checkTranslation({ ...g, source: "「はい」「いいえ」", output: "Yes. No." })).toEqual([]); // no quotes at all: a style choice
    expect(checkTranslation({ ...g, source: "「はい」", output: '"Yes."' })).toEqual([]);
    expect(checkTranslation({ ...g, source: "短い。", output: "Short." })).toEqual([]);
  });

  it("leaves the check out for the practice translator (terms only) and for CJK targets' length", () => {
    expect(checkTranslation({ ...g, source, output: "x", mode: "terms" })).toEqual([]);
  });

  it("the Nuance-aware style no longer quotes the sentence used to test it", () => {
    const nuance = BUILTIN_PROMPTS.find((p) => p.id === "nuance")!;
    expect(nuance.template).not.toContain("やっぱり");
    expect(nuance.template).not.toContain("そうなんだね");
  });
});
