import {
  describe,
  expect,
  it,
} from "vitest";
import {
  nameRuns,
  parseNameTable,
  pickReading,
  splitName,
} from "./names.js";
import type { WordToken } from "./steps.js";

// Rows as the real table has them (see scripts/build-names.ts).
const table = parseNameTable(
  [
    "水瀬\tミズセ:fs ミナセ:fs",
    "皆瀬\tミナセ:s",
    "南瀬\tミナセ:s",
    "灯\tアカリ:f トモ:f トモリ:f",
    "久我\tクガ:s クゲ:s コガ:s",
    "蓮\tハス:fs ハチス:s レン:fms",
    "凛\tリュウ:f リリ:f リン:f",
    "今\tイマ:s",
    "日\tアキラ:m",
    "白鷺\tシラサギ:s",
    "堂\tケイドウ:m",
  ].join("\n"),
);

/** Words as the general dictionary gives them: a surface, and its part of speech. */
const t = (surface: string, ...details: string[]): WordToken => ({ surface, details, byteStart: 0, byteEnd: 0 });
const noun = (surface: string) => t(surface, "名詞", "一般", "*");

describe("person names from a names dictionary", () => {
  it("finds a surname and a given name the general dictionary cut into common words", () => {
    // 水瀬灯は: 水 / 瀬 / 灯 / は
    expect(nameRuns([noun("水"), noun("瀬"), t("灯", "名詞", "接尾", "一般"), t("は", "助詞", "係助詞", "*")], table)).toEqual([{ name: "水瀬灯", surname: "水瀬", given: "灯" }]);
  });

  it("takes no word the general dictionary knows whole, no one-character surname, and no shop", () => {
    // 今日 is one word to it; 今 / 日 as two words still has a surname of one character.
    expect(nameRuns([noun("今日")], table)).toEqual([]);
    expect(nameRuns([noun("今"), noun("日")], table)).toEqual([]);
    // The bookshop Shirasagi-dō.
    expect(nameRuns([noun("白鷺"), noun("堂")], table)).toEqual([]);
    // A number or a counter breaks the run.
    expect(nameRuns([t("三", "名詞", "数", "*"), noun("水瀬"), noun("灯")], table)).toEqual([{ name: "水瀬灯", surname: "水瀬", given: "灯" }]);
  });

  it("splits a name into surname and given name, not a shop", () => {
    expect(splitName("久我蓮", table)).toEqual(["久我", "蓮"]);
    expect(splitName("凛", table)).toBeNull();
    expect(splitName("白鷺堂", table)).toBeNull();
  });

  it("reads a part as the general dictionary does when the table allows it, else as most names do", () => {
    expect(pickReading("凛", "g", table, "リン")).toBe("リン");
    // The general dictionary reads 蓮 as the lotus, which the table gives as a surname and a given name too: it is taken.
    expect(pickReading("蓮", "g", table, "ハス")).toBe("ハス");
    // Not known to it: Minase, shared by more surnames than Mizuse.
    expect(pickReading("水瀬", "s", table, null)).toBe("ミナセ");
    expect(pickReading("灯", "g", table, null)).toBe("アカリ");
    // Not a surname in the table.
    expect(pickReading("灯", "s", table, null)).toBeNull();
  });
});
