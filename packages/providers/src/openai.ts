import { checkEndpointAllowed, endpointUrl } from "./endpoint.js";
import { providerError, ProviderRequestError } from "./contract.js";
import { SseDecoder } from "./sse.js";
import type {
  Capabilities,
  FinishReason,
  GenerateEvent,
  GenerateRequest,
  ModelInfo,
  ProviderConfig,
  ProviderError,
  TranslationProvider,
} from "./types.js";

export const OPENAI_COMPATIBLE_KIND = "openai-compatible";

export interface Timeouts {
  /** Connecting and receiving the response headers. */
  headersMs: number;
  /** After headers, waiting for the first piece of translated text. */
  firstContentMs: number;
  /** Silence between pieces once text is flowing. */
  idleMs: number;
  /** The whole request. */
  totalMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = { headersMs: 15_000, firstContentMs: 180_000, idleMs: 90_000, totalMs: 600_000 };
export const MAX_RAW_BYTES = 2 * 1024 * 1024;

export interface OpenAICompatibleOptions {
  /** Looks up the API key for a credential reference. Never logged, never stored in projects. */
  getCredential?: (ref: string) => Promise<string | undefined> | string | undefined;
  /** Hosts (host:port) the user has explicitly allowed besides this computer. */
  allowedRemoteHosts?: Iterable<string>;
  timeouts?: Partial<Timeouts>;
  maxRawBytes?: number;
  fetch?: typeof fetch;
}

/**
 * Talks to any server that offers the OpenAI-style /models and /chat/completions endpoints, such as LM Studio.
 * Only that small subset is used, and nothing is assumed beyond it (no model loading, no token counting).
 */
export class OpenAICompatibleProvider implements TranslationProvider {
  readonly kind = OPENAI_COMPATIBLE_KIND;
  private readonly timeouts: Timeouts;
  private readonly allowed: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRaw: number;

  constructor(private readonly options: OpenAICompatibleOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.allowed = new Set(options.allowedRemoteHosts ?? []);
    this.fetchImpl = options.fetch ?? ((...a) => fetch(...a));
    this.maxRaw = options.maxRawBytes ?? MAX_RAW_BYTES;
  }

  async capabilities(): Promise<Capabilities> {
    return { streaming: true, tokenCounting: false, modelResidency: false, cancellation: "client-only" };
  }

  /** The connection test: asks the server for its model list. */
  async health(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    await this.listModels(config, signal);
  }

  async listModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelInfo[]> {
    const target = this.target(config);
    if (!target.ok) throw new ProviderRequestError(target.error);
    const run = new Request_(signal, { headersMs: this.timeouts.headersMs, totalMs: this.timeouts.headersMs * 2 });
    try {
      const res = await this.send("GET", endpointUrl(target.baseUrl, "models"), undefined, config, run, false);
      if (!res.ok) throw new ProviderRequestError(res.error);
      const text = await readLimited(res.response, 2 * 1024 * 1024);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderRequestError(providerError("invalid_response", "The server's model list was not valid JSON. Check that the address ends in /v1 and points at an OpenAI-compatible server."));
      }
      const data = (json as { data?: unknown })?.data;
      if (!Array.isArray(data)) {
        throw new ProviderRequestError(providerError("invalid_response", "The server's model list had an unexpected shape. Check that the address ends in /v1."));
      }
      const models: ModelInfo[] = [];
      for (const m of data) {
        const id = (m as { id?: unknown })?.id;
        if (typeof id === "string" && id !== "") models.push({ id, label: id });
      }
      return models;
    } catch (e) {
      if (e instanceof ProviderRequestError) throw e;
      throw new ProviderRequestError(run.explain(e, target.baseUrl));
    } finally {
      run.dispose();
    }
  }

