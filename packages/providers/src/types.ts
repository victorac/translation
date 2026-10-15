/** Provider contract from spec 04. Adapters own HTTP; nothing else sees payloads. */
export type ProviderConfig = {
  id: string;
  kind: string;
  baseUrl: string;
  credentialRef?: string;
};

export type ModelInfo = {
  id: string;
  label: string;
  contextLimit?: number;
  /** Absence means unknown. List membership does not imply loaded. */
  loaded?: boolean;
};

export type Capabilities = {
  streaming: boolean;
  tokenCounting: boolean;
  modelResidency: boolean;
  cancellation: "client-only" | "server-confirmed";
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type GenerateRequest = {
  requestId: string;
  modelId: string;
  messages: ChatMessage[];
  temperature: number;
  maxOutputTokens: number;
  stream: boolean;
};

export type ProviderErrorCode =
  | "connection"
  | "auth"
  | "model_unavailable"
  | "context_overflow"
  | "rate_limit"
  | "timeout"
  | "invalid_response"
  | "server"
  | "canceled";

export type ProviderError = {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
};

export type FinishReason = "stop" | "length" | "refusal" | "unknown";

export type GenerateEvent =
  | { type: "delta"; text: string }
  | {
      type: "finish";
      reason: FinishReason;
      usage?: { inputTokens?: number; outputTokens?: number };
      /** The server sent separate "reasoning" text (which is never added to the translation). */
      reasoningSeen?: boolean;
    }
  | { type: "error"; error: ProviderError };

export interface TranslationProvider {
  readonly kind: string;
  capabilities(config: ProviderConfig): Promise<Capabilities>;
  health(config: ProviderConfig, signal: AbortSignal): Promise<void>;
  listModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelInfo[]>;
  generate(config: ProviderConfig, request: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerateEvent>;
  countTokens?(modelId: string, messages: ChatMessage[]): Promise<number>;
}
