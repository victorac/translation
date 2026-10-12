import type { GenerateEvent, ProviderError, ProviderErrorCode } from "./types.js";

/** Auto-retry applies only to transient failures (spec 04 failure table); everything else waits for the user. */
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["rate_limit", "server"]);

export function providerError(
  code: ProviderErrorCode,
  message: string,
  extra: Partial<Omit<ProviderError, "code" | "message">> = {},
): ProviderError {
  return { code, message, retryable: RETRYABLE.has(code), ...extra };
}

/** Thrown by `health`/`listModels`, which return promises instead of event streams. */
export class ProviderRequestError extends Error {
  constructor(readonly providerError: ProviderError) {
    super(providerError.message);
    this.name = "ProviderRequestError";
  }
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/** Normalizes anything thrown into a ProviderError. Never leaks a raw exception to the coordinator. */
export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderRequestError) return e.providerError;
  if (e instanceof Error) {
    if (e.name === "AbortError") return providerError("canceled", "Request canceled.");
    const code = (e as { code?: unknown }).code ?? (e.cause as { code?: unknown } | undefined)?.code;
    if (e instanceof TypeError || (typeof code === "string" && NETWORK_CODES.has(code))) {
      return providerError("connection", `Could not reach the server: ${e.message}`);
    }
    return providerError("server", e.message || "Unexpected provider failure.");
  }
  return providerError("server", "Unexpected provider failure.");
}

/**
 * Wraps any adapter stream so it satisfies the contract: zero or more non-empty deltas, then
 * exactly one terminal event, then nothing. Exceptions become error events; a stream that ends
 * silently becomes `invalid_response` (a disconnect never counts as a complete translation).
 */
export async function* enforceContract(source: AsyncIterable<GenerateEvent>): AsyncGenerator<GenerateEvent> {
  let terminal = false;
  try {
    for await (const ev of source) {
      if (terminal) continue; // late events after the terminal are dropped
      if (ev.type === "delta") {
        if (ev.text === "") continue;
        yield ev;
      } else {
        terminal = true;
        yield ev;
      }
    }
  } catch (e) {
    if (!terminal) {
      terminal = true;
      yield { type: "error", error: toProviderError(e) };
    }
  }
  if (!terminal) {
    yield {
      type: "error",
      error: providerError("invalid_response", "The stream ended without a finish event; the output is incomplete."),
    };
  }
}

export interface StreamProblem {
  message: string;
}

/** Returns contract violations of an already-collected event list (empty means well formed). */
export function checkWellFormed(events: readonly GenerateEvent[]): StreamProblem[] {
  const problems: StreamProblem[] = [];
  const terminals = events.filter((e) => e.type !== "delta").length;
  if (terminals === 0) problems.push({ message: "no terminal event" });
  if (terminals > 1) problems.push({ message: `${terminals} terminal events` });
  const first = events.findIndex((e) => e.type !== "delta");
  if (first !== -1 && first !== events.length - 1) problems.push({ message: "events after the terminal event" });
  if (events.some((e) => e.type === "delta" && e.text === "")) problems.push({ message: "empty delta" });
  return problems;
}

export interface CollectedStream {
  events: GenerateEvent[];
  text: string;
  terminal?: Exclude<GenerateEvent, { type: "delta" }>;
}

export async function collectStream(stream: AsyncIterable<GenerateEvent>): Promise<CollectedStream> {
  const events: GenerateEvent[] = [];
  let text = "";
  let terminal: CollectedStream["terminal"];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "delta") text += ev.text;
    else terminal ??= ev;
  }
  return terminal ? { events, text, terminal } : { events, text };
}
