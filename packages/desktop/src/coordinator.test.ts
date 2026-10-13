import { describe, expect, it } from "vitest";
import { createRevision, currentVersion, parseUserMessage, type SourceRevision } from "@ltw/domain";
import { createGate, FakeProvider, ProviderRegistry, providerError, script, type FakeProviderOptions } from "@ltw/providers";
import { Coordinator, type CoordinatorEvent } from "./coordinator.js";

const TEXT = "一。\n\n二。\n\n三。\n\n四。\n\n五。";

function setup(opts: FakeProviderOptions = {}, extra: { checkpoint?: () => Promise<void>; text?: string } = {}) {
  const revision: SourceRevision = createRevision({ text: extra.text ?? TEXT, sourceLanguage: "Japanese", targetLanguage: "English", targetTokens: 4, maxTokens: 4 });
  const provider = new FakeProvider(opts);
  const registry = new ProviderRegistry().register(provider);
  const sleeps: number[] = [];
  const events: CoordinatorEvent[] = [];
  let n = 0;
  const c = new Coordinator({
    registry,
    providerConfig: () => ({ id: "p1", kind: "fake", baseUrl: "http://localhost:1234/v1" }),
    newId: () => `id${++n}`,
    now: () => "2026-01-01T00:00:00Z",
    random: () => 0.5, // jitter factor of exactly 1
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
    ...(extra.checkpoint ? { checkpoint: extra.checkpoint } : {}),
  });
  c.onEvent((e) => events.push(e));
  c.addRevision(revision);
  const run = (label = "m1", cfg = {}) => c.addRun({ revisionId: revision.id, providerRefId: "p1", modelId: label, label, config: cfg });
  return { c, revision, provider, sleeps, events, run };
}

const until = (c: Coordinator, pred: (e: CoordinatorEvent) => boolean) =>
  new Promise<CoordinatorEvent>((resolve) => {
    const off = c.onEvent((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });

const sourceOf = (req: { messages: { content: string }[] }) => parseUserMessage(req.messages[1]!.content)!.sourceBlock;
/** The reference part of a request, in the shape the tests below describe. */
const contextOf = (req: { messages: { content: string }[] }) => {
  const c = parseUserMessage(req.messages[1]!.content)!.context;
  return { source: c?.source ?? null, translation: c?.translation ?? null, translation_status: c === null ? "none" : c.translation === null ? "unavailable" : "available" };
};
const text = (c: Coordinator, runId: string, i: number, rev: SourceRevision) => {
  const out = c.snapshotRun(runId).outputs[rev.blocks[i]!.id]!;
  return currentVersion(out)?.text;
};
const stateOf = (c: Coordinator, runId: string, i: number, rev: SourceRevision) => c.snapshotRun(runId).outputs[rev.blocks[i]!.id]!.state;

describe("running a job", () => {
  it("AC-02: 5 blocks x 2 models = 10 requests, model by model, one at a time", async () => {
    const { c, revision, provider, run } = setup();
    expect(revision.blocks).toHaveLength(5);
    const a = run("m1");
    const b = run("m2");
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id, b.id] });
    await done;

    expect(provider.requests.map((r) => r.modelId)).toEqual(["m1", "m1", "m1", "m1", "m1", "m2", "m2", "m2", "m2", "m2"]);
    expect(provider.requests.slice(0, 5).map(sourceOf)).toEqual(revision.blocks.map((_, i) => ["一。\n\n", "二。\n\n", "三。\n\n", "四。\n\n", "五。"][i]));
    expect(provider.probe.max).toBe(1);
    revision.blocks.forEach((_, i) => {
      expect(text(c, a.id, i, revision)).toBe(`[m1] ${sourceOf(provider.requests[i]!)}`);
      expect(text(c, b.id, i, revision)).toBe(`[m2] ${sourceOf(provider.requests[5 + i]!)}`);
    });
    expect(c.snapshotJob(job.id).state).toBe("completed");
    expect(c.snapshotRun(a.id).state).toBe("completed");
  });

  it("sends the previous block's source and accepted translation as context", async () => {
    const { c, revision, provider, run } = setup();
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    expect(contextOf(provider.requests[0]!).translation_status).toBe("none");
    expect(contextOf(provider.requests[1]!)).toMatchObject({ translation: "[m1] 一。\n\n", translation_status: "available" });
  });

  it("emits ordered events and never counts a streaming draft as done", async () => {
    const { c, revision, events, run } = setup({ chunk: 2 });
    const a = run();
    const first = until(c, (e) => e.type === "delta");
    const { done } = c.startJob({ revisionId: revision.id, runIds: [a.id] });
    await first;
    expect(stateOf(c, a.id, 0, revision)).toBe("running");
    expect(currentVersion(c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!)).toBeUndefined();
    await done;
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.every((e) => e.eventVersion === 1)).toBe(true);
  });

  it("AC-03: a model added during a job runs after the queued models on the same blocks", async () => {
    const gate = createGate();
    const { c, revision, provider, run } = setup();
    provider.enqueue([{ t: "gate", gate }, ...script.translate("slow")]);
    const a = run("m1");
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id] });
    await until(c, (e) => e.type === "started");
    const b = run("m2");
    c.appendRun(job.id, b.id);
    gate.open();
    await done;
    expect(provider.requests.map((r) => r.modelId)).toEqual(["m1", "m1", "m1", "m1", "m1", "m2", "m2", "m2", "m2", "m2"]);
    expect(Object.keys(c.snapshotRun(b.id).outputs)).toEqual(revision.blocks.map((x) => x.id));
    expect(c.snapshotRun(b.id).state).toBe("completed");
  });

  it("a retry requested during a request waits its turn", async () => {
    const gate = createGate();
    const { c, revision, provider, run } = setup();
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    provider.enqueue([{ t: "gate", gate }, ...script.translate("one")], script.translate("two"));
    const first = c.retryBlock(a.id, revision.blocks[0]!.id);
    await until(c, (e) => e.type === "started");
    const second = c.retryBlock(a.id, revision.blocks[1]!.id);
    gate.open();
    await Promise.all([first.done, second.done]);
    expect(provider.probe.max).toBe(1);
  });
});

