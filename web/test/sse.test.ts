import { describe, expect, it } from 'vitest';
import { readSSE, SSEParser, type SSEEvent } from '../src/sse';

const STREAM =
  'event: session\ndata: {"session_id":"11111111-1111-4111-8111-111111111111"}\n\n' +
  'event: status\ndata: {"tool":"search_products","label":"Ищу товары…"}\n\n' +
  ': keep-alive\n\n' +
  'event: delta\ndata: {"text":"Вот **лампы** E27:\\n"}\n\n' +
  'event: products\ndata: {"items":[{"id":1,"name":"Лампа LED 10Вт","price_site":990}]}\n\n' +
  'event: done\ndata: {"message_id":42}\n\n';

const EXPECTED: SSEEvent[] = [
  { event: 'session', data: '{"session_id":"11111111-1111-4111-8111-111111111111"}' },
  { event: 'status', data: '{"tool":"search_products","label":"Ищу товары…"}' },
  { event: 'delta', data: '{"text":"Вот **лампы** E27:\\n"}' },
  { event: 'products', data: '{"items":[{"id":1,"name":"Лампа LED 10Вт","price_site":990}]}' },
  { event: 'done', data: '{"message_id":42}' },
];

function parseChunks(chunks: string[]): SSEEvent[] {
  const out: SSEEvent[] = [];
  const p = new SSEParser((e) => out.push(e));
  for (const c of chunks) p.push(c);
  p.flush();
  return out;
}

describe('SSEParser', () => {
  it('parses a whole stream in one chunk', () => {
    expect(parseChunks([STREAM])).toEqual(EXPECTED);
  });

  it('handles every possible single split point', () => {
    for (let i = 1; i < STREAM.length; i++) {
      expect(parseChunks([STREAM.slice(0, i), STREAM.slice(i)]), `split at ${i}`).toEqual(EXPECTED);
    }
  });

  it('handles one character per chunk', () => {
    expect(parseChunks(STREAM.split(''))).toEqual(EXPECTED);
  });

  it('handles CRLF line endings split between \\r and \\n', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    for (let i = 1; i < crlf.length; i++) {
      expect(parseChunks([crlf.slice(0, i), crlf.slice(i)]), `split at ${i}`).toEqual(EXPECTED);
    }
  });

  it('handles bare CR line endings', () => {
    expect(parseChunks([STREAM.replace(/\n/g, '\r')])).toEqual(EXPECTED);
  });

  it('joins multi-line data with \\n and defaults event to "message"', () => {
    expect(parseChunks(['data: a\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('strips only one leading space and keeps field without colon', () => {
    expect(parseChunks(['data:  two spaces\ndata\n\n'])).toEqual([{ event: 'message', data: ' two spaces\n' }]);
  });

  it('ignores comments, retry and unknown fields; keeps id', () => {
    expect(parseChunks([':ping\nretry: 1000\nfoo: bar\nid: 7\nevent: done\ndata: {}\n\n'])).toEqual([
      { event: 'done', data: '{}', id: '7' },
    ]);
  });

  it('does not dispatch events without data and resets the event name', () => {
    expect(parseChunks(['event: status\n\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('dispatches a trailing event without the final blank line on flush', () => {
    expect(parseChunks(['event: done\ndata: {"message_id":1}'])).toEqual([{ event: 'done', data: '{"message_id":1}' }]);
  });

  it('does not emit anything before the blank line arrives', () => {
    const out: SSEEvent[] = [];
    const p = new SSEParser((e) => out.push(e));
    p.push('event: delta\ndata: {"text":"hi"}\n');
    expect(out).toEqual([]);
    p.push('\n');
    expect(out).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });
});

describe('readSSE', () => {
  function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    });
  }

  it('decodes UTF-8 split in the middle of a multi-byte character', async () => {
    const bytes = new TextEncoder().encode(STREAM);
    // Split at every 3 bytes: Cyrillic letters are 2 bytes, "…" and "₸" are 3.
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) parts.push(bytes.slice(i, i + 3));
    const out: SSEEvent[] = [];
    await readSSE(streamOf(parts), (e) => out.push(e));
    expect(out).toEqual(EXPECTED);
  });

  it('parses JSON payloads that round-trip', async () => {
    const out: SSEEvent[] = [];
    await readSSE(streamOf([new TextEncoder().encode(STREAM)]), (e) => out.push(e));
    expect(JSON.parse(out[2].data).text).toBe('Вот **лампы** E27:\n');
  });
});
