// Live check of the consultant's "hands" on the REAL https://ekt.kz with headless Chrome (CDP, no extra deps).
// The widget is injected into every ekt.kz page the same way the extension does it (a <script> in the page's
// own world), the chat API is the local mock (node web/dev/mock-server.mjs). Nothing is submitted on the site:
// forms are only filled, the «Купить» click is cancelled with «Отмена».
//
//   node web/dev/mock-server.mjs &
//   npm run build:web && node web/dev/ekt-live.mjs          → screenshots in docs/screenshots/
//   CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node web/dev/ekt-live.mjs
//   node web/dev/ekt-live.mjs --icons                        → regenerate extension/icons/*.png
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const OUT = resolve(repo, 'docs/screenshots');
const API = process.env.API || 'http://localhost:8787';
const PORT = 9335;
const CHROME =
  process.env.CHROME ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => existsSync(p));
if (!CHROME) throw new Error('Chrome not found: set CHROME=/path/to/chrome');

const WIDGET = readFileSync(resolve(repo, 'web/public/widget.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const PROFILE = resolve(repo, 'node_modules/.cache/ekt-live-chrome');
rmSync(PROFILE, { recursive: true, force: true }); // a fresh browser: no chat or basket from earlier runs

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--hide-scrollbars',
    '--window-size=1440,900',
    // The mock API runs on http://localhost: let an https page talk to it (test browser only).
    '--disable-web-security',
    '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let seq = 0;
const pending = new Map();
const logs = [];
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) {
            const { ok, fail } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
          } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
            const text = msg.params.args.map((a) => a.value ?? a.description).join(' ');
            if (/EKT|ekt-/i.test(text)) logs.push(text);
          } else if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            if (/widget|EKT/i.test(JSON.stringify(d))) logs.push('exception: ' + (d.exception?.description || d.text));
          }
        };
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}
const send = (method, params = {}) =>
  new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)} → ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expression, ms = 15000, label = expression) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await evaluate(expression)) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(500);
  await waitFor('document.readyState !== "loading"', 30000, 'load ' + url);
}
async function viewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('  screenshot', `docs/screenshots/${name}.png`);
}
const inOverlay = (sel) => `!!document.querySelector('[data-ekt-overlay]')?.shadowRoot?.querySelector('${sel}')`;
const replies = () => `document.getElementById('ekt-consultant')?.shadowRoot?.querySelectorAll('.row.assistant .fb').length || 0`;
async function ask(text) {
  const before = await evaluate(replies());
  await evaluate(`window.EKTConsultant.ask(${JSON.stringify(text)}), true`);
  return before;
}
const answered = (before) => `${replies()} > ${before}`;