describe("cancelling", () => {
  it("AC-06: canceling the job mid-stream commits nothing, ignores a late success and stops dispatch", async () => {
    const gate = createGate();
    const { c, revision, provider, run } = setup({ ignoreAbort: true });
    provider.enqueue([{ t: "delta", text: "par" }, { t: "gate", gate }, { t: "delta", text: "tial" }, { t: "finish", reason: "stop" }]);
    const a = run();
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id] });
    await until(c, (e) => e.type === "delta");
    c.cancel({ kind: "job", jobId: job.id });
    gate.open(); // the misbehaving server now "finishes" anyway
    await done;

    const snap = c.snapshotRun(a.id);
    const first = snap.outputs[revision.blocks[0]!.id]!;
    expect(provider.requests).toHaveLength(1);
    expect(first.state).toBe("canceled");
    expect(first.versions).toEqual([]);
    expect(first.attempts[0]).toMatchObject({ state: "canceled", draft: "par" });
    expect(Object.values(snap.outputs).every((o) => o.state === "canceled")).toBe(true);
    expect(c.snapshotJob(job.id).state).toBe("canceled");
    expect(snap.state).toBe("canceled");
  });

  it("canceling one model lets the next model run", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue([{ t: "delta", text: "x" }, { t: "hang" }]);
    const a = run("m1");
    const b = run("m2");
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id, b.id] });
    await until(c, (e) => e.type === "delta");
    c.cancel({ kind: "run", runId: a.id });
    await done;
    expect(c.snapshotRun(a.id).state).toBe("canceled");
    expect(c.snapshotRun(b.id).state).toBe("completed");
    expect(provider.requests.filter((r) => r.modelId === "m2")).toHaveLength(5);
    expect(c.snapshotJob(job.id).state).toBe("completed_with_issues");
  });

  it("canceling one block lets later blocks go on, with source-only context", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.translate("ok"), [{ t: "delta", text: "x" }, { t: "hang" }]);
    const a = run();
    const { done } = c.startJob({ revisionId: revision.id, runIds: [a.id] });
    await until(c, (e) => e.type === "delta" && e.blockId === revision.blocks[1]!.id);
    c.cancel({ kind: "block", runId: a.id, blockId: revision.blocks[1]!.id });
    await done;
    expect(stateOf(c, a.id, 0, revision)).toBe("succeeded");
    expect(stateOf(c, a.id, 1, revision)).toBe("canceled");
    expect(stateOf(c, a.id, 2, revision)).toBe("succeeded");
    expect(contextOf(provider.requests[2]!)).toMatchObject({ translation: null, translation_status: "unavailable" });
  });

  it("canceling during the pause before an automatic retry stops right away", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.failure(providerError("rate_limit", "slow down", { httpStatus: 429 })));
    // a sleep that never finishes unless aborted
    const c2 = new Coordinator({
      registry: new ProviderRegistry().register(provider),
      providerConfig: () => ({ id: "p1", kind: "fake", baseUrl: "x" }),
      sleep: (_ms, signal) => new Promise((r) => signal.addEventListener("abort", () => r(false), { once: true })),
    });
    c2.addRevision(revision);
    const a = c2.addRun({ revisionId: revision.id, providerRefId: "p1", modelId: "m1", label: "m1" });
    const { job, done } = c2.startJob({ revisionId: revision.id, runIds: [a.id] });
    await until(c2, (e) => e.type === "terminal");
    await new Promise((r) => setTimeout(r, 0));
    c2.cancel({ kind: "job", jobId: job.id });
    await done;
    expect(provider.requests).toHaveLength(1);
    expect(c2.snapshotJob(job.id).state).toBe("canceled");
    void c; void run;
  });
});

