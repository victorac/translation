import { describe, expect, it } from "vitest";
import { FakeProvider, ConcurrencyProbe, createGate, script, chunkText } from "./fake.js";
import { checkWellFormed, collectStream, enforceContract, providerError, ProviderRequestError } from "./contract.js";
import { ProviderRegistry } from "./registry.js";
import type { GenerateRequest, ProviderConfig } from "./types.js";

const config: ProviderConfig = { id: "p1", kind: "fake", baseUrl: "http://localhost:1234/v1" };
const req = (source: string, over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  requestId: "r1",
  modelId: "m1",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: `SOURCE_BLOCK:\n${source}` },
  ],
  temperature: 0.2,
  maxOutputTokens: 1536,
  stream: true,
  ...over,
});
const live = () => new AbortController();
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FakeProvider streaming", () => {
  it("streams a deterministic translation as deltas then one finish", async () => {
    const p = new FakeProvider();
    const out = await collectStream(p.generate(config, req("こんにちは"), live().signal));
    expect(out.text).toBe("[m1] こんにちは");
    expect(out.terminal).toEqual({ type: "finish", reason: "stop" });
    expect(out.events.filter((e) => e.type === "delta").length).toBeGreaterThan(1);
    expect(checkWellFormed(out.events)).toEqual([]);
    const again = await collectStream(p.generate(config, req("こんにちは"), live().signal));
    expect(again.events).toEqual(out.events);
  });

  it("never splits a surrogate pair across deltas", async () => {
    const p = new FakeProvider({ chunk: 1 });
    const out = await collectStream(p.generate(config, req("👍🏽𠮷"), live().signal));
    for (const e of out.events) {
      if (e.type === "delta") expect(e.text.isWellFormed()).toBe(true);
    }
    expect(out.text).toBe("[m1] 👍🏽𠮷");
    expect(chunkText("a👍b", 1)).toEqual(["a", "👍", "b"]);
  });

  it("returns a single delta when stream is false", async () => {
    const p = new FakeProvider();
    const out = await collectStream(p.generate(config, req("abc", { stream: false }), live().signal));
    expect(out.events.filter((e) => e.type === "delta")).toHaveLength(1);
  });

  it("records requests and reports usage when scripted", async () => {
    const p = new FakeProvider().enqueue([
      { t: "delta", text: "x" },
      { t: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 1 } },
    ]);
    const out = await collectStream(p.generate(config, req("a"), live().signal));
    expect(out.terminal).toMatchObject({ usage: { inputTokens: 10, outputTokens: 1 } });
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]!.modelId).toBe("m1");
  });

  it("uses queued scripts in order and then falls back to the default", async () => {
    const p = new FakeProvider().enqueue(script.translate("first"), script.failure(providerError("auth", "no")));
    const a = await collectStream(p.generate(config, req("x"), live().signal));
    const b = await collectStream(p.generate(config, req("x"), live().signal));
    const c = await collectStream(p.generate(config, req("x"), live().signal));
    expect(a.text).toBe("first");
    expect(b.terminal).toMatchObject({ type: "error", error: { code: "auth", retryable: false } });
    expect(c.text).toBe("[m1] x");
  });
});

describe("FakeProvider concurrency probe", () => {
  it("shows 1 when requests run one after another and 2 when they overlap", async () => {
    const seq = new FakeProvider();
    await collectStream(seq.generate(config, req("a"), live().signal));
    await collectStream(seq.generate(config, req("b"), live().signal));
    expect(seq.probe.max).toBe(1);
    expect(seq.probe.active).toBe(0);

    const gate = createGate();
    const par = new FakeProvider().enqueue([{ t: "gate", gate }, ...script.translate("a")]);
    const first = collectStream(par.generate(config, req("a"), live().signal));
    await tick();
    const second = collectStream(par.generate(config, req("b"), live().signal));
    await tick();
    gate.open();
    await Promise.all([first, second]);
    expect(par.probe.max).toBe(2);
  });

  it("is shared across providers via a common probe", async () => {
    const probe = new ConcurrencyProbe();
    const a = new FakeProvider({ probe });
    const b = new FakeProvider({ probe });
    await collectStream(a.generate(config, req("x"), live().signal));
    await collectStream(b.generate(config, req("x"), live().signal));
    expect(probe.started).toBe(2);
    expect(probe.max).toBe(1);
  });

  it("releases the slot when the consumer stops early", async () => {
    const p = new FakeProvider();
    for await (const _ of p.generate(config, req("long text here"), live().signal)) break;
    expect(p.probe.active).toBe(0);
  });
});

