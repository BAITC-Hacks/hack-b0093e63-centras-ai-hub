#!/usr/bin/env node
// npm run e2e — browser E2E of the AI consultant acting on the REAL https://ekt.kz, driven through
// the widget's public JS API (window.EKTConsultant.ask), against the real chat API.
//
// Safety: NEVER submits any form (#zayavka / #buyoneclick / checkout) and never proceeds past
// add-to-cart. `.btn-cart` (buy_button) does add an item to a real anonymous cart — acceptable
// per the task spec (no order is placed) — nothing beyond that is clicked.
//
// Usage: node e2e/real-site.mjs [--headed]
//
// Env: CHAT_URL (default `${SUPABASE_URL}/functions/v1/chat`, SUPABASE_URL from .env.local/.env).

import dotenv from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ask, installWidget, lastAssistantLinks, lastAssistantText, waitAssistantSettled, waitPlateCycle, waitWidgetMounted, widgetSource } from './lib/inject.mjs';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = resolve(repoRoot, 'docs/screenshots');
mkdirSync(shotsDir, { recursive: true });

const HEADED = process.argv.includes('--headed');

function chatUrl() {
  const explicit = process.env.CHAT_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Задайте CHAT_URL или SUPABASE_URL (см. .env.local / .env.example)');
  return `${base.replace(/\/+$/, '')}/functions/v1/chat`;
}
const API = chatUrl();

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(`No system Chrome/Edge found among: ${CHROME_CANDIDATES.join(', ')}`);
}

