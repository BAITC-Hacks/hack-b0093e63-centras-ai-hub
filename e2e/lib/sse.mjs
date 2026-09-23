// Minimal SSE stream reader shared by e2e/api-contract.mjs (and useful for ad-hoc debugging).
// Mirrors scripts/smoke.mjs's readSSE — kept independent on purpose: this suite validates the
// deployed chat API as a black box, not the project's own SSE parser.

/** @param {ReadableStream<Uint8Array>} body */
export async function* readSSE(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parse = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return null;
    const raw = data.join('\n');
    try {
      return { event, data: JSON.parse(raw) };
    } catch {
      return { event, data: raw };
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const ev = parse(block);
      if (ev) yield ev;
    }
  }
  if (buf.trim()) {
    const ev = parse(buf);
    if (ev) yield ev;
  }
}

/** Post one chat turn and collect all SSE events into an array (plus the assembled answer text). */
export async function chatTurn(chatUrl, body, timeoutMs = 60_000) {
  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
  }
  const events = [];
  let answer = '';
  let sessionId;
  let products = [];
  for await (const ev of readSSE(res.body)) {
    events.push(ev);
    if (ev.event === 'delta' && typeof ev.data?.text === 'string') answer += ev.data.text;
    else if (ev.event === 'session' && typeof ev.data?.session_id === 'string') sessionId = ev.data.session_id;
    else if (ev.event === 'products' && Array.isArray(ev.data?.items)) products = ev.data.items;
  }
  return { events, answer, sessionId, products };
}
