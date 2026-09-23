import { assertEquals } from "jsr:@std/assert@1";
import {
  canonicalCity,
  compactAttrs,
  compactOutcome,
  escapeLike,
  executeTool,
  navUrlsOf,
  normalizeKzPhone,
  TOOL_DEFS,
  type ToolContext,
  type ToolOutcome,
  truncate,
} from "./tools.ts";
import { collectKnownUrls } from "./ui_actions.ts";
import { evaluateLimits } from "./ratelimit.ts";

/** ToolContext-заглушка для исполнителей, которым не нужна БД (navigate_to/highlight/click_element/
 * fill_form/suggest_replies). `db` — Proxy, который бросает при первом обращении, —
 * так тесты на «отказ до похода в базу» (create_lead без упоминания телефона) падают явно, если
 * порядок проверок в исполнителе случайно изменится. */
function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  const throwingDb = new Proxy({}, {
    get() {
      throw new Error("ctx.db не должен вызываться для этого сценария");
    },
  });
  return {
    db: throwingDb as ToolContext["db"],
    sessionId: "test-session",
    embed: () => Promise.resolve(null),
    knownUrls: new Set<string>(),
    userTexts: [],
    ...over,
  };
}

Deno.test("normalizeKzPhone", () => {
  assertEquals(normalizeKzPhone("+7 701 234 56 78"), "+77012345678");
  assertEquals(normalizeKzPhone("8 (701) 234-56-78"), "+77012345678");
  assertEquals(normalizeKzPhone("87012345678"), "+77012345678");
  assertEquals(normalizeKzPhone("7012345678"), "+77012345678");
  assertEquals(normalizeKzPhone("+7 (727) 346-88-88"), "+77273468888");
  assertEquals(normalizeKzPhone("12345"), null);
  assertEquals(normalizeKzPhone("+7 901 234 56 78"), null); // не казахстанский номер
  assertEquals(normalizeKzPhone("+1 555 123 4567"), null);
  assertEquals(normalizeKzPhone("+7701234567890"), null);
});

Deno.test("compactAttrs: пропускает служебные ключи и ограничивает число", () => {
  const attrs: Record<string, string> = {
    "Артикул": "1",
    "Артикул поставщика": "2",
    "Новинка": "Да",
    "Мощность": "10",
  };
  for (let i = 0; i < 20; i++) attrs[`k${i}`] = `v${i}`;
  const c = compactAttrs(attrs);
  assertEquals(Object.keys(c).length, 12);
  assertEquals(c["Мощность"], "10");
  assertEquals("Артикул" in c, false);
});

Deno.test("escapeLike и truncate", () => {
  assertEquals(escapeLike("150200550_%"), "150200550\\_\\%");
  assertEquals(truncate("abcdef", 3), "abc…");
  assertEquals(truncate(null, 3), "");
});

Deno.test("canonicalCity", () => {
  assertEquals(canonicalCity("Нур-Султан"), "астана");
  assertEquals(canonicalCity("almaty"), "алматы");
  assertEquals(canonicalCity("Өскемен"), "усть-каменогорск");
  assertEquals(canonicalCity("Париж"), "Париж");
});

Deno.test("compactOutcome: товары и ключевые поля", () => {
  const c = compactOutcome({
    name: "search_products",
    args: { query: "x" },
    result: { count: 1, items: [{ url: "https://ekt.kz/a/" }], data_updated_at: "2026-09-23" },
    cards: [{
      id: 1,
      name: "A",
      url: "https://ekt.kz/a/",
      sku: "S",
      brand: null,
      price_site: 10,
      price_store: null,
      image_url: null,
    }],
  });
  assertEquals(c.count, 1);
  assertEquals((c.products as unknown[]).length, 1);
  assertEquals(c.urls, undefined);
});

Deno.test("TOOL_DEFS: все 12 инструментов с уникальными именами (apply_filters упразднён)", () => {
  const names = TOOL_DEFS.map((t) => t.function.name);
  assertEquals(new Set(names).size, 12);
  for (const n of ["navigate_to", "highlight", "click_element", "fill_form", "suggest_replies"]) {
    assertEquals(names.includes(n), true);
  }
  assertEquals(names.includes("apply_filters"), false);
});

Deno.test("navigate_to: описание инструмента упоминает относительный путь и /personal/cart/", () => {
  const def = TOOL_DEFS.find((t) => t.function.name === "navigate_to")!;
  const urlDesc = (def.function.parameters as { properties: { url: { description: string } } }).properties.url
    .description;
  assertEquals(urlDesc.includes("относительный"), true);
  assertEquals(def.function.description.includes("/personal/cart/"), true);
});

Deno.test("evaluateLimits", () => {
  assertEquals(evaluateLimits(19, 59).ok, true);
  assertEquals(evaluateLimits(20, 0).ok, false);
  assertEquals(evaluateLimits(0, 60).ok, false);
});

// ---------------------------------------------------------------------------
// navUrlsOf / compactOutcome.nav_urls — url, допустимые для будущих navigate_to, ТОЛЬКО из
// структурных полей результата (products/item/search_knowledge/успешный navigate), никогда из args.
// ---------------------------------------------------------------------------