describe("failures", () => {
  it("AC-07: a block that fails after partial output keeps its draft; later blocks go on without its translation", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.translate("one"), script.partialThenError("half", providerError("server", "boom", { httpStatus: 500 })));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;

    const out2 = c.snapshotRun(a.id).outputs[revision.blocks[1]!.id]!;
    expect(out2.state).toBe("failed");
    expect(out2.attempts).toHaveLength(1); // partial output is never retried automatically
    expect(out2.attempts[0]).toMatchObject({ state: "failed", draft: "half", error: { code: "server" } });
    expect(out2.versions).toEqual([]);
    expect(text(c, a.id, 0, revision)).toBe("one");
    expect(contextOf(provider.requests[2]!)).toMatchObject({ translation: null, translation_status: "unavailable" });
    expect(stateOf(c, a.id, 4, revision)).toBe("succeeded");
    expect(c.snapshotRun(a.id).state).toBe("completed_with_issues");
  });

  it("AC-07: retrying the failed block adds an attempt and marks only the next block stale", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.translate("one"), script.partialThenError("half", providerError("server", "boom")));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    await c.retryBlock(a.id, revision.blocks[1]!.id).done;

    const out2 = c.snapshotRun(a.id).outputs[revision.blocks[1]!.id]!;
    expect(out2.attempts.map((x) => x.ordinal)).toEqual([1, 2]);
    expect(new Set(out2.attempts.map((x) => x.id)).size).toBe(2);
    expect(out2.state).toBe("succeeded");
    expect(stateOf(c, a.id, 2, revision)).toBe("stale"); // it was translated without block 2's text
    expect(stateOf(c, a.id, 3, revision)).toBe("succeeded"); // block 3's context did not change
    expect(c.snapshotRun(a.id).outputs[revision.blocks[2]!.id]!.staleReason).toBe("context_changed");
  });

  it("retries 429 and 5xx before any text, waiting 1 s then 3 s, each time as a new attempt", async () => {
    const { c, revision, provider, sleeps, run } = setup();
    provider.enqueue(
      script.failure(providerError("rate_limit", "429", { httpStatus: 429 })),
      script.failure(providerError("server", "503", { httpStatus: 503 })),
    );
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[0]!.id] }).done;
    expect(sleeps).toEqual([1000, 3000]);
    const out = c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!;
    expect(out.attempts.map((x) => x.state)).toEqual(["failed", "failed", "succeeded"]);
    expect(out.state).toBe("succeeded");
  });

  it("gives up after two extra attempts", async () => {
    const { c, revision, provider, sleeps, run } = setup();
    const fail = () => script.failure(providerError("server", "503", { httpStatus: 503 }));
    provider.enqueue(fail(), fail(), fail());
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[0]!.id] }).done;
    expect(provider.requests).toHaveLength(3);
    expect(sleeps).toEqual([1000, 3000]);
    expect(stateOf(c, a.id, 0, revision)).toBe("failed");
  });

  it("honors Retry-After but caps it at 30 seconds", async () => {
    const { c, revision, provider, sleeps, run } = setup();
    provider.enqueue(script.failure(providerError("rate_limit", "429", { retryAfterMs: 120_000 })));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[0]!.id] }).done;
    expect(sleeps).toEqual([30_000]);
  });

  it("does not retry automatically on other errors", async () => {
    const { c, revision, provider, sleeps, run } = setup();
    provider.enqueue(script.failure(providerError("invalid_response", "bad json")));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[0]!.id] }).done;
    expect(sleeps).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(stateOf(c, a.id, 0, revision)).toBe("failed");
  });

  it("AC-11: an unavailable model puts the run in Waiting, blocks later work, and resumes on Retry", async () => {
    const { c, revision, provider, run } = setup({ unavailable: ["m1"] });
    const a = run("m1");
    const b = run("m2");
    const waiting = until(c, (e) => e.type === "waiting");
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id, b.id] });
    const w = await waiting;
    expect(w.payload.code).toBe("model_unavailable");
    expect(c.snapshotJob(job.id).state).toBe("waiting");
    expect(c.snapshotRun(a.id).state).toBe("waiting");
    expect(provider.requests.map((r) => r.modelId)).toEqual(["m1"]); // m2 does not start

    provider.setUnavailable("m1", false);
    c.resolveWaiting(a.id, "retry");
    await done;
    expect(c.snapshotRun(a.id).state).toBe("completed");
    expect(c.snapshotRun(b.id).state).toBe("completed");
  });

  it("Skip model abandons the waiting model and moves on", async () => {
    const { c, revision, run } = setup({ unavailable: ["m1"] });
    const a = run("m1");
    const b = run("m2");
    const waiting = until(c, (e) => e.type === "waiting");
    const { done } = c.startJob({ revisionId: revision.id, runIds: [a.id, b.id] });
    await waiting;
    c.resolveWaiting(a.id, "skip");
    await done;
    expect(Object.values(c.snapshotRun(a.id).outputs).every((o) => o.state === "canceled")).toBe(true);
    expect(c.snapshotRun(b.id).state).toBe("completed");
  });

  it.each(["auth", "context_overflow", "connection"] as const)("%s errors stop the run in Waiting with the reason", async (code) => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.failure(providerError(code, `${code} problem`)));
    const a = run();
    const waiting = until(c, (e) => e.type === "waiting");
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id] });
    const w = await waiting;
    expect(w.payload).toMatchObject({ code, message: `${code} problem` });
    c.cancel({ kind: "job", jobId: job.id });
    await done;
    expect(provider.requests).toHaveLength(1);
    expect(c.snapshotJob(job.id).state).toBe("canceled");
  });

  it("fails a block before sending anything when it cannot fit the model's context", async () => {
    const { c, revision, provider, run } = setup();
    const a = run("tiny", { contextLimit: 2048, maxOutputTokens: 1900 });
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    expect(provider.requests).toHaveLength(0);
    expect(c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!.attempts[0]!.error?.code).toBe("preflight");
  });
});