const results = [];
function report(scenario, ok, reason) {
  results.push({ scenario, ok, reason });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${scenario}${reason ? ` — ${reason}` : ''}`);
}

async function newPage(browser, { onEkt = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await installWidget(context, { source: widgetSource(repoRoot), api: API, lang: 'ru' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { context, page };
}

async function gotoAndMount(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitWidgetMounted(page);
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(shotsDir, name), fullPage: false }).catch(() => {});
}

const norm = (u) => (u || '').replace(/\/+$/, '').toLowerCase();

/* ── S1: find the cheapest warm-white E27 lamp and open it ── */
async function scenarioS1(browser) {
  const label = 'S1 navigate to product (E27 cheapest)';
  const startUrl = 'https://ekt.kz/catalog/svetilniki_lampy/lampy/';
  const { context, page } = await newPage(browser);
  try {
    await gotoAndMount(page, startUrl);
    await ask(page, 'Есть лампочки E27 тёплого света? Открой самую дешёвую');
    await waitAssistantSettled(page, 60_000);
    const answer = await lastAssistantText(page);
    // A `products` event renders a product card (widget.ts productCard()) as `.products a.pname[href]`,
    // sibling of `.bubble`, not necessarily a markdown link inside the prose — accept either.
    const links = await lastAssistantLinks(page);
    const hasProductCard = await page.evaluate(() => {
      const host = document.querySelector('[data-ekt-consultant]');
      const root = host && host.shadowRoot;
      const rows = root ? root.querySelectorAll('.row.assistant') : [];
      const last = rows[rows.length - 1];
      return !!last?.querySelector('.products .card');
    });
    const hasLink = hasProductCard || links.some((h) => /^https?:\/\/(www\.)?ekt\.kz\//i.test(h)) || /ekt\.kz\//i.test(answer);
    report(
      'S1: assistant reply includes a product card (products event) or an ekt.kz link',
      hasLink,
      hasLink ? `productCard=${hasProductCard} links=[${links.join(', ')}]` : `no product card, no ekt.kz link in rendered links [${links.join(', ')}], text: "${answer.slice(0, 150)}"`,
    );

    let navigated = false;
    try {
      await page.waitForURL((u) => norm(u.href) !== norm(startUrl) && /(^|\.)ekt\.kz$/i.test(u.hostname), { timeout: 30_000 });
      navigated = true;
    } catch {
      navigated = false;
    }
    report(label, navigated, navigated ? `now at ${page.url()}` : `URL stayed at ${page.url()} after 30s (answer: "${answer.slice(0, 150)}")`);
    if (navigated && hasLink) {
      // Cross-check: the page we auto-navigated to should be the same product the card/link named.
      const matches = links.some((h) => {
        try {
          return norm(new URL(h, 'https://ekt.kz/').href) === norm(page.url());
        } catch {
          return false;
        }
      });
      report('S1: navigated to the same product shown in the reply', matches, matches ? undefined : `card/link hrefs=[${links.join(', ')}] vs navigated ${page.url()}`);
    }

    if (navigated) {
      await waitWidgetMounted(page).catch(() => {});
      // Deferred highlight (queued alongside `navigate`) runs on the new page; actions.ts waits up
      // to 8s for the target element before giving up.
      const ringSeen = await page
        .waitForFunction(
          () => {
            const host = document.querySelector('[data-ekt-overlay]');
            const ring = host?.shadowRoot?.querySelector('.ring');
            return !!ring && getComputedStyle(ring).display !== 'none';
          },
          { timeout: 9000 },
        )
        .then(() => true)
        .catch(() => false);
      report('S1: price highlight ring visible after navigation', ringSeen, ringSeen ? undefined : 'no .ring found in the overlay 9s after landing on the product page');
    }
    await shot(page, 'e2e-s1-product.png');
    return navigated ? { context, page } : ((await context.close()), null);
  } catch (e) {
    report(label, false, e instanceof Error ? e.message : String(e));
    await shot(page, 'e2e-s1-product.png');
    await context.close();
    return null;
  }
}

/* ── S2: on the product page just opened, add it to the cart ── */
async function scenarioS2(page) {
  const label = 'S2 click buy_button (add to cart)';
  try {
    const before = await page.evaluate(() => document.querySelector('.bx-basket')?.textContent?.replace(/\s+/g, ' ').trim() || '');
    await ask(page, 'Добавь её в корзину');
    await waitAssistantSettled(page, 60_000);
    const answer = await lastAssistantText(page);

    const cycled = await waitPlateCycle(page, { appearMs: 15_000, vanishMs: 6000 });
    report('S2: action plate (label · Отмена) appeared and ran', cycled, cycled ? undefined : `no plate seen within 15s (answer: "${answer.slice(0, 150)}")`);

    // Give the site's own add2basket AJAX call time to update the header counter.
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => document.querySelector('.bx-basket')?.textContent?.replace(/\s+/g, ' ').trim() || '');
    const changed = before !== after;
    report(label, changed, changed ? `cart before="${before}" after="${after}"` : `cart counter unchanged ("${before}")`);
    await shot(page, 'e2e-s2-cart.png');
  } catch (e) {
    report(label, false, e instanceof Error ? e.message : String(e));
    await shot(page, 'e2e-s2-cart.png');
  }
}

/* ── S3: return request → navigate /return/ + highlight, then fill the lead form ── */
async function scenarioS3(browser) {
  const labelNav = 'S3.1 navigate to /return/ + highlight';
  const labelForm = 'S3.2 fill lead_form (#zayavka) with return details';
  const { context, page } = await newPage(browser);
  try {
    await gotoAndMount(page, 'https://ekt.kz/');
    await ask(page, 'Хочу оформить возврат');
    await waitAssistantSettled(page, 60_000);
    const answer1 = await lastAssistantText(page);

    let navigated = false;
    try {
      await page.waitForURL((u) => norm(u.href) === norm('https://ekt.kz/return/'), { timeout: 30_000 });
      navigated = true;
    } catch {
      navigated = false;
    }
    report(labelNav, navigated, navigated ? `now at ${page.url()}` : `URL stayed at ${page.url()} after 30s (answer: "${answer1.slice(0, 200)}")`);
    if (navigated) await waitWidgetMounted(page).catch(() => {});
    await shot(page, 'e2e-s3a-return-page.png');

    await ask(page, 'Заказ 12345 от 01.09, лампа LED A60 не работает, меня зовут Тест, телефон +7 701 000 00 00');
    await waitAssistantSettled(page, 60_000);
    const answer2 = await lastAssistantText(page);

    const modalShown = await page
      .waitForFunction(
        () => {
          const m = document.querySelector('#zayavka');
          return !!m && (m.classList.contains('show') || getComputedStyle(m).display === 'block');
        },
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    report(`${labelForm}: modal #zayavka visible`, modalShown, modalShown ? undefined : `modal not shown within 15s (answer: "${answer2.slice(0, 200)}")`);

    // Visible ≠ filled: the fill action runs behind its own 2s plate (plus fillForm's own work), so
    // give the fields up to ~6s more (after the reply already settled) to actually receive real
    // values before reading them — not just checking the modal opened.
    const readFields = () =>
      page.evaluate(() => {
        const m = document.querySelector('#zayavka');
        const val = (sel) => m?.querySelector(sel)?.value || '';
        return { name: val('[name="name"]'), phone: val('[name="phone"]'), question: val('[name="question"]') };
      });
    const realPhoneDigits = (phone) => (phone.match(/\d/g) || []).length;
    await page
      .waitForFunction(
        () => {
          const m = document.querySelector('#zayavka');
          if (!m) return false;
          const val = (sel) => m.querySelector(sel)?.value || '';
          const digits = (val('[name="phone"]').match(/\d/g) || []).length;
          return val('[name="name"]').trim().length > 0 || digits >= 10 || val('[name="question"]').trim().length > 0;
        },
        { timeout: 6000 },
      )
      .catch(() => {}); // fields may legitimately stay empty — the checks below report that precisely

    const fields = await readFields();
    // The phone input is IMask-masked (class `phone-mask`): an untouched field still has a
    // non-empty `.value` — its placeholder skeleton "+7 (___) ___-__-__" — so "phone is filled"
    // must check for actual digits, not just a non-empty string.
    const phoneDigits = realPhoneDigits(fields.phone);
    report(`${labelForm}: name field filled`, fields.name.trim().length > 0, `name="${fields.name}"`);
    report(`${labelForm}: phone field has real digits (not just the IMask placeholder)`, phoneDigits >= 10, `phone="${fields.phone}" (${phoneDigits} digits)`);
    report(`${labelForm}: question field filled`, fields.question.trim().length > 0, `question="${fields.question.slice(0, 120)}"`);
    await shot(page, 'e2e-s3-return-form.png');
  } catch (e) {
    report(labelForm, false, e instanceof Error ? e.message : String(e));
    await shot(page, 'e2e-s3-return-form.png');
  } finally {
    await context.close();
  }
}

