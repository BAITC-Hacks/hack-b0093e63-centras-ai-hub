#!/usr/bin/env node
// npm run e2e:api — black-box contract check of the deployed chat API's SSE `action` events,
// against the "РАЗВОРОТ" (real ekt.kz) contract in docs/superpowers/plans/2026-09-23-agent-hands.md:
// event order (action after delta/products, before done), url allow-list + canonical trailing
// slash for `navigate`, known targets/forms/fields for `highlight`/`click`/`fill`, `suggest` limits.
//
// No browser: fast, so it runs first and can be re-run cheaply while the backend redeploys.
//
// Env: CHAT_URL (default `${SUPABASE_URL}/functions/v1/chat`, SUPABASE_URL from .env.local/.env).

import dotenv from 'dotenv';
import { chatTurn } from './lib/sse.mjs';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

function chatUrl() {
  const explicit = process.env.CHAT_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Задайте CHAT_URL или SUPABASE_URL (см. .env.local / .env.example)');
  return `${base.replace(/\/+$/, '')}/functions/v1/chat`;
}

const CHAT_URL = chatUrl();

// ── contract constants (kept independent of supabase/functions/chat/ui_actions.ts on purpose:
//    this checks the deployed behaviour, not whether the source agrees with itself) ──
const TARGETS = new Set([
  'price', 'buy_button', 'characteristics', 'description', 'return_conditions',
  'payment_methods', 'contacts_phone', 'catalog_list', 'search', 'cart',
]);
const CLICK_TARGETS = new Set(['buy_button', 'search_submit', 'buy_one_click', 'lead_form']);
const FORM_FIELDS = {
  lead_form: new Set(['name', 'email', 'phone', 'question']),
  buy_one_click: new Set(['name', 'phone', 'email']),
  search: new Set(['q']),
};
const SERVICE_NAV_URLS = new Set(
  ['/return/', '/payments/', '/about/howto/', '/about/contacts/', '/about/faq/',
    '/catalog/svetilniki_lampy/lampy/', '/personal/cart/', '/'].map((p) => 'https://ekt.kz' + p),
);
const MAX_HIGHLIGHT = 3;
const MAX_SUGGEST_OPTIONS = 4;
const MAX_OPTION_LEN = 40;

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Structural checks shared by every scenario: event order + per-type contract shape. */
function checkCommon(label, r, productUrls = []) {
  const { events } = r;
  const lastDeltaIdx = events.reduce((acc, e, i) => (e.event === 'delta' ? i : acc), -1);
  const productsIdx = events.findIndex((e) => e.event === 'products');
  const doneIdx = events.findIndex((e) => e.event === 'done');
  const actionIdxs = events.map((e, i) => (e.event === 'action' ? i : -1)).filter((i) => i >= 0);
  const errorEv = events.find((e) => e.event === 'error');

  report(`${label}: no error event`, !errorEv, errorEv ? JSON.stringify(errorEv.data) : undefined);
  report(`${label}: has session event`, events.some((e) => e.event === 'session'));
  report(`${label}: has done event`, doneIdx >= 0);

  report(
    `${label}: action events after delta/products, before done`,
    actionIdxs.length === 0 || actionIdxs.every((i) => i > lastDeltaIdx && (doneIdx < 0 || i < doneIdx)),
    `delta@${lastDeltaIdx} products@${productsIdx} action@[${actionIdxs.join(',')}] done@${doneIdx}`,
  );

  const actions = actionIdxs.map((i) => events[i].data);
  const byType = (t) => actions.filter((a) => a?.type === t);

  report(`${label}: at most 1 navigate action`, byType('navigate').length <= 1, `count=${byType('navigate').length}`);
  report(`${label}: at most 1 click action`, byType('click').length <= 1, `count=${byType('click').length}`);
  report(`${label}: at most 1 fill action`, byType('fill').length <= 1, `count=${byType('fill').length}`);
  report(`${label}: at most 1 suggest action`, byType('suggest').length <= 1, `count=${byType('suggest').length}`);
  report(`${label}: at most ${MAX_HIGHLIGHT} highlight actions`, byType('highlight').length <= MAX_HIGHLIGHT, `count=${byType('highlight').length}`);

  for (const a of byType('navigate')) {
    const url = a.url ?? '';
    const canonical = /^https:\/\/ekt\.kz\/.*\/$/.test(url) || url === 'https://ekt.kz/';
    const noQuery = !url.includes('?') && !url.includes('#');
    const allowed = SERVICE_NAV_URLS.has(url) || productUrls.includes(url);
    report(`${label}: navigate.url is canonical https://ekt.kz/…/ (trailing slash)`, canonical, url);
    report(`${label}: navigate.url has no query/fragment`, noQuery, url);
    report(
      `${label}: navigate.url is service path or a product url from this turn`,
      allowed,
      allowed ? url : `${url} not in service list and not in products[].url (${productUrls.join(', ') || 'none'})`,
    );
    report(`${label}: navigate has a label`, typeof a.label === 'string' && a.label.trim().length > 0);
  }
  for (const a of byType('highlight')) {
    report(`${label}: highlight.target «${a.target}» is a known target`, TARGETS.has(a.target));
  }
  for (const a of byType('click')) {
    report(`${label}: click.target «${a.target}» is a known click target`, CLICK_TARGETS.has(a.target));
  }
  for (const a of byType('fill')) {
    const allowedFields = FORM_FIELDS[a.form];
    report(`${label}: fill.form «${a.form}» is a known form`, !!allowedFields);
    if (allowedFields) {
      const keys = Object.keys(a.fields || {});
      const bad = keys.filter((k) => !allowedFields.has(k));
      report(`${label}: fill.fields keys ⊆ allowed fields for «${a.form}»`, bad.length === 0, bad.length ? `unknown keys: ${bad.join(', ')}` : keys.join(', '));
    }
  }
  for (const a of byType('suggest')) {
    const opts = a.options || [];
    report(`${label}: suggest.options 1..${MAX_SUGGEST_OPTIONS} items`, opts.length >= 1 && opts.length <= MAX_SUGGEST_OPTIONS, `count=${opts.length}`);
    const tooLong = opts.filter((o) => (o ?? '').length > MAX_OPTION_LEN);
    report(`${label}: suggest.options ≤ ${MAX_OPTION_LEN} chars`, tooLong.length === 0, tooLong.join(' | '));
  }
  return actions;
}