  async *generate(config: ProviderConfig, request: GenerateRequest, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
    const target = this.target(config);
    if (!target.ok) {
      yield { type: "error", error: target.error };
      return;
    }
    const run = new Request_(signal, this.timeouts);
    try {
      const body = JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxOutputTokens,
        stream: request.stream,
      });
      const res = await this.send("POST", endpointUrl(target.baseUrl, "chat/completions"), body, config, run, request.stream);
      if (!res.ok) {
        yield { type: "error", error: res.error };
        return;
      }
      run.headersReceived();
      yield* request.stream ? this.readStream(res.response, run, target.baseUrl) : this.readWhole(res.response, run);
    } catch (e) {
      yield { type: "error", error: run.explain(e, target.baseUrl) };
    } finally {
      run.dispose();
    }
  }

  // ---- internals ----

  private target(config: ProviderConfig): { ok: true; baseUrl: string } | { ok: false; error: ProviderError } {
    const check = checkEndpointAllowed(config.baseUrl, this.allowed);
    if (!check.ok) return { ok: false, error: providerError("connection", check.message) };
    return { ok: true, baseUrl: check.baseUrl };
  }

  private async send(
    method: "GET" | "POST",
    url: string,
    body: string | undefined,
    config: ProviderConfig,
    run: Request_,
    streaming: boolean,
  ): Promise<{ ok: true; response: Response } | { ok: false; error: ProviderError }> {
    const headers: Record<string, string> = { accept: streaming ? "text/event-stream" : "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (config.credentialRef) {
      const key = await this.options.getCredential?.(config.credentialRef);
      if (key) headers["authorization"] = `Bearer ${key}`;
    }
    run.startHeadersTimer();
    // Redirects are never followed: a server must not be able to send the text somewhere else.
    const response = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: run.signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      const where = response.headers.get("location");
      return { ok: false, error: providerError("server", `The server tried to redirect to ${where ?? "another address"}. Redirects are not followed, so check the address in the connection settings.`) };
    }
    if (!response.ok) return { ok: false, error: await httpError(response) };
    return { ok: true, response };
  }

  private async *readWhole(response: Response, run: Request_): AsyncGenerator<GenerateEvent> {
    run.startContentTimers(false);
    const text = await readLimited(response, this.maxRaw);
    let json: { choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown }[]; usage?: Usage; error?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      yield { type: "error", error: providerError("invalid_response", "The server's reply was not valid JSON.") };
      return;
    }
    if (json.error) {
      yield { type: "error", error: classifyMessage(messageOf(json.error), 500) };
      return;
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      yield { type: "error", error: providerError("invalid_response", "The server's reply had no text in it.") };
      return;
    }
    if (content !== "") yield { type: "delta", text: content };
    yield finishEvent(mapFinish(choice?.finish_reason), json.usage, hasText(choice?.message?.reasoning_content) || hasText(choice?.message?.reasoning));
  }

  private async *readStream(response: Response, run: Request_, baseUrl: string): AsyncGenerator<GenerateEvent> {
    if (!response.body) {
      yield { type: "error", error: providerError("invalid_response", "The server sent an empty reply.") };
      return;
    }
    run.startContentTimers(true);
    const reader = response.body.getReader();
    const decoder = new SseDecoder();
    let bytes = 0;
    let finish: FinishReason | undefined;
    let usage: Usage | undefined;
    let sawDone = false;
    let refused = false;
    let reasoningSeen = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (!done) run.chunkReceived();
        for (const msg of done ? decoder.end() : decoder.push(value)) {
          if (msg.data === "[DONE]") {
            sawDone = true;
            continue;
          }
          let json: StreamChunk;
          try {
            json = JSON.parse(msg.data) as StreamChunk;
          } catch {
            yield { type: "error", error: providerError("invalid_response", "The server sent a malformed streaming message.") };
            return;
          }
          if (json.error) {
            yield { type: "error", error: classifyMessage(messageOf(json.error), 500) };
            return;
          }
          if (json.usage) usage = json.usage;
          const choice = json.choices?.[0];
          if (!choice) continue;
          // Only `content` is the translation. Reasoning fields are ignored on purpose.
          const text = choice.delta?.content;
          if (typeof text === "string" && text !== "") {
            bytes += new TextEncoder().encode(text).length;
            if (bytes > this.maxRaw) {
              yield { type: "error", error: providerError("invalid_response", `The reply grew past ${this.maxRaw / (1024 * 1024)} MiB and was stopped. Lower the output limit or check the model.`) };
              return;
            }
            run.contentReceived();
            yield { type: "delta", text };
          }
          if (typeof choice.delta?.refusal === "string" && choice.delta.refusal !== "") refused = true;
          if (hasText(choice.delta?.reasoning_content) || hasText(choice.delta?.reasoning)) {
            reasoningSeen = true;
            // Thinking time counts as activity, so a long think is not mistaken for a stalled server.
            run.contentReceived();
          }
          if (typeof choice.finish_reason === "string") finish = mapFinish(choice.finish_reason);
        }
        if (done) break;
      }
    } catch (e) {
      yield { type: "error", error: run.explain(e, baseUrl, true) };
      return;
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (finish === undefined) {
      yield {
        type: "error",
        error: providerError(
          "invalid_response",
          sawDone || !decoder.hasIncompleteMessage
            ? "The server ended the reply without saying it was finished, so the text may be incomplete."
            : "The connection ended in the middle of the reply, so the text is incomplete.",
        ),
      };
      return;
    }
    yield finishEvent(refused ? "refusal" : finish, usage, reasoningSeen);
  }
}

