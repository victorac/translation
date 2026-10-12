export interface SseMessage {
  event?: string;
  data: string;
}

/**
 * Turns raw bytes from a streaming HTTP reply into server-sent-event messages.
 * Network chunks can end anywhere, even in the middle of a multi-byte character or between the
 * two characters of a line break, so this keeps what it has not finished and continues on the next chunk.
 */
export class SseDecoder {
  private readonly text = new TextDecoder("utf-8");
  private buffer = "";
  private data: string[] = [];
  private eventName: string | undefined;
  private started = false;

  push(chunk: Uint8Array): SseMessage[] {
    this.buffer += this.text.decode(chunk, { stream: true });
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1);
    }
    return this.drain();
  }

  /** Call when the stream is over: a final lone carriage return can now be read as a line end. */
  end(): SseMessage[] {
    this.buffer += this.text.decode();
    const out = this.drain(true);
    return out;
  }

  /** True if the stream ended in the middle of a message (which is discarded, as the standard says). */
  get hasIncompleteMessage(): boolean {
    return this.data.length > 0 || this.buffer.trim() !== "";
  }

  private drain(final = false): SseMessage[] {
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buffer);
      if (!m) break;
      // A lone "\r" at the very end might be the first half of "\r\n": wait for more data.
      if (!final && m[0] === "\r" && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      if (line === "") {
        if (this.data.length > 0) {
          out.push({ data: this.data.join("\n"), ...(this.eventName !== undefined ? { event: this.eventName } : {}) });
        }
        this.data = [];
        this.eventName = undefined;
      } else if (line.startsWith(":")) {
        // comment / keep-alive
      } else {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") this.data.push(value);
        else if (field === "event") this.eventName = value;
      }
    }
    return out;
  }
}
