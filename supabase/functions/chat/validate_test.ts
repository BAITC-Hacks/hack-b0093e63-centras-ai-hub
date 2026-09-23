import { assertEquals } from "jsr:@std/assert@1";
import {
  collectKnown,
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
