// Mock of the `chat` Edge Function for testing the widget without a backend.
//   node web/dev/mock-server.mjs            → http://localhost:8787
// Then open http://localhost:5173/?api=http://localhost:8787 (npm run dev:web).
//
// Magic words in the message:  "ошибка" → SSE error event · "500" → HTTP 500 JSON
//                              "обрыв"  → stream cut without `done`
// UI actions (SSE `action`, see web/src/actions.ts) on real seed products and real ekt.kz URLs:
//   "корзин"             → (navigate to the product) + highlight price + click buy_button + suggest
//   "перейти в корзину"  → navigate /personal/cart/ · "1 клик" → fill buy_one_click (opens the modal)
//   "возврат"            → navigate /return/ + highlight return_conditions + fill lead_form (question) + suggest
//   "E27 4000" / "тёпл"  → products + fill search + click search_submit + suggest
//   "лампа" / "карточк"  → navigate product + highlight price, buy_button + suggest
//   "характеристик"      → highlight characteristics · "оплат" → navigate /payments/ + highlight payment_methods
//   "астан|филиал|где"   → navigate /about/contacts/ + highlight contacts_phone
//   "заявк|менеджер"     → fill lead_form · "найди" → fill search + click search_submit
// On ekt.kz: load the widget with data-api="http://localhost:8787" (see extension/README.md).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 8787);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRODUCTS = [
  {
    id: 101,
    name: 'Лампа светодиодная LED-A60 10Вт 230В E27 4000К 900Лм IEK',
    url: 'https://ekt.kz/catalog/lampy/lampa-led-a60-10vt-e27-4000k-iek/',
    sku: 'LLE-A60-10-230-40-E27',
    brand: 'IEK',
    price_site: 590,
    price_store: 650,
    image_url: 'https://ekt.kz/bitrix/templates/ekt/images/trade-marks/ekt-main.jpg',
  },
  {
    id: 102,
    name: 'Лампа светодиодная ECO A60 шар 13Вт 230В 3000К E27 TDM',
    url: 'https://ekt.kz/catalog/lampy/lampa-eco-a60-13vt-e27-3000k-tdm/',
    sku: 'SQ0340-0187',
    brand: 'TDM ELECTRIC',
    price_site: 720,
    price_store: null,
    image_url: null,
  },
  {
    id: 103,
    name: 'Автоматический выключатель ВА47-29 1Р 25А 4,5кА х-ка С IEK',
    url: 'https://ekt.kz/catalog/avtomaty/va47-29-1p-25a-c-iek/',
    sku: 'MVA20-1-025-C',
    brand: 'IEK',
    price_site: 1450,
    price_store: 1590,
    image_url: 'https://example.invalid/broken.jpg',
  },
];