Deno.test("navUrlsOf: карточки товаров (search_products/get_product) становятся известны", () => {
  const o: ToolOutcome = {
    name: "search_products",
    args: { query: "лампа" },
    result: { count: 1, items: [{ url: "https://ekt.kz/catalog/lampy/a/" }] },
    cards: [{
      id: 1,
      name: "A",
      url: "https://ekt.kz/catalog/lampy/a/",
      sku: "S",
      brand: null,
      price_site: 10,
      price_store: null,
      image_url: null,
    }],
  };
  assertEquals(navUrlsOf(o), ["https://ekt.kz/catalog/lampy/a/"]);
  assertEquals(compactOutcome(o).nav_urls, ["https://ekt.kz/catalog/lampy/a/"]);
});

Deno.test("navUrlsOf: search_knowledge отдаёт url страниц из items", () => {
  const o: ToolOutcome = {
    name: "search_knowledge",
    args: { query: "возврат" },
    result: {
      count: 1,
      items: [{ url: "https://ekt.kz/about/faq/", title: "FAQ", kind: "faq", heading: null, content: "…" }],
    },
    cards: [],
  };
  assertEquals(navUrlsOf(o), ["https://ekt.kz/about/faq/"]);
});

Deno.test("navUrlsOf: успешный navigate_to добавляет свой собственный url", () => {
  const o: ToolOutcome = {
    name: "navigate_to",
    args: { url: "https://ekt.kz/return/", label: "Открываю" },
    result: { ok: true, note: "…" },
    cards: [],
    uiAction: { type: "navigate", url: "https://ekt.kz/return/", label: "Открываю" },
  };
  assertEquals(navUrlsOf(o), ["https://ekt.kz/return/"]);
});

Deno.test("navUrlsOf: НЕ берёт url из args — отклонённый navigate_to ничего не даёт allow-list'у", () => {
  const rejected: ToolOutcome = {
    name: "navigate_to",
    args: { url: "https://ekt.kz/evil-slug/", label: "…" },
    result: { ok: false, error: "Этот url не встречался…" },
    cards: [],
    // uiAction отсутствует — валидация не прошла.
  };
  assertEquals(navUrlsOf(rejected), []);
  assertEquals(compactOutcome(rejected).nav_urls, undefined);
});

Deno.test("navUrlsOf: НЕ берёт url из args — get_product(url=…) без найденного товара ничего не даёт", () => {
  const notFound: ToolOutcome = {
    name: "get_product",
    args: { url: "https://ekt.kz/not-a-real-product/" },
    result: { found: false, note: "Товар не найден в каталоге ekt.kz." },
    cards: [],
  };
  assertEquals(navUrlsOf(notFound), []);
});

Deno.test("navUrlsOf: url категорий (list_categories) НЕ входят в allow-list navigate_to", () => {
  const o: ToolOutcome = {
    name: "list_categories",
    args: {},
    result: {
      parent_url: null,
      count: 1,
      categories: [{
        url: "https://ekt.kz/catalog/svetilniki/",
        name: "Светильники",
        product_count: 5,
        has_children: true,
      }],
    },
    cards: [],
  };
  assertEquals(navUrlsOf(o), []);
});

Deno.test("round-trip: отклонённый url в ходе N не становится разрешённым в ходе N+1", () => {
  // Ход N: navigate_to с неизвестным url — отклонён.
  const roundN: ToolOutcome = {
    name: "navigate_to",
    args: { url: "https://ekt.kz/evil-slug/", label: "…" },
    result: { ok: false, error: "…" },
    cards: [],
  };
  const historyRecordN = compactOutcome(roundN); // то, что реально уходит в chat_messages.tool_results
  // Ход N+1: knownUrls строится из истории (только nav_urls).
  const knownUrls = collectKnownUrls([(historyRecordN as { nav_urls?: string[] }).nav_urls]);
  assertEquals(knownUrls.has("https://ekt.kz/evil-slug/"), false);
});

// ---------------------------------------------------------------------------
// fill_form / create_lead — телефон допустим только если клиент сам его написал в этом диалоге.
// ---------------------------------------------------------------------------

Deno.test("fill_form: телефон, которого нет в сообщениях клиента, — ошибка, action не создаётся", async () => {
  const ctx = fakeCtx({ userTexts: ["Хочу оформить возврат лампы"] });
  const out = await executeTool(
    "fill_form",
    JSON.stringify({ form: "lead_form", fields: { phone: "+7 701 234 56 78" }, label: "Заполняю" }),
    ctx,
  );
  assertEquals(out.result.ok, false);
  assertEquals(out.uiAction, undefined);
});

Deno.test("fill_form: телефон, который клиент сам написал, — принимается", async () => {
  const ctx = fakeCtx({ userTexts: ["Мой номер +7 701 234 56 78, перезвоните"] });
  const out = await executeTool(
    "fill_form",
    JSON.stringify({
      form: "lead_form",
      fields: { name: "Иван", phone: "8 701 234 56 78", question: "Нужна консультация по лампам" },
      label: "Заполняю заявку",
    }),
    ctx,
  );
  assertEquals(out.result.ok, true);
  assertEquals(out.uiAction?.type, "fill");
});

Deno.test("create_lead: телефон, которого нет в сообщениях клиента, — ошибка, к БД не обращается", async () => {
  const ctx = fakeCtx({ userTexts: ["Хочу лампу E27"] }); // ctx.db бросит, если до него дойдёт
  const out = await executeTool(
    "create_lead",
    JSON.stringify({ phone: "+7 701 234 56 78", request: "Нужна консультация" }),
    ctx,
  );
  assertEquals(out.result.ok, false);
});