/* ── S4: payment method question → navigate /payments/ + highlight ── */
async function scenarioS4(browser) {
  const label = 'S4 navigate to /payments/ + highlight';
  const { context, page } = await newPage(browser);
  try {
    await gotoAndMount(page, 'https://ekt.kz/');
    await ask(page, 'Как оплатить картой?');
    await waitAssistantSettled(page, 60_000);
    const answer = await lastAssistantText(page);

    let navigated = false;
    try {
      await page.waitForURL((u) => norm(u.href) === norm('https://ekt.kz/payments/'), { timeout: 30_000 });
      navigated = true;
    } catch {
      navigated = false;
    }
    report(label, navigated, navigated ? `now at ${page.url()}` : `URL stayed at ${page.url()} after 30s (answer: "${answer.slice(0, 200)}")`);
    if (navigated) {
      await waitWidgetMounted(page).catch(() => {});
      // Deferred highlight (queued alongside `navigate`) runs on the new page; actions.ts waits up
      // to 8s for the target element before giving up — same budget/pattern as S1's price highlight.
      const ringSeen = await page
        .waitForFunction(
          () => {
            const host = document.querySelector('[data-ekt-overlay]');
            const ring = host?.shadowRoot?.querySelector('.ring');
            return !!ring && getComputedStyle(ring).display !== 'none';
          },
          { timeout: 9000 },
        )
        .then(() => true)
        .catch(() => false);
      report('S4: payment_methods highlight ring visible', ringSeen, ringSeen ? undefined : 'no .ring found in the overlay 9s after landing on /payments/');
    }
    await shot(page, 'e2e-s4-payments.png');
  } catch (e) {
    report(label, false, e instanceof Error ? e.message : String(e));
    await shot(page, 'e2e-s4-payments.png');
  } finally {
    await context.close();
  }
}