/* ── seed products for the "hands" scenarios ───────────── */
let SEED = [];
try {
  SEED = readFileSync(new URL('../../seed/products.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
} catch {
  console.warn('seed/products.jsonl not found: action scenarios use fallback products');
}
const card = (p) =>
  p && { id: p.id, name: p.name, url: p.url, sku: p.sku, brand: p.brand, price_site: p.price_site, price_store: p.price_store, image_url: p.image_url };
const attr = (p, k) => String(p.attrs?.[k] ?? '').trim();
const pick = (fn, n) => SEED.filter(fn).sort((a, b) => (a.price_site || 1e9) - (b.price_site || 1e9)).slice(0, n);
const fmt = (v) => (v ? new Intl.NumberFormat('ru-RU').format(v) + ' ₸' : 'цена по запросу');
let lastProduct = null; // "Открыть карточку" / "Добавить в корзину" refer to it
const onPage = (ctx, url) => (ctx.page_url || '').replace(/\/+$/, '') === String(url || '').replace(/\/+$/, '');

const PHONE = '+7 701 123-45-67';
const SCENARIOS = [
  {
    test: /перейти в корзин|открой корзин|оформить заказ/i,
    status: [['navigate_to', 'Открываю корзину…']],
    build: () => ({
      text: 'Открываю корзину ekt.kz: проверьте количество и оформите заказ — оформление остаётся за вами.',
      products: [],
      actions: [
        { type: 'navigate', url: 'https://ekt.kz/personal/cart/', label: 'Открываю корзину' },
        { type: 'highlight', target: 'cart', note: 'Ваша корзина' },
      ],
    }),
  },
  {
    test: /корзин/i,
    status: [['search_products', 'Ищу лампу…']],
    build(ctx) {
      const e14 = /e14|люстр/i.test(ctx.message) && pick((x) => attr(x, 'Тип цоколя') === 'E14', 1)[0];
      const p = e14 || lastProduct || pick((x) => attr(x, 'Тип цоколя') === 'E14', 1)[0] || PRODUCTS[0];
      lastProduct = p;
      const here = onPage(ctx, p.url);
      return {
        text:
          `Добавляю в корзину **${p.name}** — ${fmt(p.price_site)} на сайте.\n\n` +
          (here ? '' : 'Сначала открою карточку, затем нажму «Купить». ') +
          'Оформить заказ можно в корзине ekt.kz.',
        products: [card(p)],
        actions: [
          ...(here ? [] : [{ type: 'navigate', url: p.url, label: 'Открываю карточку товара' }]),
          { type: 'highlight', target: 'price', note: 'Цена на сайте' },
          { type: 'click', target: 'buy_button', label: 'Нажимаю «Купить»' },
          { type: 'suggest', options: ['Перейти в корзину', 'Купить в 1 клик'] },
        ],
      };
    },
  },
  {
    test: /1 клик|один клик/i,
    status: [['get_product', 'Готовлю заказ в 1 клик…']],
    build: () => ({
      text: 'Открываю «Купить в 1 клик» и вписываю ваши данные. **Проверьте и нажмите «Отправить»** — сам я форму не отправляю.',
      products: [],
      actions: [{ type: 'fill', form: 'buy_one_click', label: 'Заполняю «Купить в 1 клик»', fields: { name: 'Айгерим', phone: PHONE, email: 'aigerim@example.kz' } }],
    }),
  },
  {
    test: /возврат|вернуть/i,
    status: [['search_knowledge', 'Смотрю условия возврата…']],
    build: () => ({
      text:
        'Товар надлежащего качества можно вернуть или обменять в течение **14 дней**, если он не был в употреблении и сохранены упаковка и чек.\n\n' +
        'Открываю условия возврата и готовлю заявку менеджеру с вашими данными. **Проверьте и нажмите «Отправить»** — сам я форму не отправляю.',
      products: [],
      actions: [
        { type: 'navigate', url: 'https://ekt.kz/return/', label: 'Открываю условия возврата' },
        { type: 'highlight', target: 'return_conditions', note: 'Условия возврата и обмена' },
        {
          type: 'fill',
          form: 'lead_form',
          label: 'Заполняю заявку на возврат',
          fields: {
            name: 'Айгерим Нурланова',
            phone: PHONE,
            email: 'aigerim@example.kz',
            question: 'Возврат: заказ № EKT-102938 от 15.09.2026, товар — LED лампа A60 10W E27 4000K MEGALIGHT, причина — не подошёл цоколь, упаковка не вскрыта.',
          },
        },
        { type: 'suggest', options: ['Где ближайший филиал?', 'Как оплатить заказ?'] },
      ],
    }),
  },
  {
    test: /e27.*(4000|тёпл|тепл)|(4000|тёпл|тепл).*e27|тёплого света/i,
    status: [['category_facets', 'Смотрю характеристики ламп…'], ['search_products', 'Подбираю лампы…']],
    build(ctx) {
      const neutral = /4000/.test(ctx.message);
      const temps = neutral ? ['4000'] : ['2700', '3000'];
      const items = pick((x) => attr(x, 'Тип цоколя') === 'E27' && temps.includes(attr(x, 'Цветовая температура')), 3);
      lastProduct = items[0] || lastProduct;
      const q = neutral ? 'лампа E27 4000K' : 'лампа E27 3000K';
      return {
        text:
          `Вот лампы с цоколем **E27** и ${neutral ? 'нейтральным светом **4000K**' : 'тёплым светом **2700–3000K**'}:\n\n` +
          items.map((x) => `- [${x.name}](${x.url}) — **${fmt(x.price_site)}**`).join('\n') +
          `\n\nИщу на сайте «${q}», чтобы вы увидели все варианты.`,
        products: items.map(card),
        actions: [
          { type: 'fill', form: 'search', label: 'Ввожу запрос в поиск', fields: { q } },
          { type: 'click', target: 'search_submit', label: 'Ищу на ekt.kz' },
          { type: 'suggest', options: ['Открыть карточку', 'Добавить в корзину'] },
        ],
      };
    },
  },
  {
    test: /карточк/i,
    status: [['get_product', 'Открываю товар…']],
    build() {
      const p = lastProduct || pick((x) => attr(x, 'Тип цоколя') === 'E27', 1)[0] || PRODUCTS[0];
      lastProduct = p;
      return {
        text: `Открываю карточку **${p.name}**: цена на сайте ${fmt(p.price_site)}${p.price_store ? `, в магазине ${fmt(p.price_store)}` : ''}.`,
        products: [],
        actions: [
          { type: 'navigate', url: p.url, label: 'Открываю карточку товара' },
          { type: 'highlight', target: 'price', note: 'Цена на сайте' },
          { type: 'highlight', target: 'buy_button', note: 'Кнопка «Купить»' },
          { type: 'suggest', options: ['Добавить в корзину', 'Показать характеристики'] },
        ],
      };
    },
  },
  {
    test: /характеристик/i,
    status: [['get_product', 'Смотрю характеристики…']],
    build: () => ({
      text: 'Показываю характеристики на карточке: цоколь, мощность, цветовая температура и форма колбы.',
      products: [],
      actions: [{ type: 'highlight', target: 'characteristics', note: 'Характеристики товара' }],
    }),
  },
  {
    test: /оплат|доставк/i,
    status: [['search_knowledge', 'Смотрю условия оплаты…']],
    build: () => ({
      text: 'Физлица платят картой онлайн, наличными при получении или картой в торговом зале; юрлица — по счёту. Показываю на странице оплаты.',
      products: [],
      actions: [
        { type: 'navigate', url: 'https://ekt.kz/payments/', label: 'Открываю оплату' },
        { type: 'highlight', target: 'payment_methods', note: 'Способы оплаты' },
      ],
    }),
  },
  {
    test: /астан|филиал|адрес|контакт|где вы/i,
    status: [['get_branches', 'Смотрю филиалы…']],
    build: () => ({
      text:
        '### Астана\n- Адрес: район Байконыр, Жетиген, 28\n- Телефоны: +7 (700) 222 05 14, +7 (747) 222 05 21\n- График: пн–пт 09:00–18:00, сб 09:00–13:00, обед 13:00–14:00\n\nОткрываю страницу контактов.',
      products: [],
      actions: [
        { type: 'navigate', url: 'https://ekt.kz/about/contacts/', label: 'Открываю контакты' },
        { type: 'highlight', target: 'contacts_phone', note: 'Телефоны филиалов' },
        { type: 'suggest', options: ['Оставить заявку менеджеру', 'Как оплатить заказ?'] },
      ],
    }),
  },
  {
    test: /заявк|менеджер|перезвон/i,
    status: [['create_lead', 'Готовлю заявку…']],
    build: () => ({
      text: 'Открываю форму «Оставить заявку» и вписываю данные. Проверьте и нажмите «Отправить» — менеджер перезвонит.',
      products: [],
      actions: [
        {
          type: 'fill',
          form: 'lead_form',
          label: 'Заполняю заявку',
          fields: { name: 'Айгерим', phone: PHONE, email: 'aigerim@example.kz', question: 'Нужно 20 ламп E27 4000K для офиса, Астана.' },
        },
      ],
    }),
  },
  {
    test: /найди|поиск/i,
    status: [['search_products', 'Ищу…']],
    build: () => ({
      text: 'Ввожу запрос в поиск ekt.kz.',
      products: [],
      actions: [
        { type: 'fill', form: 'search', label: 'Ввожу запрос', fields: { q: 'Philips' } },
        { type: 'click', target: 'search_submit', label: 'Ищу на ekt.kz' },
      ],
    }),
  },
  {
    test: /ламп|лампоч/i,
    status: [['search_products', 'Ищу лампы…']],
    build() {
      const items = pick((x) => attr(x, 'Тип цоколя') === 'E27' && attr(x, 'Цветовая температура') === '4000', 2);
      lastProduct = items[0] || lastProduct;
      return {
        text:
          'Для дома чаще всего берут светодиодные лампы с цоколем **E27**:\n\n' +
          items.map((x) => `- [${x.name}](${x.url}) — **${fmt(x.price_site)}**`).join('\n') +
          '\n\nОткрываю карточку первой и показываю цену.',
        products: items.map(card),
        actions: items.length
          ? [
              { type: 'navigate', url: items[0].url, label: 'Открываю карточку товара' },
              { type: 'highlight', target: 'price', note: 'Цена на сайте' },
              { type: 'highlight', target: 'buy_button', note: 'Можно сразу купить' },
              { type: 'suggest', options: ['Добавить в корзину', 'Показать характеристики'] },
            ]
          : [],
      };
    },
  },
];

const ANSWERS = [
  {
    test: /автомат|25\s*а/i,
    status: [['search_products', 'Ищу автоматы…'], ['get_product', 'Проверяю характеристики…']],
    text:
      'Для линии на **25 А** подойдёт однополюсный автомат с характеристикой **C** — стандарт для розеточных групп и освещения.\n\n' +
      '1. [ВА47-29 1Р 25А 4,5кА х-ка С IEK](https://ekt.kz/catalog/avtomaty/va47-29-1p-25a-c-iek/) — **1 450 ₸** на сайте, арт. `MVA20-1-025-C`.\n\n' +
      'Сечение кабеля для 25 А — не меньше *2,5 мм² по меди*. Для проекта щита лучше посоветоваться с электриком или менеджером филиала.',
    products: [PRODUCTS[2]],
  },
  {
    test: /филиал|адрес|график/i,
    status: [['get_branches', 'Смотрю филиалы…']],
    text:
      '### Алматы\n- Адрес: уточните на странице контактов\n- Телефон: +7 727 346-88-88\n- График: пн–пт 9:00–18:00, сб 9:00–15:00\n\n' +
      '| Город | Телефон |\n|---|---|\n| Алматы | +7 727 346-88-88 |\n| Астана | уточняется |\n\n' +
      'Полный список: https://ekt.kz/about/contacts/.',
    products: [],
  },
  {
    test: /./,
    status: [['search_products', 'Ищу товары…']],
    text:
      'Для дома чаще всего берут светодиодные лампы с цоколем **E27**:\n\n' +
      '- [LED-A60 10 Вт 4000К IEK](https://ekt.kz/catalog/lampy/lampa-led-a60-10vt-e27-4000k-iek/) — **590 ₸**, нейтральный белый свет, замена лампы накаливания 75 Вт;\n' +
      '- [ECO A60 13 Вт 3000К TDM](https://ekt.kz/catalog/lampy/lampa-eco-a60-13vt-e27-3000k-tdm/) — **720 ₸**, тёплый свет для спальни и гостиной.\n\n' +
      'Цены указаны для Алматы. Наличие лучше уточнить у менеджера филиала. <img src=x onerror=alert(1)> [xss](javascript:alert(1))',
    products: [PRODUCTS[0], PRODUCTS[1]],
  },
];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, apikey, x-client-info');
}

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  try {
    return JSON.parse(body || '{}');
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'POST') return res.writeHead(405, { 'Content-Type': 'application/json' }).end('{"error":"method"}');

  const path = new URL(req.url || '/', 'http://x').pathname.replace(/\/+$/, '');
  const body = await readJson(req);
  if (!body) return res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"Некорректный JSON"}');

  if (path.endsWith('/feedback')) {
    console.log('feedback', body);
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  const message = String(body.message || '');
  console.log('chat', { session_id: body.session_id, message, page_url: body.page_url });
  if (!message.trim() || message.length > 2000)
    return res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"Сообщение пустое или длиннее 2000 символов"}');
  if (/\b500\b/.test(message))
    return res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Сервис временно недоступен (тест)."}');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  let closed = false;
  req.on('close', () => (closed = true));
  const send = (event, data) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('session', { session_id: body.session_id || randomUUID() });
  const scenario = SCENARIOS.find((a) => a.test.test(message));
  const answer = scenario
    ? { status: scenario.status, ...scenario.build({ message, page_url: String(body.page_url || '') }) }
    : ANSWERS.find((a) => a.test.test(message));
  for (const [tool, label] of answer.status) {
    send('status', { tool, label });
    await sleep(700);
  }
  if (/ошибка/i.test(message)) {
    send('error', { message: 'Не удалось обратиться к каталогу. Позвоните нам: +7 727 346-88-88.' });
    return res.end();
  }
  // Stream in small uneven chunks, splitting events across writes like a real proxy would.
  const text = answer.text;
  for (let i = 0; i < text.length && !closed; ) {
    const n = 3 + Math.floor(Math.random() * 10);
    const frame = `event: delta\ndata: ${JSON.stringify({ text: text.slice(i, i + n) })}\n\n`;
    const cut = Math.floor(frame.length / 2);
    res.write(frame.slice(0, cut));
    await sleep(8);
    res.write(frame.slice(cut));
    i += n;
    await sleep(22);
    if (/обрыв/i.test(message) && i > text.length / 2) return res.destroy();
  }
  if (answer.products.length) send('products', { items: answer.products });
  for (const a of answer.actions || []) send('action', a);
  send('done', { message_id: Math.floor(Math.random() * 1e6) });
  res.end();
}).listen(PORT, () => console.log(`Mock chat API on http://localhost:${PORT}  (POST /, POST /feedback)`));