async function icons() {
  const svg = (size) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="#2c7294"/>` +
    `<path d="M17.5 5 8 18h7l-1.5 9L24 14h-7z" fill="#f4b301"/></svg>`;
  mkdirSync(resolve(repo, 'extension/icons'), { recursive: true });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const size of [16, 48, 128]) {
    await viewport(size, size);
    await goto(`data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg(size))}</body>`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    writeFileSync(resolve(repo, `extension/icons/icon${size}.png`), Buffer.from(data, 'base64'));
    console.log('  icon', size);
  }
  await send('Emulation.setDefaultBackgroundColorOverride', {});
}

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

step('catalog: search «лампа E27 4000K» (fill search + click search_submit)', async () => {
  await viewport(1440, 900);
  await goto('https://ekt.kz/catalog/svetilniki_lampy/lampy/');
  await waitFor('!!window.EKTConsultant', 20000, 'widget on ekt.kz');
  await shot('ekt-01-catalog-with-widget');
  const n = await ask('Подбери лампу E27 4000K');
  await waitFor(answered(n), 30000, 'reply');
  await waitFor(inOverlay('.plate'), 8000, 'search plate');
  await sleep(500);
  await shot('ekt-02-search-filled');
  await waitFor(`location.search.includes('q=')`, 20000, 'search results page');
  await waitFor('!!window.EKTConsultant', 20000);
  await sleep(2500);
  await shot('ekt-03-search-results');
});

step('open the product card: navigate + highlight price and «Купить»', async () => {
  const n = await ask('Открыть карточку');
  await waitFor(answered(n), 30000, 'reply');
  await waitFor(inOverlay('.plate'), 8000, 'navigate plate');
  await sleep(600);
  await shot('ekt-04-navigate-plate');
  await waitFor(`!!document.querySelector('.detail_info__price__site')`, 30000, 'product page');
  await waitFor(inOverlay('.ring'), 15000, 'ring on the price');
  await sleep(1200);
  await shot('ekt-05-price-highlight');
});

step('«Добавь в корзину»: plate «Нажимаю «Купить» · Отмена» (cancelled: nothing is sent to ekt.kz)', async () => {
  const n = await ask('Добавь в корзину');
  await waitFor(answered(n), 30000, 'reply');
  await waitFor(inOverlay('.plate button'), 8000, 'click plate');
  await sleep(500);
  await shot('ekt-06-buy-plate');
  await evaluate(`document.querySelector('[data-ekt-overlay]').shadowRoot.querySelector('.plate button').click(), true`);
});

step('«Оставить заявку»: opens the site modal and fills it (not submitted)', async () => {
  const n = await ask('Оставить заявку менеджеру');
  await waitFor(answered(n), 30000, 'reply');
  await waitFor(`document.querySelector('#zayavka input[name="name"]')?.value === 'Айгерим'`, 10000, 'lead form filled');
  await sleep(1200);
  await shot('ekt-07-lead-form-filled');
  const values = await evaluate(
    `Object.fromEntries(['name','email','phone','question'].map((n) => [n, document.querySelector('#zayavka [name="' + n + '"]').value]))`,
  );
  console.log('  form values', values);
  await evaluate(`window.jQuery ? jQuery('#zayavka').modal('hide') : 0, true`);
});

step('«Хочу оформить возврат»: /return/ + conditions + lead form with the return details', async () => {
  const n = await ask('Хочу оформить возврат');
  await waitFor(answered(n), 30000, 'reply');
  await waitFor(`location.pathname === '/return/'`, 20000, 'return page');
  await waitFor(`(document.querySelector('#zayavka [name="question"]')?.value || '').startsWith('Возврат')`, 20000, 'return request filled');
  await sleep(1200);
  await shot('ekt-08-return-request-filled');
  await evaluate(`window.jQuery ? jQuery('#zayavka').modal('hide') : 0, true`);
  await sleep(600);
  await shot('ekt-09-return-conditions');
});

step('«Где вы находитесь в Астане?»: contacts + phone highlight', async () => {
  const n = await ask('Где вы находитесь в Астане?');
  await waitFor(answered(n), 30000, 'reply');
  await waitFor(`location.pathname === '/about/contacts/'`, 20000, 'contacts page');
  await waitFor(inOverlay('.ring'), 15000, 'ring on a phone');
  await sleep(1200);
  await shot('ekt-10-contacts-phone');
});

step('phone: characteristics highlight on a product card', async () => {
  await viewport(390, 844, true);
  await goto('https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/led_lampa_a60_standart_10w_900lm_230v_4000k_e27_megalight_100/');
  await waitFor('!!window.EKTConsultant', 20000);
  const n = await ask('Покажи характеристики');
  await waitFor(answered(n), 30000, 'reply');
  await waitFor(inOverlay('.ring'), 15000, 'ring on characteristics');
  await sleep(1200);
  await shot('ekt-11-mobile-characteristics');
});

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  if (process.argv.includes('--icons')) {
    await icons();
  } else {
    // Inject the widget into every ekt.kz document, as extension/content.js does.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `if (/(^|\\.)ekt\\.kz$/.test(location.hostname)) document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('script');
        s.setAttribute('data-api', ${JSON.stringify(API)});
        s.textContent = ${JSON.stringify(WIDGET)};
        document.body.appendChild(s);
      });`,
    });
    let failed = 0;
    for (const [name, fn] of steps) {
      console.log('•', name);
      try {
        await fn();
      } catch (e) {
        failed++;
        console.error('  FAIL', e.message);
        await shot('ekt-zz-failure').catch(() => {});
      }
    }
    console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
    process.exitCode = failed ? 1 : 0;
  }
} finally {
  if (logs.length) console.log('console:', logs.slice(0, 20));
  chrome.kill();
}
