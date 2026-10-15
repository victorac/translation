import type {
  ProviderError,
  ProviderErrorCode,
} from "./types.js";

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

/** Normalizes anything thrown into a ProviderError. Never leaks a raw exception to the caller. */
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

