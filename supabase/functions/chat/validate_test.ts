import { assertEquals } from "jsr:@std/assert@1";
import {
  collectKnown,
  detectClaimedActionTypes,
  extractPrices,
  extractUrls,
  normalizeUrl,
  pickMentionedProducts,
  validateAnswer,
} from "./validate.ts";

const toolResult = {
  args: { query: "лампа E27" },
  result: {
    count: 2,
    items: [
      {
        id: 1,
        name: "Лампа LED A60 10W E27 4000K",
        url: "https://ekt.kz/catalog/lampy/lampa-a60-10w/",
        sku: "150200550_",
        price_site: 1250,
        price_store: 1390.5,
      },
      {
        id: 2,
        name: "Лампа LED A60 12W E27",
        url: "https://ekt.kz/catalog/lampy/lampa-a60-12w/",
        sku: "150200551_",
        price_site: 12990,
        price_store: null,
      },
    ],
  },
};

Deno.test("extractUrls: markdown и голые ссылки, без хвостовой пунктуации", () => {
  const text =
    "Смотрите [лампу](https://ekt.kz/catalog/lampy/lampa-a60-10w/) и https://www.ekt.kz/about/contacts/. Также https://google.com";
  const urls = extractUrls(text).map(normalizeUrl);
  assertEquals(urls, ["https://ekt.kz/catalog/lampy/lampa-a60-10w", "https://ekt.kz/about/contacts"]);
});

Deno.test("normalizeUrl: www, http, слэш, регистр, якорь", () => {
  assertEquals(normalizeUrl("http://www.EKT.kz/Catalog/X/#tab"), "https://ekt.kz/catalog/x");
  assertEquals(normalizeUrl("https://ekt.kz"), "https://ekt.kz/");
  assertEquals(normalizeUrl("https://ekt.kz/"), "https://ekt.kz/");
});

Deno.test("extractPrices: разделители тысяч, копейки, варианты валюты", () => {
  assertEquals(extractPrices("цена 1 250 ₸, в магазине 1 390,50 ₸"), [1250, 1390.5]);
  assertEquals(extractPrices("12 990 тг и 5000 тенге, 700тг."), [12990, 5000, 700]);
  assertEquals(extractPrices("1 000 000 ₸"), [1000000]);
  assertEquals(extractPrices("10 Вт, 4000 К, E27"), []);
  assertEquals(extractPrices("3 шт по 450 ₸"), [450]);
  assertEquals(extractPrices("тгк 100"), []);
  assertEquals(extractPrices("**2 500 ₸**"), [2500]);
});

Deno.test("validateAnswer: корректный ответ без флагов", () => {
  const answer =
    "- [Лампа LED A60 10W](https://ekt.kz/catalog/lampy/lampa-a60-10w/) — арт. 150200550_, **1 250 ₸** на сайте (в магазине 1 390,50 ₸)";
  assertEquals(validateAnswer({ answer, toolData: [toolResult], toolCalled: true }), {});
});

Deno.test("validateAnswer: выдуманная ссылка и цена", () => {
  const answer =
    "[Лампа](https://ekt.kz/catalog/lampy/fake/) — 999 ₸, а [другая](https://ekt.kz/catalog/lampy/lampa-a60-12w) — 12 990 ₸";
  const flags = validateAnswer({ answer, toolData: [toolResult], toolCalled: true });
  assertEquals(flags.unknown_urls, ["https://ekt.kz/catalog/lampy/fake"]);
  assertEquals(flags.unmatched_prices, [999]);
  assertEquals(flags.no_tool_price, undefined);
});

Deno.test("validateAnswer: цена без вызова инструмента", () => {
  const flags = validateAnswer({ answer: "Айфон стоит 500 000 ₸", toolData: [], toolCalled: false });
  assertEquals(flags.no_tool_price, true);
  assertEquals(flags.unmatched_prices, [500000]);
});

Deno.test("validateAnswer: бюджет клиента и цены из текста базы знаний считаются известными", () => {
  const knowledge = {
    result: { items: [{ url: "https://ekt.kz/about/delivery/", content: "Бесплатная доставка от 30 000 ₸" }] },
  };
  const answer =
    "Доставка бесплатна от 30 000 ₸ ([подробнее](https://ekt.kz/about/delivery/)). Под ваш бюджет до 5 000 ₸ нашёл лампу за 1 250 ₸.";
  const flags = validateAnswer({
    answer,
    toolData: [toolResult, knowledge],
    toolCalled: true,
    extraTexts: ["подбери лампу до 5000"],
  });
  assertEquals(flags, {});
});