describe("what counts as finished (AC-12)", () => {
  it.each([["length"], ["refusal"], ["unknown"]] as const)("finish reason %s needs review and is not used as context", async (reason) => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.translate("cut off", { reason }));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    const out = c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!;
    expect(out.state).toBe("needs_review");
    expect(out.attempts[0]).toMatchObject({ state: "needs_review", rawOutput: "cut off", finishReason: reason });
    expect(contextOf(provider.requests[1]!)).toMatchObject({ translation: null, translation_status: "unavailable" });
  });

  it("empty output is a failure, not a result", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue([{ t: "delta", text: "  \n" }, { t: "finish", reason: "stop" }]);
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    expect(stateOf(c, a.id, 0, revision)).toBe("failed");
  });

  it("an empty reply that hit the reply limit while thinking says so and how to fix it", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue([{ t: "finish", reason: "length", usage: { outputTokens: 1536 }, reasoningSeen: true }]);
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[0]!.id] }).done;
    const attempt = c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!.attempts[0]!;
    expect(attempt.state).toBe("failed");
    expect(attempt.error?.message).toMatch(/1536 tokens/);
    expect(attempt.error?.message).toMatch(/thinking/);
    expect(attempt.error?.message).toMatch(/Longest reply/);
    expect(attempt.finishReason).toBe("length");
  });

  it("other empty replies mention what the server reported", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue([{ t: "finish", reason: "stop" }]);
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[0]!.id] }).done;
    expect(c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!.attempts[0]!.error?.message).toMatch(/reported: stop/);
  });

  it("a reply that is the request written back is a failure, keeps the raw reply, and is not used as context", async () => {
    const { c, revision, provider, run } = setup();
    const echo = '{"glossary":[{"source":"太郎","target":"Taro"}],"context":{"source":"そうだね。」\n\n';
    provider.enqueue(script.translate(echo));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    const first = c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!;
    expect(first.state).toBe("failed");
    expect(first.versions).toEqual([]);
    expect(first.attempts[0]).toMatchObject({ state: "failed", draft: echo, rawOutput: echo, error: { code: "echoed_request", message: expect.stringContaining("repeated the request") } });
    // the next block is told the previous translation is not available instead of being handed the junk
    expect(contextOf(provider.requests[1]!)).toMatchObject({ translation: null, translation_status: "unavailable" });
    expect(c.snapshotRun(a.id).outputs[revision.blocks[1]!.id]!.state).toBe("succeeded");
  });

  it("the labelled form of an echo is caught too, and a retry can then succeed", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.translate("SOURCE_BLOCK:\nHe left."));
    const a = run();
    const blockId = revision.blocks[0]!.id;
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [blockId] }).done;
    expect(c.snapshotRun(a.id).outputs[blockId]!.state).toBe("failed");
    await c.retryBlock(a.id, blockId).done;
    const out = c.snapshotRun(a.id).outputs[blockId]!;
    expect(out.state).toBe("succeeded");
    expect(out.attempts.map((x) => x.state)).toEqual(["failed", "succeeded"]);
  });

  it("a normal translation that merely mentions the words is not mistaken for an echo", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.translate('He said, "The glossary is incomplete."'));
    const a = run();
    const blockId = revision.blocks[0]!.id;
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [blockId] }).done;
    expect(c.snapshotRun(a.id).outputs[blockId]!.state).toBe("succeeded");
  });

  it("a stream that just stops is a failure and keeps the partial text", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.disconnect("partial"));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    const out = c.snapshotRun(a.id).outputs[revision.blocks[0]!.id]!;
    expect(out.state).toBe("failed");
    expect(out.attempts[0]).toMatchObject({ draft: "partial", error: { code: "invalid_response" } });
  });

  it("accepting a reviewed block makes it usable context", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue(script.translate("cut off", { reason: "length" }));
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[0]!.id] }).done;
    c.acceptReview(a.id, revision.blocks[0]!.id);
    expect(stateOf(c, a.id, 0, revision)).toBe("succeeded");
    await c.startJob({ revisionId: revision.id, runIds: [a.id], blockIds: [revision.blocks[1]!.id] }).done;
    expect(contextOf(provider.requests[1]!)).toMatchObject({ translation: "cut off", translation_status: "available" });
  });
});

