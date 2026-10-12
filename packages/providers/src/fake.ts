import { providerError, ProviderRequestError } from "./contract.js";
import type {
  Capabilities,
  ChatMessage,
  FinishReason,
  GenerateEvent,
  GenerateRequest,
  ModelInfo,
  ProviderConfig,
  ProviderError,
  TranslationProvider,
} from "./types.js";

/** A latch a test opens by hand, to pin down exactly where a race happens. */
export interface Gate {
  readonly isOpen: boolean;
  open(): void;
  /** Resolves true when opened, false if the signal aborts first. */
  wait(signal?: AbortSignal): Promise<boolean>;
}

export function createGate(): Gate {
  let isOpen = false;
  const waiters = new Set<() => void>();
  return {
    get isOpen() {
      return isOpen;
    },
    open() {
      isOpen = true;
      for (const w of [...waiters]) w();
    },
    wait(signal) {
      if (isOpen) return Promise.resolve(true);
      if (signal?.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const done = (v: boolean) => {
          waiters.delete(onOpen);
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        };
        const onOpen = () => done(true);
        const onAbort = () => done(false);
        waiters.add(onOpen);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export type Step =
  | { t: "delta"; text: string }
  | { t: "wait"; ms: number }
  | { t: "gate"; gate: Gate }
  /** Never completes on its own; ends only by abort. */
  | { t: "hang" }
  | { t: "finish"; reason: FinishReason; usage?: { inputTokens?: number; outputTokens?: number }; reasoningSeen?: boolean }
  | { t: "error"; error: ProviderError }
  /** An adapter bug or raw network rejection: thrown, not yielded. */
  | { t: "throw"; error: unknown };

export type Script = Step[];

/** Splits by Unicode scalar so a chunk never separates a surrogate pair. */
export function chunkText(text: string, size: number): string[] {
  const scalars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < scalars.length; i += size) out.push(scalars.slice(i, i + size).join(""));
  return out;
}

export const script = {
  /** Deltas of `text` then a clean finish. */
  translate(text: string, o: { chunk?: number; reason?: FinishReason } = {}): Script {
    return [
      ...chunkText(text, o.chunk ?? 4).map((t): Step => ({ t: "delta", text: t })),
      { t: "finish", reason: o.reason ?? "stop" },
    ];
  },
  /** Partial output, then a failure (AC-07). */
  partialThenError(partial: string, error: ProviderError): Script {
    return [{ t: "delta", text: partial }, { t: "error", error }];
  },
  failure(error: ProviderError): Script {
    return [{ t: "error", error }];
  },
  /** Partial output, then silence: the stream just stops with no finish event. */
  disconnect(partial: string): Script {
    return [{ t: "delta", text: partial }];
  },
};

/** Counts overlapping generate() calls across one or more providers (spec: one active request globally). */
export class ConcurrencyProbe {
  active = 0;
  max = 0;
  started = 0;
  enter(): void {
    this.started++;
    this.max = Math.max(this.max, ++this.active);
  }
  exit(): void {
    this.active--;
  }
}

export interface FakeProviderOptions {
  kind?: string;
  models?: ModelInfo[];
  capabilities?: Partial<Capabilities>;
  /** Model ids that answer `model_unavailable`. Can be changed later with setUnavailable. */
  unavailable?: Iterable<string>;
  /** Default responder text. Receives the request; default echoes `source_block` tagged with the model id. */
  translate?: (request: GenerateRequest) => string;
  chunk?: number;
  /** Real delay between deltas; 0 (default) adds none. */
  deltaDelayMs?: number;
  /** Misbehaving server: keeps emitting after the client aborts (to exercise late-event guards). */
  ignoreAbort?: boolean;
  probe?: ConcurrencyProbe;
  listModelsError?: ProviderError;
  healthError?: ProviderError;
  tokenCounting?: boolean;
  /** Decides the script per request (return undefined to use the default). Queued scripts still win. */
  scriptFor?: (request: GenerateRequest, callIndex: number) => Script | undefined;
}

const lastUserContent = (messages: ChatMessage[]): string =>
  [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

export function defaultTranslate(request: GenerateRequest): string {
  const content = lastUserContent(request.messages);
  let source = content;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && typeof (parsed as { source_block?: unknown }).source_block === "string") {
      source = (parsed as { source_block: string }).source_block;
    }
  } catch {
    /* not JSON: use the raw message */
  }
  return `[${request.modelId}] ${source}`;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const untilAbort = (signal?: AbortSignal): Promise<false> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    signal?.addEventListener("abort", () => resolve(false), { once: true });
  });

/**
 * Deterministic in-memory provider for coordinator, UI and contract tests.
 * `generate` deliberately yields the *raw* script behaviour (including violations such as a missing
 * terminal); production adapters are wrapped with `enforceContract`, and tests can do the same.
 */
export class FakeProvider implements TranslationProvider {
  readonly kind: string;
  readonly probe: ConcurrencyProbe;
  /** Every request received, in order (copies). */
  readonly requests: GenerateRequest[] = [];
  private readonly queue: Script[] = [];
  private readonly unavailable: Set<string>;

  constructor(private readonly options: FakeProviderOptions = {}) {
    this.kind = options.kind ?? "fake";
    this.probe = options.probe ?? new ConcurrencyProbe();
    this.unavailable = new Set(options.unavailable ?? []);
  }

  /** The next generate() calls use these scripts, in order; afterwards the default responder returns. */
  enqueue(...scripts: Script[]): this {
    this.queue.push(...scripts);
    return this;
  }

  setUnavailable(modelId: string, unavailable: boolean): void {
    if (unavailable) this.unavailable.add(modelId);
    else this.unavailable.delete(modelId);
  }

  async capabilities(): Promise<Capabilities> {
    return {
      streaming: true,
      tokenCounting: this.options.tokenCounting ?? false,
      modelResidency: false,
      cancellation: "client-only",
      ...this.options.capabilities,
    };
  }

  async health(_config: ProviderConfig, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ProviderRequestError(providerError("canceled", "Request canceled."));
    if (this.options.healthError) throw new ProviderRequestError(this.options.healthError);
  }

  async listModels(_config: ProviderConfig, signal: AbortSignal): Promise<ModelInfo[]> {
    if (signal.aborted) throw new ProviderRequestError(providerError("canceled", "Request canceled."));
    if (this.options.listModelsError) throw new ProviderRequestError(this.options.listModelsError);
    return (this.options.models ?? [{ id: "fake-model", label: "Fake model" }]).map((m) => ({ ...m }));
  }

  async countTokens(_modelId: string, messages: ChatMessage[]): Promise<number> {
    return messages.reduce((n, m) => n + Array.from(m.content).length + 4, 0);
  }

  async *generate(_config: ProviderConfig, request: GenerateRequest, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
    this.requests.push(structuredClone(request));
    this.probe.enter();
    try {
      const canceled: GenerateEvent = { type: "error", error: providerError("canceled", "Request canceled.") };
      if (this.unavailable.has(request.modelId)) {
        yield {
          type: "error",
          error: providerError("model_unavailable", `Model "${request.modelId}" is not available on the server.`),
        };
        return;
      }
      const steps =
        this.queue.shift() ?? this.options.scriptFor?.(request, this.requests.length - 1) ?? this.defaultScript(request);
      const sig = this.options.ignoreAbort ? undefined : signal;
      for (const s of steps) {
        if (sig?.aborted) {
          yield canceled;
          return;
        }
        switch (s.t) {
          case "delta":
            yield { type: "delta", text: s.text };
            if (this.options.deltaDelayMs && !(await sleep(this.options.deltaDelayMs, sig))) {
              yield canceled;
              return;
            }
            break;
          case "wait":
            if (!(await sleep(s.ms, sig))) {
              yield canceled;
              return;
            }
            break;
          case "gate":
            if (!(await s.gate.wait(sig))) {
              yield canceled;
              return;
            }
            break;
          case "hang":
            await untilAbort(sig);
            yield canceled;
            return;
          case "finish":
            yield { type: "finish", reason: s.reason, ...(s.usage ? { usage: s.usage } : {}), ...(s.reasoningSeen ? { reasoningSeen: true } : {}) };
            return;
          case "error":
            yield { type: "error", error: s.error };
            return;
          case "throw":
            throw s.error;
        }
      }
    } finally {
      this.probe.exit();
    }
  }

  private defaultScript(request: GenerateRequest): Script {
    const text = (this.options.translate ?? defaultTranslate)(request);
    const chunk = this.options.chunk ?? 4;
    if (!request.stream) return [{ t: "delta", text }, { t: "finish", reason: "stop" }];
    return script.translate(text, { chunk });
  }
}