describe("cancellation", () => {
  it("ends with exactly one canceled error when aborted mid-stream, and ignores a later gate open", async () => {
    const gate = createGate();
    const p = new FakeProvider().enqueue([{ t: "delta", text: "par" }, { t: "gate", gate }, { t: "delta", text: "tial" }, { t: "finish", reason: "stop" }]);
    const ac = live();
    const run = collectStream(p.generate(config, req("x"), ac.signal));
    await tick();
    ac.abort();
    const out = await run;
    gate.open();
    expect(out.text).toBe("par");
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "canceled", retryable: false } });
    expect(checkWellFormed(out.events)).toEqual([]);
  });

  it("cancels a hanging request and a request aborted before it starts", async () => {
    const p = new FakeProvider().enqueue([{ t: "hang" }]);
    const ac = live();
    const run = collectStream(p.generate(config, req("x"), ac.signal));
    await tick();
    ac.abort();
    expect((await run).terminal).toMatchObject({ error: { code: "canceled" } });

    const pre = live();
    pre.abort();
    const out = await collectStream(new FakeProvider().generate(config, req("x"), pre.signal));
    expect(out.terminal).toMatchObject({ error: { code: "canceled" } });
    expect(out.text).toBe("");
  });

  it("interrupts a timed wait on abort", async () => {
    const p = new FakeProvider().enqueue([{ t: "wait", ms: 60_000 }, ...script.translate("x")]);
    const ac = live();
    const run = collectStream(p.generate(config, req("x"), ac.signal));
    await tick();
    ac.abort();
    expect((await run).terminal).toMatchObject({ error: { code: "canceled" } });
  });

  it("ignoreAbort models a server that keeps going: a late success arrives after cancel", async () => {
    const gate = createGate();
    const p = new FakeProvider({ ignoreAbort: true }).enqueue([{ t: "delta", text: "a" }, { t: "gate", gate }, { t: "delta", text: "b" }, { t: "finish", reason: "stop" }]);
    const ac = live();
    const run = collectStream(p.generate(config, req("x"), ac.signal));
    await tick();
    ac.abort();
    gate.open();
    const out = await run;
    expect(out.text).toBe("ab");
    expect(out.terminal).toMatchObject({ type: "finish" }); // coordinator epoch guards must discard this
  });
});

