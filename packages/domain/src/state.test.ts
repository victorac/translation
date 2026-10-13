import { describe, expect, it } from "vitest";
import { producingAttempt, type BlockOutput } from "./state.js";

const out = (): BlockOutput => ({
  blockId: "b",
  state: "succeeded",
  attempts: [
    { id: "a1", ordinal: 1, configHash: "c", sourceHash: "s", contextHash: "x", state: "succeeded" },
    { id: "a2", ordinal: 2, configHash: "c", sourceHash: "s", contextHash: "x", state: "succeeded" },
  ],
  versions: [
    { id: "v1", blockId: "b", attemptId: "a1", kind: "generated", text: "one", createdAt: "t" },
    { id: "v2", blockId: "b", attemptId: "a2", kind: "generated", text: "two", createdAt: "t" },
  ],
  currentVersionId: "v1",
});

describe("producingAttempt", () => {
  it("is the attempt behind the current text", () => {
    expect(producingAttempt(out())?.id).toBe("a1");
    const o = out();
    o.currentVersionId = "v2";
    expect(producingAttempt(o)?.id).toBe("a2");
  });

  it("follows manual edits back to the model's own text, even through several edits", () => {
    const o = out();
    o.versions.push({ id: "m1", blockId: "b", kind: "manual", text: "mine", createdAt: "t", baseVersionId: "v2" });
    o.versions.push({ id: "m2", blockId: "b", kind: "manual", text: "mine again", createdAt: "t", baseVersionId: "m1" });
    o.currentVersionId = "m2";
    expect(producingAttempt(o)?.id).toBe("a2");
  });

  it("is undefined when there is no text yet", () => {
    const o = out();
    delete o.currentVersionId;
    expect(producingAttempt(o)).toBeUndefined();
  });
});