describe("edits, candidates and stale blocks", () => {
  it("AC-08: a manual edit survives a retry until the candidate is accepted", async () => {
    const { c, revision, provider, run } = setup();
    const a = run();
    const blockId = revision.blocks[0]!.id;
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    c.editBlock(a.id, blockId, "My edit");
    provider.enqueue(script.translate("Fresh try"));
    await c.retryBlock(a.id, blockId).done;

    let out = c.snapshotRun(a.id).outputs[blockId]!;
    expect(currentVersion(out)?.text).toBe("My edit");
    expect(out.candidate).toBeDefined();
    expect(out.versions.map((v) => [v.kind, v.text])).toEqual([["generated", "[m1] 一。\n\n"], ["manual", "My edit"], ["generated", "Fresh try"]]);

    c.keepCurrent(a.id, blockId);
    out = c.snapshotRun(a.id).outputs[blockId]!;
    expect(out.candidate).toBeUndefined();
    expect(currentVersion(out)?.text).toBe("My edit");
    expect(out.versions).toHaveLength(3);

    provider.enqueue(script.translate("Third try"));
    await c.retryBlock(a.id, blockId).done;
    c.acceptCandidate(a.id, blockId);
    out = c.snapshotRun(a.id).outputs[blockId]!;
    expect(currentVersion(out)?.text).toBe("Third try");
    expect(out.versions).toHaveLength(4);
  });

  it("a failed retry leaves the earlier result in place and usable", async () => {
    const { c, revision, provider, run } = setup();
    const a = run();
    const blockId = revision.blocks[1]!.id;
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    provider.enqueue(script.partialThenError("zz", providerError("invalid_response", "bad")));
    await c.retryBlock(a.id, blockId).done;
    const out = c.snapshotRun(a.id).outputs[blockId]!;
    expect(out.state).toBe("failed");
    expect(currentVersion(out)?.text).toBe("[m1] 二。\n\n");
    expect(out.candidate).toBeUndefined();
  });

  it("a stale check looks only at the context the next block actually received (amendment A2)", async () => {
    const long = "a".repeat(400);
    const { c, revision, run } = setup({ translate: () => long });
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    const first = revision.blocks[0]!.id;

    c.editBlock(a.id, first, "b" + long.slice(1)); // changed far from the end: outside the 256-token tail
    expect(stateOf(c, a.id, 1, revision)).toBe("succeeded");

    c.editBlock(a.id, first, long.slice(0, -1) + "z"); // changed inside the tail
    expect(stateOf(c, a.id, 1, revision)).toBe("stale");
    expect(stateOf(c, a.id, 2, revision)).toBe("succeeded"); // not a blanket cascade

    c.editBlock(a.id, first, long); // back to what block 2 saw
    expect(stateOf(c, a.id, 1, revision)).toBe("succeeded");
  });

  it("Retranslate downstream re-runs stale blocks in order, keeps old versions, then moves on", async () => {
    const { c, revision, provider, run } = setup({ translate: (r) => `T:${sourceOf(r)}:${contextOf(r).translation ?? "-"}` });
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    c.editBlock(a.id, revision.blocks[0]!.id, "short"); // block 2's context changes
    expect(stateOf(c, a.id, 1, revision)).toBe("stale");
    const before = provider.requests.length;
    await c.retranslateDownstream(a.id).done;
    expect(provider.requests.length).toBe(before + 1);
    const out = c.snapshotRun(a.id).outputs[revision.blocks[1]!.id]!;
    expect(out.versions).toHaveLength(2);
    expect(currentVersion(out)?.text).toContain(":short");
    expect(out.state).toBe("succeeded");
    expect(stateOf(c, a.id, 2, revision)).toBe("stale"); // block 2 changed, so block 3 is now behind
  });

  it("editing a block that is still streaming is rejected", async () => {
    const { c, revision, provider, run } = setup();
    provider.enqueue([{ t: "delta", text: "x" }, { t: "hang" }]);
    const a = run();
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id] });
    await until(c, (e) => e.type === "delta");
    expect(() => c.editBlock(a.id, revision.blocks[0]!.id, "nope")).toThrow();
    c.cancel({ kind: "job", jobId: job.id });
    await done;
  });
});