async function scenarioS1() {
  const label = 'S1 (лампы E27, открыть самую дешёвую)';
  const r = await chatTurn(CHAT_URL, {
    message: 'Есть лампочки E27 тёплого света? Открой самую дешёвую',
    page_url: 'https://ekt.kz/catalog/svetilniki_lampy/lampy/',
    city: 'Алматы',
  });
  const productUrls = (r.products || []).map((p) => p.url).filter(Boolean);
  report(`${label}: products event non-empty`, productUrls.length > 0, `count=${productUrls.length}`);
  const actions = checkCommon(label, r, productUrls);
  const nav = actions.find((a) => a.type === 'navigate');
  report(`${label}: has navigate action`, !!nav, nav ? nav.url : 'none');
  const hl = actions.filter((a) => a.type === 'highlight');
  report(`${label}: has highlight target=price`, hl.some((a) => a.target === 'price'), hl.map((a) => a.target).join(', ') || 'none');
}

async function scenarioS3() {
  const label1 = 'S3.1 (хочу оформить возврат)';
  const r1 = await chatTurn(CHAT_URL, {
    message: 'Хочу оформить возврат',
    page_url: 'https://ekt.kz/',
  });
  const actions1 = checkCommon(label1, r1);
  const nav1 = actions1.find((a) => a.type === 'navigate');
  report(`${label1}: navigate to https://ekt.kz/return/`, nav1?.url === 'https://ekt.kz/return/', nav1 ? nav1.url : 'none');
  report(
    `${label1}: has highlight target=return_conditions`,
    actions1.some((a) => a.type === 'highlight' && a.target === 'return_conditions'),
    actions1.filter((a) => a.type === 'highlight').map((a) => a.target).join(', ') || 'none',
  );

  if (!r1.sessionId) {
    report('S3.2: has session_id to continue the dialog', false, 'no session_id from S3.1 — skipping follow-up');
    return;
  }
  const label2 = 'S3.2 (реквизиты возврата → fill lead_form)';
  const r2 = await chatTurn(CHAT_URL, {
    session_id: r1.sessionId,
    message: 'Заказ 12345 от 01.09, лампа LED A60 не работает, меня зовут Тест, телефон +7 701 000 00 00',
    page_url: 'https://ekt.kz/return/',
  });
  const actions2 = checkCommon(label2, r2);
  const fill = actions2.find((a) => a.type === 'fill');
  report(`${label2}: has fill action`, !!fill, fill ? `form=${fill.form}` : 'none');
  report(`${label2}: fill.form === lead_form`, fill?.form === 'lead_form', fill ? fill.form : 'none');
  const fields = fill?.fields || {};
  report(`${label2}: fill.fields.phone normalized to +7…`, /^\+7\d{10}$/.test(fields.phone || ''), fields.phone || 'missing');
  report(`${label2}: fill.fields.name present`, !!(fields.name || '').trim(), fields.name || 'missing');
  report(`${label2}: fill.fields.question mentions the order`, /12345/.test(fields.question || ''), fields.question || 'missing');
}

async function scenarioS5() {
  const label = 'S5 (найди лампу GX53)';
  const r = await chatTurn(CHAT_URL, {
    message: 'Найди на сайте лампу GX53',
    page_url: 'https://ekt.kz/',
  });
  const actions = checkCommon(label, r);
  const fill = actions.find((a) => a.type === 'fill');
  report(`${label}: has fill action (form=search)`, fill?.form === 'search', fill ? `form=${fill.form}` : 'none');
  report(`${label}: fill.fields.q mentions GX53`, /gx ?53/i.test(fill?.fields?.q || ''), fill?.fields?.q || 'missing');
  const click = actions.find((a) => a.type === 'click');
  report(`${label}: has click action (target=search_submit)`, click?.target === 'search_submit', click ? `target=${click.target}` : 'none');
}

async function main() {
  console.log(`[e2e:api] ${new Date().toISOString()} CHAT_URL = ${CHAT_URL}\n`);
  for (const [name, fn] of [['S1', scenarioS1], ['S3', scenarioS3], ['S5', scenarioS5]]) {
    try {
      await fn();
    } catch (e) {
      report(`${name}: request completed without throwing`, false, e instanceof Error ? e.message : String(e));
    }
    console.log('');
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`[e2e:api] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`[e2e:api] failed:\n - ${failed.map((f) => f.name + (f.detail ? ` (${f.detail})` : '')).join('\n - ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[e2e:api] fatal:', e);
  process.exit(1);
});
