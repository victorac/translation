import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { OpenAICompatibleProvider } from "./openai.js";
import type { GenerateEvent, GenerateRequest, ProviderConfig } from "./types.js";

/** Reads a whole reply: the events, the text from the deltas, and the one that ended it. */
async function collectStream(stream: AsyncIterable<GenerateEvent>) {
  const events: GenerateEvent[] = [];
  let text = "";
  let terminal: Exclude<GenerateEvent, { type: "delta" }> | undefined;
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "delta") text += ev.text;
    else terminal ??= ev;
  }
  return terminal ? { events, text, terminal } : { events, text };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
async function serve(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(seen);
      handler(req, res, seen);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, server };
}

const cfg = (baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "p", kind: "openai-compatible", baseUrl, ...extra });
const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  requestId: "r1",
  modelId: "qwen2.5-7b",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: '{"source_block":"こんにちは"}' },
  ],
  temperature: 0.2,
  maxOutputTokens: 1536,
  stream: true,
  ...over,
});
const live = () => new AbortController();
const chunk = (content: string | null, finish: string | null = null, extra: object = {}) => ({
  choices: [{ index: 0, delta: content === null ? { role: "assistant" } : { content }, finish_reason: finish }],
  ...extra,
});
const sse = (res: ServerResponse, obj: unknown) => res.write(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`);
const startSse = (res: ServerResponse) => res.writeHead(200, { "content-type": "text/event-stream" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = async (p: OpenAICompatibleProvider, c: ProviderConfig, r: GenerateRequest = req()) => collectStream(p.generate(c, r, live().signal));

describe("model discovery", () => {
  it("lists model ids, tolerates extra fields, and does not claim anything is loaded", async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "qwen2.5-7b-instruct", object: "model", owned_by: "x", extra: 1 }, { id: "gemma-2-9b" }, { nope: true }] }));
    });
    const models = await new OpenAICompatibleProvider().listModels(cfg(s.baseUrl + "/"), live().signal);
    expect(models).toEqual([{ id: "qwen2.5-7b-instruct", label: "qwen2.5-7b-instruct" }, { id: "gemma-2-9b", label: "gemma-2-9b" }]);
    expect(s.requests[0]).toMatchObject({ method: "GET", url: "/v1/models" });
  });

  it("sends the API key only as a bearer header, from the credential store", async () => {
    const s = await serve((_q, res) => (res.writeHead(200), res.end('{"data":[]}')));
    const p = new OpenAICompatibleProvider({ getCredential: (ref) => (ref === "key-1" ? "sk-secret" : undefined) });
    await p.health(cfg(s.baseUrl, { credentialRef: "key-1" }), live().signal);
    expect(s.requests[0]!.headers.authorization).toBe("Bearer sk-secret");
    await p.health(cfg(s.baseUrl), live().signal);
    expect(s.requests[1]!.headers.authorization).toBeUndefined();
  });

  it("explains a wrong address and an unreachable server", async () => {
    const wrong = await serve((_q, res) => (res.writeHead(404), res.end("Not found")));
    await expect(new OpenAICompatibleProvider().listModels(cfg(wrong.baseUrl), live().signal)).rejects.toMatchObject({ providerError: { message: expect.stringContaining("/v1") } });
    const html = await serve((_q, res) => (res.writeHead(200), res.end("<html></html>")));
    await expect(new OpenAICompatibleProvider().listModels(cfg(html.baseUrl), live().signal)).rejects.toMatchObject({ providerError: { code: "invalid_response" } });
    const dead = await serve((_q, res) => res.end());
    const url = dead.baseUrl;
    await new Promise<void>((r) => dead.server.close(() => r()));
    await expect(new OpenAICompatibleProvider().listModels(cfg(url), live().signal)).rejects.toMatchObject({
      providerError: { code: "connection", message: expect.stringMatching(/Start the LM Studio server/) },
    });
  });
});

describe("streaming generation", () => {
  it("sends the documented request and assembles the translation", async () => {
    const s = await serve((_q, res) => {
      startSse(res);
      sse(res, chunk(null));
      sse(res, chunk("Hel"));
      sse(res, chunk("lo"));
      sse(res, chunk(""));
      sse(res, chunk(null, "stop", { usage: { prompt_tokens: 40, completion_tokens: 2 } }));
      sse(res, "[DONE]");
      res.end();
    });
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.text).toBe("Hello");
    expect(out.terminal).toEqual({ type: "finish", reason: "stop", usage: { inputTokens: 40, outputTokens: 2 } });
    expect(out.events.filter((e) => e.type === "delta")).toHaveLength(2);
    expect(s.requests[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
    expect(JSON.parse(s.requests[0]!.body)).toEqual({
      model: "qwen2.5-7b",
      messages: req().messages,
      temperature: 0.2,
      max_tokens: 1536,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(s.requests[0]!.headers.accept).toBe("text/event-stream");
  });

  it("ignores reasoning fields and unknown fields", async () => {
    const s = await serve((_q, res) => {
      startSse(res);
      sse(res, { choices: [{ delta: { reasoning_content: "thinking about it", content: null }, finish_reason: null }] });
      sse(res, { id: "x", model: "m", choices: [{ delta: { content: "Answer", weird: 1 }, finish_reason: null }], timings: {} });
      sse(res, chunk(null, "stop"));
      res.end();
    });
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.text).toBe("Answer");
  });

  it("AC-05: any split of the network bytes gives the same text", async () => {
    const text = "やっぱり、そうなんだね 👍🏽 𠮷野家";
    const frames = [...Array.from(text).map((c) => chunk(c)), chunk(null, "stop")].map((o) => `data: ${JSON.stringify(o)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const bytes = new TextEncoder().encode(frames);
    const viaFetch = (cuts: number[]): typeof fetch => async () => {
      const points = [...new Set(cuts)].sort((a, b) => a - b).filter((c) => c > 0 && c < bytes.length);
      const parts: Uint8Array[] = [];
      let from = 0;
      for (const p of [...points, bytes.length]) (parts.push(bytes.slice(from, p)), (from = p));
      return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await fc.assert(
      fc.asyncProperty(fc.array(fc.nat(bytes.length), { maxLength: 30 }), async (cuts) => {
        const out = await run(new OpenAICompatibleProvider({ fetch: viaFetch(cuts) }), cfg("http://localhost:1234/v1"));
        expect(out.text).toBe(text);
        expect(out.terminal).toMatchObject({ type: "finish", reason: "stop" });
      }),
      { numRuns: 150 },
    );
  });

  it.each([
    ["length", "length"],
    ["content_filter", "refusal"],
    ["tool_calls", "unknown"],
  ])("maps finish_reason %s to %s", async (given, expected) => {
    const s = await serve((_q, res) => (startSse(res), sse(res, chunk("cut off")), sse(res, chunk(null, given)), res.end()));
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "finish", reason: expected });
    expect(out.text).toBe("cut off");
  });

  it("a thinking model that spends its whole reply limit thinking ends empty, length, with reasoning flagged", async () => {
    const s = await serve((_q, res) => {
      startSse(res);
      sse(res, { choices: [{ delta: { reasoning_content: "Let me think about this..." }, finish_reason: null }] });
      sse(res, { choices: [{ delta: { reasoning_content: " still thinking" }, finish_reason: null }] });
      sse(res, chunk(null, "length", { usage: { prompt_tokens: 50, completion_tokens: 1536 } }));
      res.end();
    });
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.text).toBe("");
    expect(out.terminal).toEqual({ type: "finish", reason: "length", usage: { inputTokens: 50, outputTokens: 1536 }, reasoningSeen: true });
  });

  it("a long think does not trip the wait-for-first-text timeout", async () => {
    const s = await serve((_q, res) => {
      startSse(res);
      const t = setInterval(() => sse(res, { choices: [{ delta: { reasoning_content: "hmm " }, finish_reason: null }] }), 30);
      setTimeout(() => {
        clearInterval(t);
        sse(res, chunk("Done"));
        sse(res, chunk(null, "stop"));
        res.end();
      }, 400);
    });
    const out = await run(new OpenAICompatibleProvider({ timeouts: { headersMs: 500, firstContentMs: 150, idleMs: 200, totalMs: 5000 } }), cfg(s.baseUrl));
    expect(out.text).toBe("Done");
    expect(out.terminal).toMatchObject({ type: "finish", reason: "stop", reasoningSeen: true });
  });

  it("reports a refusal field as a refusal", async () => {
    const s = await serve((_q, res) => (startSse(res), sse(res, { choices: [{ delta: { refusal: "I can't help with that." }, finish_reason: null }] }), sse(res, chunk(null, "stop")), res.end()));
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "finish", reason: "refusal" });
    expect(out.text).toBe("");
  });

  it("a stream that stops without a finish reason is an error, and the draft is kept", async () => {
    const s = await serve((_q, res) => (startSse(res), sse(res, chunk("half")), res.end()));
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.text).toBe("half");
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "invalid_response", message: expect.stringContaining("finished") } });
  });

  it("a connection dropped mid-reply is an error with the draft kept", async () => {
    const s = await serve((_q, res) => {
      startSse(res);
      sse(res, chunk("partial"));
      setTimeout(() => res.socket?.destroy(), 30);
    });
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.text).toBe("partial");
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "connection", message: expect.stringContaining("incomplete") } });
  });

  it("a server error sent inside the stream becomes an error", async () => {
    const s = await serve((_q, res) => (startSse(res), sse(res, chunk("a")), sse(res, { error: { message: "Model unloaded: no models loaded" } }), res.end()));
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "model_unavailable" } });
  });

  it("stops and reports when the reply exceeds the size cap", async () => {
    const s = await serve((_q, res) => {
      startSse(res);
      for (let i = 0; i < 50; i++) sse(res, chunk("x".repeat(100)));
      sse(res, chunk(null, "stop"));
      res.end();
    });
    const out = await run(new OpenAICompatibleProvider({ maxRawBytes: 1000 }), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "invalid_response", message: expect.stringContaining("MiB") } });
  });
});

