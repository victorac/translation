import type { GlossaryEntry } from "@ltw/domain";

/**
 * Short original passages for trying out prompts and glossaries. Each one targets a known difficulty,
 * and says what to look for in the result. Read the results yourself: no automatic score is trustworthy here.
 */
export interface SamplePassage {
  id: string;
  title: string;
  lookFor: string;
  text: string;
  glossary?: GlossaryEntry[];
}

export const SAMPLE_PASSAGES: SamplePassage[] = [
  {
    id: "confirming",
    title: "Tone: a quiet confirmation",
    lookFor: "「やっぱり、そうなんだね」 is resigned: she already suspected it. Look for wording like \"So that's how it is, huh\" or \"I knew it\", not \"Of course\" or a flat statement.",
    text: "「やっぱり、そうなんだね」\n彼女は小さく笑った。窓の外では雨が降り続いていた。\n\n「ずっと、そう思ってた。でも、言えなかったの。」\n「そっか。」",
  },
  {
    id: "dropped-subjects",
    title: "Dropped subjects and pronouns",
    lookFor: "Japanese leaves out who is doing what. Check that \"he\", \"she\" and \"they\" match who the story means, and that nobody is invented.",
    text: "「行ってくる」と言うと、母は何も言わずにお弁当を差し出した。\n受け取って、玄関を出る。振り返ると、まだ立っていた。\n\n手を振ろうとして、やめた。",
  },
  {
    id: "honorifics",
    title: "Honorifics and who speaks to whom",
    lookFor: "A student is polite to a teacher; the teacher is casual back. The difference should show in the English, and 先生 / くん should be handled consistently.",
    text: "「田中先生、少しお時間よろしいでしょうか」\n「ああ、佐藤くんか。入りなさい」\n\n「失礼します。実は、進路のことでご相談がありまして……」",
  },
  {
    id: "names",
    title: "Names and terms (try with the glossary)",
    lookFor: "With the glossary on, 魔王 should always be \"Demon King\" and the names should match the glossary. Compare with the glossary switched off.",
    text: "魔王ヴァルガスは、勇者アレンを見下ろした。\n「よく来たな、勇者よ。だが、ここがお前の墓場だ」\n\nアレンは剣を構えた。聖剣エルディアが、淡く光る。\n「魔王ヴァルガス、お前を倒す」",
    glossary: [
      { source: "魔王", target: "Demon King" },
      { source: "ヴァルガス", target: "Valgas" },
      { source: "勇者", target: "Hero" },
      { source: "アレン", target: "Allen" },
      { source: "聖剣エルディア", target: "the Holy Sword Eldia" },
    ],
  },
  {
    id: "long-sentence",
    title: "A long sentence and paragraph breaks",
    lookFor: "One long Japanese sentence may need splitting in English, but nothing should be dropped, and the paragraph breaks should stay.",
    text: "駅前の古い喫茶店は、彼が学生の頃から変わらず、薄暗い店内にコーヒーの香りと古い本の匂いが混じり合い、窓際の席に座ると、行き交う人々の傘が雨に濡れて色とりどりに揺れるのが見えた。\n\n彼はいつもの席に座り、いつものものを頼んだ。",
  },
  {
    id: "casual-speech",
    title: "Casual speech and mild swearing",
    lookFor: "Casual, clipped speech should sound like speech, not a textbook. Mild swearing should not be softened or removed.",
    text: "「くそっ、また遅刻かよ」\n「だから言ったじゃん、目覚まし二つかけとけって」\n「うるせえな。お前だって昨日寝坊しただろ」\n\n二人は顔を見合わせて、同時に吹き出した。",
  },
];
