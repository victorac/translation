import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  it("counts Latin text at three characters a token and other characters as a token each", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("Taro laughed.")).toBe(5);
    expect(estimateTokens("太郎は笑った。")).toBe(7);
    expect(estimateTokens("👍👍")).toBe(2);
  });
});