describe("saving progress", () => {
  it("saves after every finished request, before the next one is sent", async () => {
    const log: string[] = [];
    const { c, revision, provider, run } = setup({}, { checkpoint: async () => void log.push(`save@${provider.requests.length}`) });
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    expect(log).toEqual(["save@1", "save@2", "save@3", "save@4", "save@5"]);
  });

  it("stops sending requests when saving fails", async () => {
    let calls = 0;
    const { c, revision, provider, run } = setup({}, { checkpoint: async () => { if (++calls === 2) throw new Error("disk full"); } });
    const a = run();
    const { job, done } = c.startJob({ revisionId: revision.id, runIds: [a.id] });
    await done;
    expect(provider.requests).toHaveLength(2);
    const snap = c.snapshotJob(job.id);
    expect(snap.state).toBe("interrupted");
    expect(snap.stopReason).toMatch(/disk full/);
    expect(c.snapshotRun(a.id).state).toBe("interrupted");
  });

  it("resuming runs only the unfinished blocks and never regenerates finished ones", async () => {
    let calls = 0;
    const { c, revision, provider, run } = setup({}, { checkpoint: async () => { if (++calls === 2) throw new Error("disk full"); } });
    const a = run();
    await c.startJob({ revisionId: revision.id, runIds: [a.id] }).done;
    expect(provider.requests).toHaveLength(2);
    await c.retryUnfinished(a.id).done;
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests.map(sourceOf)).toEqual(["一。\n\n", "二。\n\n", "三。\n\n", "四。\n\n", "五。"]);
    expect(c.snapshotRun(a.id).state).toBe("completed");
  });
});
