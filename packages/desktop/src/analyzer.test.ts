import { describe, expect, it } from "vitest";
import { findCandidateNames } from "./analyzer.js";

describe("finding candidate names without a model", () => {
  it("finds people, places and families a Japanese word analyzer knows, and ones that are written like names", async () => {
    const names = await findCandidateNames("ぼくは山田太郎という。山田家の跡取りで、桜台学園に通う。「田中くん、お待たせしました」");
    expect(names).toEqual(expect.arrayContaining(["山田太郎", "山田家", "桜台学園", "田中"]));
    expect(names.every((n) => n.length >= 2)).toBe(true);
  });

  it("finds nothing in text without names", async () => {
    expect(await findCandidateNames("今日は天気がいい。")).toEqual([]);
    expect(await findCandidateNames("")).toEqual([]);
  });
});