Deno.test("validateAnswer: главная страница ekt.kz разрешена всегда", () => {
  assertEquals(validateAnswer({ answer: "Сайт: https://ekt.kz/", toolData: [], toolCalled: false }), {});
});

Deno.test("validateAnswer: прошлая цена товара (price_changed / price_site_prev) считается известной", () => {
  const priceChangeResult = {
    args: { query: "лампа E27" },
    result: {
      count: 1,
      items: [
        {
          id: 3,
          name: "Лампа LED A60 8W E27",
          url: "https://ekt.kz/catalog/lampy/lampa-a60-8w/",
          sku: "150200552_",
          price_site: 1500,
          price_store: 1600,
          price_changed: { from: 1300, at: "2026-09-10" },
        },
      ],
    },
  };
  const answer =
    "- [Лампа LED A60 8W](https://ekt.kz/catalog/lampy/lampa-a60-8w/) — арт. 150200552_, **1 500 ₸** на сайте " +
    "(в магазине 1 600 ₸). Цена изменилась с 1 300 ₸ на 1 500 ₸ (2026-09-10).";
  assertEquals(validateAnswer({ answer, toolData: [priceChangeResult], toolCalled: true }), {});

  const getProductResult = {
    args: { id: 3 },
    result: {
      found: true,
      item: {
        id: 3,
        price_site: 1500,
        price_store: 1600,
        price_site_prev: 1300,
        price_store_prev: 1400,
        price_changed_at: "2026-09-10",
      },
    },
  };
  const answer2 = "Раньше стоила 1 300 ₸, теперь **1 500 ₸**; в магазине было 1 400 ₸, стало 1 600 ₸.";
  assertEquals(validateAnswer({ answer: answer2, toolData: [getProductResult], toolCalled: true }), {});
});

Deno.test("collectKnown: цены-строки из numeric и вложенные объекты", () => {
  const k = collectKnown([{ price_site: "1500.00", nested: [{ price_store: 2000 }] }]);
  assertEquals(k.prices.sort(), [1500, 2000]);
});

Deno.test("pickMentionedProducts: порядок по первому упоминанию, дедуп, лимит, fallback по артикулу", () => {
  const cards = [
    { id: 1, url: "https://ekt.kz/catalog/a/", sku: "AAA111" },
    { id: 2, url: "https://ekt.kz/catalog/b/", sku: "BBB222" },
    { id: 3, url: "https://ekt.kz/catalog/c/", sku: "CCC333" },
    { id: 1, url: "https://ekt.kz/catalog/a/", sku: "AAA111" },
  ];
  const answer =
    "Сначала [B](https://ekt.kz/catalog/b), потом артикул ccc333, затем [A](https://www.ekt.kz/catalog/a/) и снова [B](https://ekt.kz/catalog/b/)";
  assertEquals(pickMentionedProducts(answer, cards, 6).map((c) => c.id), [2, 3, 1]);
  assertEquals(pickMentionedProducts(answer, cards, 2).map((c) => c.id), [2, 3]);
  assertEquals(pickMentionedProducts("ничего", cards, 6), []);
});

// ---------------------------------------------------------------------------
// pickMentionedProducts: pinnedUrl — карточка товара, на который идёт navigate, показывается
// первой, даже если ответ не содержит текстовой ссылки на него.
// ---------------------------------------------------------------------------

const pinCards = [
  { id: 1, url: "https://ekt.kz/catalog/a/", sku: "AAA111" },
  { id: 2, url: "https://ekt.kz/catalog/b/", sku: "BBB222" },
  { id: 3, url: "https://ekt.kz/catalog/c/", sku: "CCC333" },
];

Deno.test("pickMentionedProducts: pinnedUrl без текстовых упоминаний — карточка добавляется первой", () => {
  const out = pickMentionedProducts("Открываю карточку товара…", pinCards, 6, "https://ekt.kz/catalog/b/");
  assertEquals(out.map((c) => c.id), [2]);
});