// ---- helpers ----

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
interface StreamChunk {
  choices?: { delta?: { content?: unknown; refusal?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown }[];
  usage?: Usage;
  error?: unknown;
}

function finishEvent(reason: FinishReason, usage?: Usage, reasoningSeen = false): GenerateEvent {
  const u: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof usage?.prompt_tokens === "number") u.inputTokens = usage.prompt_tokens;
  if (typeof usage?.completion_tokens === "number") u.outputTokens = usage.completion_tokens;
  return { type: "finish", reason, ...(Object.keys(u).length ? { usage: u } : {}), ...(reasoningSeen ? { reasoningSeen: true } : {}) };
}

const hasText = (v: unknown): boolean => typeof v === "string" && v !== "";

function mapFinish(reason: unknown): FinishReason {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "refusal";
  return "unknown";
}

const messageOf = (err: unknown): string => {
  if (typeof err === "string") return err;
  const m = (err as { message?: unknown })?.message;
  return typeof m === "string" ? m : "The server reported an error.";
};

/** Maps a server's error text to what the user can do about it. */
export function classifyMessage(message: string, status: number): ProviderError {
  const m = message.toLowerCase();
  if (/no models? (are )?loaded|model.*(not found|not loaded|unknown|does not exist|is not available)|(unknown|invalid|no such) model/.test(m)) {
    return providerError("model_unavailable", `${message} Load the model in LM Studio, check the model name, then Retry.`, { httpStatus: status });
  }
  if (/context|too many tokens|prompt is too long|exceeds the (available|maximum)|n_ctx|token limit/.test(m)) {
    return providerError("context_overflow", message, { httpStatus: status });
  }
  if (/out of memory|\boom\b|insufficient (memory|vram)|failed to allocate|not enough (memory|vram)/.test(m)) {
    return providerError("server", `${message} The model ran out of memory. Try a smaller model or quantization, a smaller context, or move fewer layers to the GPU.`, { httpStatus: status, retryable: false });
  }
  if (status === 401 || status === 403) return providerError("auth", message, { httpStatus: status });
  if (status === 429) return providerError("rate_limit", message, { httpStatus: status });
  if (status >= 500) return providerError("server", message, { httpStatus: status });
  return providerError("invalid_response", message, { httpStatus: status, retryable: false });
}

async function httpError(res: Response): Promise<ProviderError> {
  let text = "";
  try {
    text = (await readLimited(res, 8192).catch(() => "")).trim();
  } catch {
    /* ignore */
  }
  let message = text;
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (j.error !== undefined) message = messageOf(j.error);
  } catch {
    /* plain text body */
  }
  const status = res.status;
  if (message === "") message = `The server answered ${status} ${res.statusText}`.trim();
  if (status === 401 || status === 403) {
    return providerError("auth", `The server refused the request (${status}). Check the API key in the connection settings.`, { httpStatus: status });
  }
  if (status === 404 && !/model/i.test(message)) {
    return providerError("invalid_response", "The server has no such address (404). Check that the address ends in /v1.", { httpStatus: 404, retryable: false });
  }
  const err = classifyMessage(message, status);
  if (status === 429) {
    const ra = retryAfterMs(res.headers.get("retry-after"));
    if (ra !== undefined) err.retryAfterMs = ra;
  }
  return err;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

