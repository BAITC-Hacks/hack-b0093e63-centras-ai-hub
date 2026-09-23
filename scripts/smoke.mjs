#!/usr/bin/env node
// npm run smoke — дымовой тест развёрнутого чат-API: health, основной сценарий (товар + ссылка),
// и отказ на некорректный вход. Печатает PASS/FAIL по каждой проверке, код выхода 1 при провале.
//
// Env: CHAT_URL (по умолчанию `${SUPABASE_URL}/functions/v1/chat`, SUPABASE_URL — из .env.local).
//
// Тела запросов отправляются как UTF-8 JSON через встроенный fetch — не через curl (Git Bash
// на Windows ломает кириллицу при передаче через командную строку).

import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

function chatUrl() {
  const explicit = process.env.CHAT_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Задайте CHAT_URL или SUPABASE_URL (см. .env.local / .env.example)');
  return `${base.replace(/\/+$/, '')}/functions/v1/chat`;
}

const CHAT_URL = chatUrl();
const results = [];

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Разбирает SSE-поток ответа чата (см. supabase/functions/chat/sse.ts). */
async function* readSSE(body) {
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

async function checkHealth() {
  try {
    const res = await fetch(`${CHAT_URL}/health`, { signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => null);
    const ok = res.status === 200 && body?.ok === true;
    report('GET /health → ok', ok, ok ? undefined : `HTTP ${res.status} ${JSON.stringify(body)}`);
  } catch (e) {
    report('GET /health → ok', false, e instanceof Error ? e.message : String(e));
  }
}

async function checkMainScenario() {
  const message = 'Нужна светодиодная лампа E27 на 10 Вт, 4000K';
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'text/event-stream' },
      body: JSON.stringify({ message, page_url: 'https://ekt.kz/', city: 'Алматы' }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok || !res.body) {
      report('POST / (лампа E27) → ссылка + товары', false, `HTTP ${res.status}`);
      return;
    }
    let answer = '';
    let products = [];
    let errorEvent = null;
    for await (const ev of readSSE(res.body)) {
      if (ev.event === 'delta') answer += String(ev.data?.text ?? '');
      else if (ev.event === 'products') products = ev.data?.items ?? [];
      else if (ev.event === 'error') errorEvent = ev.data;
    }
    const hasLink = /https:\/\/(www\.)?ekt\.kz\//i.test(answer);
    const hasProducts = Array.isArray(products) && products.length > 0;
    const ok = !errorEvent && hasLink && hasProducts;
    const detail = errorEvent
      ? `event error: ${JSON.stringify(errorEvent)}`
      : `ссылка=${hasLink} товары=${products.length}`;
    report('POST / (лампа E27) → ссылка ekt.kz + непустой products', ok, ok ? detail : detail);
  } catch (e) {
    report('POST / (лампа E27) → ссылка + товары', false, e instanceof Error ? e.message : String(e));
  }
}

async function expectStatus(name, init, expectedStatus) {
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', signal: AbortSignal.timeout(30_000), ...init });
    const ok = res.status === expectedStatus;
    report(name, ok, ok ? `HTTP ${res.status}` : `ожидали HTTP ${expectedStatus}, получили ${res.status}`);
  } catch (e) {
    report(name, false, e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  console.log(`[smoke] CHAT_URL = ${CHAT_URL}\n`);

  await checkHealth();
  await checkMainScenario();

  await expectStatus(
    'POST / (пустое сообщение) → 400',
    {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ message: '' }),
    },
    400,
  );

  await expectStatus(
    'POST / (сообщение 2001 символ) → 400',
    {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ message: 'а'.repeat(2001) }),
    },
    400,
  );

  await expectStatus(
    'POST / (не-JSON тело) → 400',
    {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: 'это не json',
    },
    400,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} проверок пройдено`);
  if (failed.length) {
    console.log(`[smoke] провалено: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main();