Deno.test("pickMentionedProducts: pinnedUrl упомянут позже других в тексте — всё равно выходит первым", () => {
  const answer = "Сначала [A](https://ekt.kz/catalog/a/), затем [C](https://ekt.kz/catalog/c/)";
  const out = pickMentionedProducts(answer, pinCards, 6, "https://ekt.kz/catalog/c/");
  assertEquals(out.map((c) => c.id), [3, 1]);
});

Deno.test("pickMentionedProducts: pinnedUrl — нормализация (www./хвостовой /) учитывается", () => {
  const out = pickMentionedProducts("текст", pinCards, 6, "https://www.ekt.kz/catalog/b");
  assertEquals(out.map((c) => c.id), [2]);
});

Deno.test("pickMentionedProducts: pinnedUrl без карточки с таким url — просто игнорируется", () => {
  const out = pickMentionedProducts("текст", pinCards, 6, "https://ekt.kz/catalog/does-not-exist/");
  assertEquals(out, []);
});

Deno.test("pickMentionedProducts: pinnedUrl уважает лимит max (обрезает вместе с остальными)", () => {
  const answer = "Сначала [A](https://ekt.kz/catalog/a/), затем [B](https://ekt.kz/catalog/b/)";
  const out = pickMentionedProducts(answer, pinCards, 1, "https://ekt.kz/catalog/c/");
  assertEquals(out.map((c) => c.id), [3]);
});

Deno.test("pickMentionedProducts: без pinnedUrl (undefined/null) — поведение как раньше", () => {
  const answer = "Сначала [A](https://ekt.kz/catalog/a/)";
  assertEquals(pickMentionedProducts(answer, pinCards, 6).map((c) => c.id), [1]);
  assertEquals(pickMentionedProducts(answer, pinCards, 6, null).map((c) => c.id), [1]);
});

// ---------------------------------------------------------------------------
// detectClaimedActionTypes / claimed_action_without_tool — ответ не должен утверждать, что
// действие на сайте выполнено/выполняется, если соответствующий action не отправлен.
// ---------------------------------------------------------------------------

Deno.test("detectClaimedActionTypes: находит заявления о действиях по стемам из живого прогона", () => {
  assertEquals(detectClaimedActionTypes("Добавляю лампочку в корзину…"), new Set(["click"]));
  assertEquals(detectClaimedActionTypes("Открываю карточку самой дешёвой лампочки за 169 ₸."), new Set(["navigate"]));
  assertEquals(detectClaimedActionTypes("Заполняю заявление на возврат."), new Set(["fill"]));
  assertEquals(detectClaimedActionTypes("Применяю фильтры по цоколю E27."), new Set(["filter"]));
  assertEquals(detectClaimedActionTypes("Перехожу на страницу оплаты."), new Set(["navigate"]));
  assertEquals(detectClaimedActionTypes("Уточните, пожалуйста, город."), new Set());
});

Deno.test("validateAnswer: заявленное действие без action — флаг claimed_action_without_tool", () => {
  const flags = validateAnswer({
    answer: "Добавляю лампочку в корзину…",
    toolData: [],
    toolCalled: true,
    actionTypes: [], // click_element не вызван в этом ходе
  });
  assertEquals(flags.claimed_action_without_tool, ["click"]);
});

Deno.test("validateAnswer: заявленное действие С соответствующим action — флага нет", () => {
  const flags = validateAnswer({
    answer: "Открываю карточку товара…",
    toolData: [],
    toolCalled: true,
    actionTypes: ["navigate", "highlight"],
  });
  assertEquals(flags.claimed_action_without_tool, undefined);
});

Deno.test("validateAnswer: без actionTypes (не передан) поведение как «ничего не отправлено»", () => {
  const flags = validateAnswer({
    answer: "Заполняю форму возврата.",
    toolData: [],
    toolCalled: true,
  });
  assertEquals(flags.claimed_action_without_tool, ["fill"]);
});

Deno.test("validateAnswer: обычный текст без заявлений о действии — флага нет", () => {
  const flags = validateAnswer({
    answer: "Вот подходящие лампы E27 тёплого света до 1000 ₸.",
    toolData: [],
    toolCalled: true,
    actionTypes: [],
  });
  assertEquals(flags.claimed_action_without_tool, undefined);
});
