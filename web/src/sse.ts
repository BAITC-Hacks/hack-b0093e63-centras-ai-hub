/**
 * Minimal Server-Sent Events parser for POST streams (EventSource can't POST).
 * Follows the WHATWG event-stream rules that matter here: CRLF/CR/LF line endings,
 * multi-line `data:`, comments (`:`), optional single space after the colon,
 * and chunk boundaries anywhere (mid-line, mid-CRLF, mid-UTF-8 sequence).
 */

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

export type SSEHandler = (ev: SSEEvent) => void;

export class SSEParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  constructor(private readonly onEvent: SSEHandler) {}

  /** Feed decoded text. May contain any fragment of the stream. */
  push(chunk: string): void {
    this.buf += chunk;
    let start = 0;
    const buf = this.buf;
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      // A lone CR at the very end may be the first half of CRLF: wait for more input.
      if (c === 13 && i === buf.length - 1) break;
      this.line(buf.slice(start, i));
      if (c === 13 && buf.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    this.buf = buf.slice(start);
  }

  /** End of stream: dispatch a trailing event that lacked the final blank line. */
  flush(): void {
    if (this.buf) {
      this.line(this.buf.replace(/\r$/, ''));
      this.buf = '';
    }
    this.dispatch();
  }

  private line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.charCodeAt(0) === 58 /* : */) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    // `retry` and unknown fields are ignored.
  }

  private dispatch(): void {
    if (this.data.length === 0) {
      this.event = '';
      return;
    }
    const ev: SSEEvent = { event: this.event || 'message', data: this.data.join('\n') };
    if (this.id !== undefined) ev.id = this.id;
    this.event = '';
    this.data = [];
    this.onEvent(ev);
  }
}

/** Read a fetch() body as SSE until it ends. Resolves when the stream closes. */
export async function readSSE(body: ReadableStream<Uint8Array>, onEvent: SSEHandler): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SSEParser(onEvent);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
