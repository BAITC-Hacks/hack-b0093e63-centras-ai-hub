// Mock of the `chat` Edge Function for testing the widget without a backend.
//   node web/dev/mock-server.mjs            → http://localhost:8787
// Then open http://localhost:5173/?api=http://localhost:8787 (npm run dev:web).
//
// Magic words in the message:  "ошибка" → SSE error event · "500" → HTTP 500 JSON
//                              "обрыв"  → stream cut without `done`
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

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
  const answer = ANSWERS.find((a) => a.test.test(message));
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
  send('done', { message_id: Math.floor(Math.random() * 1e6) });
  res.end();
}).listen(PORT, () => console.log(`Mock chat API on http://localhost:${PORT}  (POST /, POST /feedback)`));
