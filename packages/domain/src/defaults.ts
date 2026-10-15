/** Fixed numbers the app uses when it builds a request. */
export const DEFAULTS = {
  /** Fixed per-request message framing, deliberately generous (estimate, not measured). */
  messageOverheadTokens: 64,
} as const;
