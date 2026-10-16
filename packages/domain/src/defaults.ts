/** Fixed numbers the app uses when it builds a request. */
export const DEFAULTS = {
  /** Fixed per-request message framing, deliberately generous (estimate, not measured). */
  messageOverheadTokens: 64,
  /** At most this many translated paragraphs before the one being translated are sent as context. */
  contextBefore: 8,
  /** At most this many paragraphs after it are sent, so the model knows where the story goes. */
  contextAfter: 2,
} as const;