describe("failures", () => {
  it("answers model_unavailable and can recover when the model is loaded", async () => {
    const p = new FakeProvider({ unavailable: ["m1"] });
    const down = await collectStream(p.generate(config, req("x"), live().signal));
    expect(down.terminal).toMatchObject({ error: { code: "model_unavailable", retryable: false } });
    p.setUnavailable("m1", false);
    expect((await collectStream(p.generate(config, req("x"), live().signal))).terminal?.type).toBe("finish");
  });

  it("keeps the partial draft when a script fails after output (AC-07)", async () => {
    const p = new FakeProvider().enqueue(script.partialThenError("半分", providerError("server", "boom", { httpStatus: 500 })));
    const out = await collectStream(p.generate(config, req("x"), live().signal));
    expect(out.text).toBe("半分");
    expect(out.terminal).toMatchObject({ error: { code: "server", retryable: true, httpStatus: 500 } });
  });

  it("marks only rate_limit and server as retryable by default", () => {
    const retryable = (["connection", "auth", "model_unavailable", "context_overflow", "rate_limit", "timeout", "invalid_response", "server", "canceled"] as const).filter(
      (c) => providerError(c, "m").retryable,
    );
    expect(retryable).toEqual(["rate_limit", "server"]);
  });

  it("surfaces health and discovery errors, honoring abort", async () => {
    const bad = new FakeProvider({ healthError: providerError("connection", "refused"), listModelsError: providerError("auth", "401", { httpStatus: 401 }) });
    await expect(bad.health(config, live().signal)).rejects.toBeInstanceOf(ProviderRequestError);
    await expect(bad.listModels(config, live().signal)).rejects.toMatchObject({ providerError: { code: "auth" } });
    const ac = live();
    ac.abort();
    await expect(new FakeProvider().health(config, ac.signal)).rejects.toMatchObject({ providerError: { code: "canceled" } });
  });

  it("lists models without exposing internal state, and reports capabilities", async () => {
    const p = new FakeProvider({ models: [{ id: "a", label: "A", contextLimit: 8192 }], capabilities: { cancellation: "server-confirmed" } });
    const models = await p.listModels(config, live().signal);
    models[0]!.id = "mutated";
    expect((await p.listModels(config, live().signal))[0]!.id).toBe("a");
    expect(await p.capabilities()).toEqual({ streaming: true, tokenCounting: false, modelResidency: false, cancellation: "server-confirmed" });
  });
});

describe("enforceContract", () => {
  it("turns a thrown network rejection into a connection error", async () => {
    const p = new FakeProvider().enqueue([{ t: "delta", text: "a" }, { t: "throw", error: new TypeError("fetch failed") }]);
    const out = await collectStream(enforceContract(p.generate(config, req("x"), live().signal)));
    expect(out.text).toBe("a");
    expect(out.terminal).toMatchObject({ error: { code: "connection" } });
    expect(checkWellFormed(out.events)).toEqual([]);
  });

  it("turns a silent end into invalid_response so a disconnect is never a complete result", async () => {
    const p = new FakeProvider().enqueue(script.disconnect("half"));
    const raw = await collectStream(p.generate(config, req("x"), live().signal));
    expect(checkWellFormed(raw.events)).toEqual([{ message: "no terminal event" }]);
    p.enqueue(script.disconnect("half"));
    const out = await collectStream(enforceContract(p.generate(config, req("x"), live().signal)));
    expect(out.terminal).toMatchObject({ error: { code: "invalid_response", retryable: false } });
  });

  it("drops empty deltas and anything after the first terminal", async () => {
    const p = new FakeProvider().enqueue([
      { t: "delta", text: "" },
      { t: "delta", text: "ok" },
      { t: "finish", reason: "stop" },
    ]);
    async function* noisy() {
      yield* p.generate(config, req("x"), live().signal);
      yield { type: "delta" as const, text: "late" };
      yield { type: "finish" as const, reason: "stop" as const };
    }
    const out = await collectStream(enforceContract(noisy()));
    expect(out.text).toBe("ok");
    expect(out.events).toHaveLength(2);
    expect(checkWellFormed(out.events)).toEqual([]);
  });

  it("maps AbortError and unknown errors", async () => {
    const abort = Object.assign(new Error("x"), { name: "AbortError" });
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    for (const [err, code] of [[abort, "canceled"], [refused, "connection"], [new Error("odd"), "server"], ["str", "server"]] as const) {
      const p = new FakeProvider().enqueue([{ t: "throw", error: err }]);
      const out = await collectStream(enforceContract(p.generate(config, req("x"), live().signal)));
      expect(out.terminal).toMatchObject({ error: { code } });
    }
  });
});

describe("ProviderRegistry", () => {
  it("selects adapters by kind and rejects duplicates and unknown kinds", () => {
    const reg = new ProviderRegistry().register(new FakeProvider());
    expect(reg.get("fake").kind).toBe("fake");
    expect(reg.kinds()).toEqual(["fake"]);
    expect(() => reg.register(new FakeProvider())).toThrow(/already registered/);
    expect(() => reg.get("nope")).toThrow(/No adapter/);
  });
});
