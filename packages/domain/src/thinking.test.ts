import { describe, expect, it } from "vitest";
import { stripThinking } from "./thinking.js";

describe("stripThinking", () => {
  it("removes a leading thinking section", () => {
    expect(stripThinking("<think>Let me see.\nHm.</think>\n\nHello.")).toBe("Hello.");
  });
  it("handles a reply that only has the closing tag", () => {
    expect(stripThinking("Let me see.\n</think>\nHello.")).toBe("Hello.");
  });
  it("returns an empty reply when it never finished thinking", () => {
    expect(stripThinking("<think>Still going")).toBe("");
  });
  it("leaves ordinary text alone", () => {
    expect(stripThinking("He said <think> aloud.")).toBe("He said <think> aloud.");
    expect(stripThinking("Plain.")).toBe("Plain.");
  });
});
