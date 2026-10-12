import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { SseDecoder } from "./sse.js";

const enc = new TextEncoder();
const decodeAll = (bytes: Uint8Array, cuts: number[] = []) => {
  const d = new SseDecoder();
  const points = [...new Set(cuts.map((c) => Math.min(Math.max(c, 0), bytes.length)))].sort((a, b) => a - b);
  const out: string[] = [];
  let from = 0;
  for (const p of [...points, bytes.length]) {
    for (const m of d.push(bytes.slice(from, p))) out.push(m.data);
    from = p;
  }
  for (const m of d.end()) out.push(m.data);
  return out;
};

describe("SseDecoder", () => {
  it("reads messages, ignoring comments and unknown fields", () => {
    const d = new SseDecoder();
    const msgs = d.push(enc.encode(': keep-alive\n\nid: 7\nevent: x\ndata: {"a":1}\n\ndata: [DONE]\n\n'));
    expect(msgs).toEqual([{ data: '{"a":1}', event: "x" }, { data: "[DONE]" }]);
  });

  it("joins multi-line data and handles all three line endings", () => {
    expect(decodeAll(enc.encode("data: a\r\ndata: b\r\n\r\n"))).toEqual(["a\nb"]);
    expect(decodeAll(enc.encode("data: a\rdata: b\r\r"))).toEqual(["a\nb"]);
    expect(decodeAll(enc.encode("data: a\ndata: b\n\n"))).toEqual(["a\nb"]);
  });

  it("drops a leading byte-order mark and one space after the colon", () => {
    expect(decodeAll(enc.encode("﻿data:  two spaces\n\n"))).toEqual([" two spaces"]);
  });

  it("does not deliver a message that was cut off, and reports it", () => {
    const d = new SseDecoder();
    expect(d.push(enc.encode('data: {"partial"'))).toEqual([]);
    expect(d.hasIncompleteMessage).toBe(true);
    const clean = new SseDecoder();
    clean.push(enc.encode("data: x\n\n"));
    expect(clean.hasIncompleteMessage).toBe(false);
  });

  it("AC-05: the result is identical however the bytes are split, even inside a character or a CRLF", () => {
    const payload = ["やっぱり、そうなんだね", "👍🏽 emoji", "line\nbreak", "𠮷野家"]
      .map((s) => `data: ${JSON.stringify({ t: s })}\r\n\r\n`)
      .join("") + "data: [DONE]\n\n";
    const bytes = enc.encode(payload);
    const whole = decodeAll(bytes);
    expect(whole).toHaveLength(5);
    for (let cut = 0; cut <= bytes.length; cut++) expect(decodeAll(bytes, [cut])).toEqual(whole);
    fc.assert(
      fc.property(fc.array(fc.nat(bytes.length), { maxLength: 40 }), (cuts) => {
        expect(decodeAll(bytes, cuts)).toEqual(whole);
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips arbitrary text through arbitrary splits", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "grapheme", maxLength: 12 }), { maxLength: 8 }), fc.array(fc.nat(400), { maxLength: 20 }), (items, cuts) => {
        const bytes = enc.encode(items.map((s) => `data: ${JSON.stringify(s)}\n\n`).join(""));
        expect(decodeAll(bytes, cuts).map((d) => JSON.parse(d))).toEqual(items);
      }),
      { numRuns: 200 },
    );
  });
});
