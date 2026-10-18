import {
  describe,
  expect,
  it,
} from "vitest";
import {
  findCandidateNames,
  findNames,
} from "./analyzer.js";

describe("finding candidate names without a model", () => {
  it("finds people, places and families a Japanese word analyzer knows, and ones that are written like names", async () => {
    const names = await findCandidateNames("ぼくは山田太郎という。山田家の跡取りで、桜台学園に通う。「田中くん、お待たせしました」");
    expect(names).toEqual(expect.arrayContaining(["山田太郎", "山田家", "桜台学園", "田中"]));
    expect(names.every((n) => n.length >= 2)).toBe(true);
  });

  it("leaves out everyday words before an honorific or said again in katakana, and keeps the names", async () => {
    const text = "「付与魔術師さん、どうぞ」受付さんが笑った。テーブルの上のテーブル。ギルドに行く。ギルドは広い。「セラ、黙ってろ」セラは黙った。";
    const names = await findCandidateNames(text);
    expect(names).toContain("セラ");
    for (const everyday of ["付与魔術師", "受付", "テーブル", "ギルド"]) expect(names).not.toContain(everyday);
  });

  it("knows a person's name, and a place, by the analyzer's tag or the names table", async () => {
    const { kinds } = await findNames("ノアは笑った。久我蓮は座った。水瀬灯は傘をたたんだ。");
    expect(kinds).toMatchObject({ ノア: "character", 久我蓮: "character", 水瀬灯: "character" });
  });

  it("finds nothing in text without names", async () => {
    expect(await findCandidateNames("今日は天気がいい。")).toEqual([]);
    expect(await findCandidateNames("")).toEqual([]);
  });
});
