#!/usr/bin/env node
// npm run check:search — проверка recall RPC ekt.search_products после миграции
// 20260923160000_search_recall.sql: unit-aware p_attrs и OR-полнотекст.
// Печатает PASS/FAIL по каждому кейсу, код выхода 1 при провале.
//
// Env (.env.local / .env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Запросы идут напрямую в PostgREST (rest/v1/rpc/search_products) с сервисным
// ключом и заголовком Content-Profile: ekt (схема ekt — не public).

import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[check:search] Задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (см. .env.local / .env.example)');
  process.exit(1);
}

const RPC_URL = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/search_products`;
const TARGET_SKU = '150200550_';

const results = [];

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function searchProducts(args) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Profile': 'ekt',
    },
    body: JSON.stringify({ p_limit: 10, ...args }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error(`не JSON: ${text.slice(0, 500)}`);
  }
  if (!Array.isArray(rows)) throw new Error(`ожидали массив, получили: ${text.slice(0, 500)}`);
  return rows;
}

function skuList(rows) {
  return rows.map((r) => r.sku).join(', ');
}

async function runCase(name, args, assert) {
  try {
    const rows = await searchProducts(args);
    const { ok, detail } = assert(rows);
    report(name, ok, detail);
  } catch (e) {
    report(name, false, e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  console.log(`[check:search] RPC = ${RPC_URL}\n`);

  await runCase(
    'a) q="лампа E27 10 Вт 4000K" → SKU в топ-3',
    { q: 'лампа E27 10 Вт 4000K' },
    (rows) => {
      const top3 = rows.slice(0, 3);
      const ok = top3.some((r) => r.sku === TARGET_SKU);
      return { ok, detail: `топ-3: [${skuList(top3)}]` };
    },
  );

  await runCase(
    'b) q="лампа", p_attrs={Мощность:"10 Вт"} → содержит SKU',
    { q: 'лампа', p_attrs: { Мощность: '10 Вт' } },
    (rows) => {
      const ok = rows.some((r) => r.sku === TARGET_SKU);
      return { ok, detail: `результаты (${rows.length}): [${skuList(rows)}]` };
    },
  );

  await runCase(
    'c) q="лампа", p_attrs={Цветовая температура:"4000K", Тип цоколя:"Е27" (кириллица)} → содержит SKU',
    {
      q: 'лампа',
      p_attrs: { 'Цветовая температура': '4000K', 'Тип цоколя': 'Е27' },
    },
    (rows) => {
      const ok = rows.some((r) => r.sku === TARGET_SKU);
      return { ok, detail: `результаты (${rows.length}): [${skuList(rows)}]` };
    },
  );

  await runCase(
    'd) q="E27 10W 4000K" → SKU первым',
    { q: 'E27 10W 4000K' },
    (rows) => {
      const ok = rows.length > 0 && rows[0].sku === TARGET_SKU;
      return { ok, detail: `первый: ${rows[0]?.sku ?? 'нет результатов'}` };
    },
  );

  await runCase(
    'e) q="150200550_" → SKU первым',
    { q: TARGET_SKU },
    (rows) => {
      const ok = rows.length > 0 && rows[0].sku === TARGET_SKU;
      return { ok, detail: `первый: ${rows[0]?.sku ?? 'нет результатов'}` };
    },
  );

  await runCase(
    'f) q="светодиодная лампа GX53" → GX53 в названии в топ-3',
    { q: 'светодиодная лампа GX53' },
    (rows) => {
      const top3 = rows.slice(0, 3);
      const ok = top3.some((r) => typeof r.name === 'string' && /GX ?53/i.test(r.name));
      return { ok, detail: `топ-3: [${top3.map((r) => r.name).join(' | ')}]` };
    },
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[check:search] ${results.length - failed.length}/${results.length} проверок пройдено`);
  if (failed.length) {
    console.log(`[check:search] провалено: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[check:search] непредвиденная ошибка:', e);
  process.exit(1);
});
