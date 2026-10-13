import { describe, expect, it } from "vitest";
import type { Asker } from "./extract.js";
import { buildSummary } from "./summary.js";
import type { Question } from "./steps.js";

const long = (n: number) => `Scene ${n}: ` + "Hanako and Taro talk at the school gate about the festival and what each of them will do. ".repeat(3).trim();

function scripted(answer: (q: Question) => string | null) {
  const asked: Question[] = [];
  const asker: Asker = { async ask(q) { asked.push(q); return answer(q); } };
  return { asker, asked };
}
const yes = (q: Question) => String.fromCharCode(65 + q.options!.findIndex((o) => o.startsWith("Yes")));
const no = (q: Question) => String.fromCharCode(65 + q.options!.findIndex((o) => o.startsWith("No")));

describe("the summary of a document", () => {
  it("is just the scene descriptions put together when they are short, with no model at all", async () => {
    const { asker, asked } = scripted(() => "invented");
    const r = await buildSummary({ scenes: ["Hanako waits at the gate.", "Taro arrives."], title: "Chapter 1", targetLanguage: "English", asker, room: 2000 });
    expect(r).toMatchObject({ text: "Hanako waits at the gate. Taro arrives.", usedModel: false, canceled: false });
    expect(asked).toEqual([]);
    // One scene is one scene: nothing to pad.
    expect((await buildSummary({ scenes: ["Only one."], title: "x", targetLanguage: "English", asker, room: 2000 })).text).toBe("Only one.");
  });

  it("has a model shorten long descriptions, tells it to add nothing, and keeps the result only if the scenes support it", async () => {
    const scenes = [1, 2, 3, 4, 5, 6].map(long);
    const good = scripted((q) => (q.id === "condense" ? "Hanako and Taro talk at the gate about the festival." : yes(q)));
    const r = await buildSummary({ scenes, title: "Chapter 1", targetLanguage: "English", asker: good.asker, room: 4000 });
    expect(r).toMatchObject({ text: "Hanako and Taro talk at the gate about the festival.", usedModel: true, unsupported: 0 });
    const condense = good.asked.find((q) => q.id === "condense")!;
    expect(condense.system).toContain("Do not add any detail");
    expect(condense.user).toMatch(/at most \d+ words/);

    const bad = scripted((q) => (q.id === "condense" ? "They fall in love and move abroad." : no(q)));
    const fallback = await buildSummary({ scenes, title: "Chapter 1", targetLanguage: "English", asker: bad.asker, room: 4000 });
    expect(fallback.unsupported).toBeGreaterThanOrEqual(1);
    expect(fallback.text).toContain("Scene 1:"); // the scenes themselves, not the invention
    expect(fallback.text).not.toContain("fall in love");
  });

  it("does not keep a shortened summary in the wrong language, splits very long input into groups, and stops when asked", async () => {
    const scenes = Array.from({ length: 12 }, (_, i) => long(i + 1));
    const chinese = scripted((q) => (q.id === "condense" ? "花子和太郎在校门口谈话。" : yes(q)));
    const r = await buildSummary({ scenes, title: "x", targetLanguage: "English", asker: chinese.asker, room: 300 });
    expect(r.unsupported).toBeGreaterThan(0);
    expect(r.text).not.toMatch(/[\u4E00-\u9FFF]/);
    expect(chinese.asked.filter((q) => q.id === "condense").length).toBeGreaterThan(1);

    let calls = 0;
    const stopping = await buildSummary({ scenes, title: "x", targetLanguage: "English", asker: scripted(() => "x").asker, room: 300, shouldStop: () => ++calls > 1 });
    expect(stopping.canceled).toBe(true);
  });
});