describe("non-streaming generation", () => {
  it("reads the whole reply and ignores reasoning text", async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello there", reasoning_content: "hmm" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl), req({ stream: false }));
    expect(out.text).toBe("Hello there");
    expect(out.terminal).toEqual({ type: "finish", reason: "stop", usage: { inputTokens: 5, outputTokens: 2 }, reasoningSeen: true });
    expect(JSON.parse(s.requests[0]!.body).stream).toBe(false);
  });

  it("flags missing text and invalid JSON", async () => {
    const a = await serve((_q, res) => (res.writeHead(200), res.end('{"choices":[{"message":{},"finish_reason":"stop"}]}')));
    expect((await run(new OpenAICompatibleProvider(), cfg(a.baseUrl), req({ stream: false }))).terminal).toMatchObject({ error: { code: "invalid_response" } });
    const b = await serve((_q, res) => (res.writeHead(200), res.end("nope")));
    expect((await run(new OpenAICompatibleProvider(), cfg(b.baseUrl), req({ stream: false }))).terminal).toMatchObject({ error: { code: "invalid_response" } });
  });
});

describe("HTTP errors (failure table)", () => {
  const status = async (code: number, body: string, headers: Record<string, string> = {}) => {
    const s = await serve((_q, res) => (res.writeHead(code, { "content-type": "application/json", ...headers }), res.end(body)));
    return (await run(new OpenAICompatibleProvider(), cfg(s.baseUrl))).terminal as { type: "error"; error: { code: string; retryable: boolean; httpStatus?: number; retryAfterMs?: number; message: string } };
  };

  it("401 and 403 are auth errors that never echo the key", async () => {
    for (const code of [401, 403]) {
      const t = await status(code, '{"error":{"message":"Invalid API key sk-secret-123"}}');
      expect(t.error).toMatchObject({ code: "auth", retryable: false, httpStatus: code });
      expect(t.error.message).not.toContain("sk-secret-123");
    }
  });

  it("429 is retryable and carries Retry-After", async () => {
    expect((await status(429, '{"error":"slow down"}', { "retry-after": "2" })).error).toMatchObject({ code: "rate_limit", retryable: true, retryAfterMs: 2000, httpStatus: 429 });
  });

  it("5xx is retryable, but out-of-memory is not", async () => {
    expect((await status(503, '{"error":{"message":"busy"}}')).error).toMatchObject({ code: "server", retryable: true });
    const oom = (await status(500, '{"error":{"message":"CUDA out of memory"}}')).error;
    expect(oom).toMatchObject({ code: "server", retryable: false });
    expect(oom.message).toMatch(/smaller model|smaller context/);
  });

  it("context overflow is recognized and not retried", async () => {
    const t = await status(400, '{"error":{"message":"Trying to keep the first 4200 tokens when context overflows"}}');
    expect(t.error).toMatchObject({ code: "context_overflow", retryable: false });
    expect((await status(400, '{"error":"The prompt is too long for the context window"}')).error.code).toBe("context_overflow");
  });

  it("unknown or unloaded models are model_unavailable with a next step", async () => {
    for (const body of ['{"error":{"message":"Model not found: foo"}}', '{"error":"No models loaded. Please load a model in the developer page."}']) {
      const t = await status(404, body);
      expect(t.error).toMatchObject({ code: "model_unavailable", retryable: false });
      expect(t.error.message).toMatch(/Load the model/);
    }
    expect((await status(400, '{"error":{"message":"unknown model"}}')).error.code).toBe("model_unavailable");
  });

  it("other 4xx errors are plain failures", async () => {
    expect((await status(422, '{"error":{"message":"bad field"}}')).error).toMatchObject({ code: "invalid_response", retryable: false, message: "bad field" });
    expect((await status(418, "teapot")).error.message).toBe("teapot");
  });
});

