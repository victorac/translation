import { describe, expect, it } from "vitest";
import { mergeSummary, summaryUserMessage } from "./analysis.js";

describe("summaries and requests", () => {
  let n = 0;
  const deps = { newId: () => `s${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
  const origin = { by: "model" as const, model: "m" };

  it("adds one summary per document, replaces its own, and keeps one the user confirmed", () => {
    const first = mergeSummary([], "Summary one.", { documentId: "d1" }, origin, deps);
    expect(first.entries).toMatchObject([{ kind: "summary", text: "Summary one.", scope: { documentId: "d1" }, status: "suggested" }]);
    const second = mergeSummary(first.entries, "Summary two.", { documentId: "d1" }, origin, deps);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]!.text).toBe("Summary two.");
    const kept = mergeSummary(second.entries.map((e) => ({ ...e, status: "confirmed" as const })), "Summary three.", { documentId: "d1" }, origin, deps);
    expect(kept.updated).toBe(false);
    expect(kept.entries[0]!.text).toBe("Summary two.");
  });

  it("builds the request as plain text", () => {
    expect(summaryUserMessage("Chapter 1", ["A.", "B."])).toBe("CHAPTER: Chapter 1\n\nSCENES:\n1. A.\n2. B.");
  });
});