/* ── S5: on-site search for GX53 ── */
async function scenarioS5(browser) {
  const label = 'S5 fill search + click search_submit → /catalog/?q=';
  const { context, page } = await newPage(browser);
  try {
    await gotoAndMount(page, 'https://ekt.kz/');
    await ask(page, 'Найди на сайте лампу GX53');
    await waitAssistantSettled(page, 60_000);
    const answer = await lastAssistantText(page);

    let navigated = false;
    try {
      await page.waitForURL((u) => /\/catalog\/.*[?&]q=/i.test(u.href), { timeout: 30_000 });
      navigated = true;
    } catch {
      navigated = false;
    }
    report(label, navigated, navigated ? `now at ${page.url()}` : `URL stayed at ${page.url()} after 30s (answer: "${answer.slice(0, 200)}")`);
    await shot(page, 'e2e-s5-search.png');
  } catch (e) {
    report(label, false, e instanceof Error ? e.message : String(e));
    await shot(page, 'e2e-s5-search.png');
  } finally {
    await context.close();
  }
}

function writeResultsMd() {
  const lines = [];
  lines.push('# E2E real-site results (ekt.kz)');
  lines.push('');
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`CHAT_URL: ${API}`);
  lines.push('');
  lines.push('| Scenario | Result | Notes |');
  lines.push('| --- | --- | --- |');
  for (const r of results) {
    const notes = (r.reason || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${r.scenario} | ${r.ok ? 'PASS' : 'FAIL'} | ${notes} |`);
  }
  lines.push('');
  lines.push('Screenshots: docs/screenshots/e2e-s1-product.png, e2e-s2-cart.png, e2e-s3a-return-page.png, e2e-s3-return-form.png, e2e-s4-payments.png, e2e-s5-search.png');
  lines.push('');
  const failed = results.filter((r) => !r.ok);
  lines.push(failed.length ? `Overall: FAIL (${results.length - failed.length}/${results.length} passed)` : `Overall: PASS (${results.length}/${results.length})`);
  writeFileSync(resolve(repoRoot, 'e2e/RESULTS.md'), lines.join('\n') + '\n');
}

async function main() {
  console.log(`[e2e] ${new Date().toISOString()} CHAT_URL = ${API}`);
  console.log(`[e2e] headless = ${!HEADED}`);
  const executablePath = findBrowser();
  console.log(`[e2e] browser = ${executablePath}`);
  widgetSource(repoRoot); // fail fast if web/public/widget.js is missing (run `npm run build:web`)

  const browser = await chromium.launch({ executablePath, headless: !HEADED });
  try {
    const s1 = await scenarioS1(browser);
    if (s1) {
      await scenarioS2(s1.page);
      await s1.context.close();
    } else {
      report('S2 click buy_button (add to cart)', false, 'skipped: S1 did not reach a product page');
    }
    await scenarioS3(browser);
    await scenarioS4(browser);
    await scenarioS5(browser);
  } finally {
    await browser.close();
  }

  writeResultsMd();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} scenarios passed`);
  console.log('[e2e] results written to e2e/RESULTS.md');
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('[e2e] fatal:', e);
  process.exit(1);
});