describe("safety", () => {
  it("never follows a redirect to another host", async () => {
    const other = await serve((_q, res) => (res.writeHead(200), res.end("{}")));
    const s = await serve((_q, res) => (res.writeHead(307, { location: other.baseUrl + "/chat/completions" }), res.end()));
    const out = await run(new OpenAICompatibleProvider(), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "error", error: { message: expect.stringContaining("redirect") } });
    expect(other.requests).toHaveLength(0);
  });

  it("refuses a remote address without approval and makes no request", async () => {
    let calls = 0;
    const p = new OpenAICompatibleProvider({ fetch: (async () => (calls++, new Response("{}"))) as typeof fetch });
    const out = await run(p, cfg("http://192.168.1.20:1234/v1"));
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "connection", message: expect.stringContaining("not on this computer") } });
    expect(calls).toBe(0);
    await expect(p.listModels(cfg("https://api.example.com/v1"), live().signal)).rejects.toMatchObject({ providerError: { code: "connection" } });
    expect(calls).toBe(0);
  });

  it("allows an approved remote host", async () => {
    let calledUrl = "";
    const p = new OpenAICompatibleProvider({
      allowedRemoteHosts: ["192.168.1.20:1234"],
      fetch: (async (url: string) => ((calledUrl = url), new Response('{"data":[{"id":"m"}]}'))) as unknown as typeof fetch,
    });
    expect(await p.listModels(cfg("http://192.168.1.20:1234/v1"), live().signal)).toEqual([{ id: "m", label: "m" }]);
    expect(calledUrl).toBe("http://192.168.1.20:1234/v1/models");
  });

  it("rejects addresses with embedded credentials", async () => {
    const out = await run(new OpenAICompatibleProvider(), cfg("http://user:pw@localhost:1234/v1"));
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "connection" } });
  });
});