class SizeLimit extends Error {}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      void reader.cancel().catch(() => {});
      throw new SizeLimit(`The reply was larger than ${limit} bytes.`);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Bookkeeping for one request: the four timeouts, cancel from the caller, and turning whatever
 * went wrong into a message about the actual cause.
 */
class Request_ {
  private readonly controller = new AbortController();
  private reason: ProviderError | undefined;
  private headersTimer: ReturnType<typeof setTimeout> | undefined;
  private contentTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private totalTimer: ReturnType<typeof setTimeout> | undefined;
  private haveContent = false;
  private readonly onCallerAbort = () => this.controller.abort();

  constructor(
    private readonly caller: AbortSignal,
    private readonly t: Pick<Timeouts, "headersMs" | "totalMs"> & Partial<Timeouts>,
  ) {
    if (caller.aborted) this.controller.abort();
    else caller.addEventListener("abort", this.onCallerAbort, { once: true });
    this.totalTimer = setTimeout(
      () => this.stop(providerError("timeout", `The request took longer than ${Math.round(t.totalMs / 1000)} seconds and was stopped.`)),
      t.totalMs,
    );
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  startHeadersTimer(): void {
    this.headersTimer = setTimeout(
      () =>
        this.stop(
          providerError(
            "timeout",
            `The server did not answer within ${Math.round(this.t.headersMs / 1000)} seconds. If LM Studio is still loading the model, wait until it finishes, then Retry.`,
          ),
        ),
      this.t.headersMs,
    );
  }

  headersReceived(): void {
    clearTimeout(this.headersTimer);
  }

  startContentTimers(streaming: boolean): void {
    this.headersReceived();
    const first = this.t.firstContentMs ?? DEFAULT_TIMEOUTS.firstContentMs;
    this.contentTimer = setTimeout(
      () => this.stop(providerError("timeout", `No text arrived within ${Math.round(first / 1000)} seconds. The model may still be loading or stuck. You can Retry.`)),
      first,
    );
    if (streaming) this.armIdle();
  }

  chunkReceived(): void {
    if (this.haveContent) this.armIdle();
  }

  contentReceived(): void {
    if (!this.haveContent) {
      this.haveContent = true;
      clearTimeout(this.contentTimer);
    }
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.haveContent) return;
    const idle = this.t.idleMs ?? DEFAULT_TIMEOUTS.idleMs;
    this.idleTimer = setTimeout(
      () => this.stop(providerError("timeout", `The server went quiet for ${Math.round(idle / 1000)} seconds mid-reply. The text so far is kept as an incomplete draft.`)),
      idle,
    );
  }

  private stop(reason: ProviderError): void {
    this.reason ??= reason;
    this.controller.abort();
  }

  dispose(): void {
    for (const t of [this.headersTimer, this.contentTimer, this.idleTimer, this.totalTimer]) clearTimeout(t);
    this.caller.removeEventListener("abort", this.onCallerAbort);
  }

  /** Works out why a request failed: canceled by the user, a timeout, the size limit, or the network. */
  explain(e: unknown, baseUrl: string, midStream = false): ProviderError {
    if (this.caller.aborted) return providerError("canceled", "Request canceled.");
    if (this.reason) return this.reason;
    if (e instanceof SizeLimit) return providerError("invalid_response", e.message);
    const code = (e as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ?? (e as { code?: unknown })?.code;
    if (midStream) {
      return providerError("connection", "The connection to the server was lost in the middle of the reply, so the text is incomplete.");
    }
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND" || code === "EAI_AGAIN" || e instanceof TypeError) {
      return providerError("connection", `Could not connect to ${baseUrl}. Start the LM Studio server (Developer tab) and check the address, then Retry.`);
    }
    return providerError("server", e instanceof Error && e.message ? e.message : "Unexpected failure talking to the server.");
  }
}