describe("timeouts and cancel", () => {
  const fast = { headersMs: 80, firstContentMs: 150, idleMs: 80, totalMs: 2000 };

  it("times out waiting for headers, and says what to do if the model is loading", async () => {
    const s = await serve(() => {});
    const out = await run(new OpenAICompatibleProvider({ timeouts: fast }), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "timeout", message: expect.stringContaining("loading the model") } });
  });

  it("times out waiting for the first text", async () => {
    const s = await serve((_q, res) => (startSse(res), sse(res, chunk(null)), void 0));
    const out = await run(new OpenAICompatibleProvider({ timeouts: fast }), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "timeout", message: expect.stringContaining("No text arrived") } });
  });

  it("times out when the stream goes quiet, keeping the draft", async () => {
    const s = await serve((_q, res) => (startSse(res), sse(res, chunk("so far"))));
    const out = await run(new OpenAICompatibleProvider({ timeouts: fast }), cfg(s.baseUrl));
    expect(out.text).toBe("so far");
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "timeout", message: expect.stringContaining("went quiet") } });
  });

  it("stops a request that keeps trickling past the total limit", async () => {
    const s = await serve((_q, res) => {
      startSse(res);
      const t = setInterval(() => sse(res, chunk(".")), 20);
      res.on("close", () => clearInterval(t));
    });
    const out = await run(new OpenAICompatibleProvider({ timeouts: { ...fast, totalMs: 300 } }), cfg(s.baseUrl));
    expect(out.terminal).toMatchObject({ type: "error", error: { code: "timeout", message: expect.stringContaining("longer than") } });
  });

  it("cancel mid-stream ends with canceled and closes the connection to the server", async () => {
    let closed = false;
    const s = await serve((_q, res) => {
      startSse(res);
      sse(res, chunk("one"));
      res.on("close", () => (closed = true));
    });
    const ac = live();
    const stream = new OpenAICompatibleProvider().generate(cfg(s.baseUrl), req(), ac.signal);
    const events = [];
    for await (const ev of stream) {
      events.push(ev);
      if (ev.type === "delta") ac.abort();
    }
    expect(events.map((e) => e.type)).toEqual(["delta", "error"]);
    expect(events[1]).toMatchObject({ error: { code: "canceled" } });
    for (let i = 0; i < 40 && !closed; i++) await sleep(25);
    expect(closed).toBe(true);
  });

  it("cancel before the server answers", async () => {
    const s = await serve(() => {});
    const ac = live();
    setTimeout(() => ac.abort(), 30);
    const out = await collectStream(new OpenAICompatibleProvider().generate(cfg(s.baseUrl), req(), ac.signal));
    expect(out.terminal).toMatchObject({ error: { code: "canceled" } });
  });

  it("a timeout is never reported as a cancel and a cancel never as a timeout", async () => {
    const s = await serve(() => {});
    const ac = live();
    setTimeout(() => ac.abort(), 20);
    const out = await collectStream(new OpenAICompatibleProvider({ timeouts: fast }).generate(cfg(s.baseUrl), req(), ac.signal));
    expect(out.terminal).toMatchObject({ error: { code: "canceled" } });
  });
});
