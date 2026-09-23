import { assertEquals } from "jsr:@std/assert@1";
import {
  CLICK_TARGETS,
  collectKnownUrls,
  collectTurnActions,
  FORMS,
  MAX_HIGHLIGHT,
  normalizeEktUrl,
  normalizeKzPhone,
  TARGETS,
  type UiAction,
  validateClick,
  validateFill,
  validateFilter,
  validateHighlight,
  validateNavigate,
  validateSuggest,
} from "./ui_actions.ts";

// ---------------------------------------------------------------------------
// normalizeEktUrl / validateNavigate
// ---------------------------------------------------------------------------

Deno.test("normalizeEktUrl: http→https, без www., без хвостового /", () => {
  assertEquals(normalizeEktUrl("http://ekt.kz/catalog/lampy/x/"), "https://ekt.kz/catalog/lampy/x");
  assertEquals(normalizeEktUrl("https://www.ekt.kz/catalog/lampy/x"), "https://ekt.kz/catalog/lampy/x");
  assertEquals(normalizeEktUrl("https://ekt.kz"), "https://ekt.kz/");
  assertEquals(normalizeEktUrl("https://ekt.kz/"), "https://ekt.kz/");
  assertEquals(normalizeEktUrl("https://google.com/"), null);
  assertEquals(normalizeEktUrl(""), null);
  assertEquals(normalizeEktUrl("not a url"), null);
});

Deno.test("validateNavigate: разрешён url из результатов инструментов (knownUrls)", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/lampa-a60-10w/"]);
  const r = validateNavigate("https://ekt.kz/catalog/lampy/lampa-a60-10w/", known);
  assertEquals(r.ok, true);
  assertEquals(r.url, "https://ekt.kz/catalog/lampy/lampa-a60-10w");
});

Deno.test("validateNavigate: нормализация совпадает независимо от www./http/хвостового слэша", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/lampa-a60-10w/"]);
  const r = validateNavigate("http://www.ekt.kz/catalog/lampy/lampa-a60-10w", known);
  assertEquals(r.ok, true);
  assertEquals(r.url, "https://ekt.kz/catalog/lampy/lampa-a60-10w");
});

Deno.test("validateNavigate: служебные страницы разрешены без knownUrls", () => {
  for (
    const url of [
      "https://ekt.kz/return/",
      "https://ekt.kz/payments/",
      "https://ekt.kz/about/howto/",
      "https://ekt.kz/about/contacts/",
      "https://ekt.kz/about/faq/",
      "https://ekt.kz/catalog/svetilniki_lampy/lampy/",
      "https://ekt.kz/",
    ]
  ) {
    const r = validateNavigate(url, new Set());
    assertEquals(r.ok, true, `expected ok for ${url}`);
  }
});

Deno.test("validateNavigate: неизвестный url (не из инструментов и не служебный) — ошибка", () => {
  const r = validateNavigate("https://ekt.kz/catalog/lampy/some-other-product/", new Set());
  assertEquals(r.ok, false);
});

Deno.test("validateNavigate: чужой домен — ошибка", () => {
  const known = new Set(["https://evil.example/phishing"]);
  const r = validateNavigate("https://evil.example/phishing", known);
  assertEquals(r.ok, false);
});

Deno.test("validateNavigate: query или fragment — ошибка, даже если базовый путь известен", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/lampa-a60-10w/"]);
  assertEquals(validateNavigate("https://ekt.kz/catalog/lampy/lampa-a60-10w/?utm=x", known).ok, false);
  assertEquals(validateNavigate("https://ekt.kz/return/#form", known).ok, false);
});

Deno.test("validateNavigate: пустой url — ошибка", () => {
  assertEquals(validateNavigate("", new Set()).ok, false);
  assertEquals(validateNavigate("   ", new Set()).ok, false);
});

// ---------------------------------------------------------------------------
// collectKnownUrls
// ---------------------------------------------------------------------------

Deno.test("collectKnownUrls: достаёт url ekt.kz из произвольных данных результатов инструментов", () => {
  const data = [
    { items: [{ url: "https://ekt.kz/catalog/lampy/a/" }, { url: "https://ekt.kz/catalog/lampy/b/" }] },
    "текст со ссылкой https://ekt.kz/about/faq/ внутри",
    { unrelated: "https://google.com" },
  ];
  const urls = collectKnownUrls(data);
  assertEquals(urls.has("https://ekt.kz/catalog/lampy/a/"), true);
  assertEquals(urls.has("https://ekt.kz/catalog/lampy/b/"), true);
  assertEquals(urls.has("https://ekt.kz/about/faq/"), true);
  assertEquals([...urls].some((u) => u.includes("google.com")), false);
});

// ---------------------------------------------------------------------------
// validateHighlight
// ---------------------------------------------------------------------------

Deno.test("validateHighlight: известный target — ок", () => {
  for (const t of TARGETS) {
    const r = validateHighlight(t, "подсказка");
    assertEquals(r.ok, true);
  }
});

Deno.test("validateHighlight: неизвестный target — ошибка", () => {
  const r = validateHighlight("some_unknown_target", "подсказка");
  assertEquals(r.ok, false);
});

Deno.test("validateHighlight: пустая note — ошибка", () => {
  assertEquals(validateHighlight("price", "").ok, false);
  assertEquals(validateHighlight("price", "   ").ok, false);
});

// ---------------------------------------------------------------------------
// validateClick
// ---------------------------------------------------------------------------

Deno.test("validateClick: известные target ок, неизвестный — ошибка", () => {
  for (const t of CLICK_TARGETS) assertEquals(validateClick(t, "жми").ok, true);
  assertEquals(validateClick("delete_account", "жми").ok, false);
  assertEquals(validateClick("buy_button", "").ok, false);
});

// ---------------------------------------------------------------------------
// validateFill
// ---------------------------------------------------------------------------

Deno.test("validateFill: разрешённые поля формы принимаются, телефон нормализуется", () => {
  const r = validateFill(
    "return_form",
    { name: "Иван", phone: "8 701 234 56 78", order_number: "12345", reason: "Не подошёл размер" },
    "Заполняю заявление",
  );
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.action.fields.phone, "+77012345678");
    assertEquals(r.action.fields.name, "Иван");
    assertEquals(r.action.form, "return_form");
  }
});

Deno.test("validateFill: неизвестное поле формы — ошибка", () => {
  const r = validateFill("return_form", { credit_card: "1234" }, "Заполняю");
  assertEquals(r.ok, false);
});

Deno.test("validateFill: неизвестная форма — ошибка", () => {
  const r = validateFill("checkout_form", { q: "x" }, "Заполняю");
  assertEquals(r.ok, false);
});

Deno.test("validateFill: некорректный телефон — ошибка", () => {
  const r = validateFill("lead_form", { phone: "123" }, "Заполняю");
  assertEquals(r.ok, false);
});

Deno.test("validateFill: пустые поля (после trim) — ошибка «нет значений»", () => {
  const r = validateFill("search", { q: "   " }, "Ищу");
  assertEquals(r.ok, false);
});

Deno.test("validateFill: допустимые ключи по формам", () => {
  assertEquals(FORMS.includes("return_form"), true);
  assertEquals(FORMS.includes("lead_form"), true);
  assertEquals(FORMS.includes("search"), true);
});

// ---------------------------------------------------------------------------
// validateFilter
// ---------------------------------------------------------------------------

Deno.test("validateFilter: обычный набор фильтров — ок", () => {
  const r = validateFilter({ "Тип цоколя": "E27", "Цветовая температура": "4000" }, "Применяю фильтры");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.action.filters["Тип цоколя"], "E27");
});

Deno.test("validateFilter: пустой объект — ошибка", () => {
  assertEquals(validateFilter({}, "Применяю").ok, false);
});

Deno.test("validateFilter: слишком много фильтров — обрезается до лимита, без ошибки", () => {
  const filters: Record<string, string> = {};
  for (let i = 0; i < 20; i++) filters[`k${i}`] = `v${i}`;
  const r = validateFilter(filters, "Применяю");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(Object.keys(r.action.filters).length <= 8, true);
});

// ---------------------------------------------------------------------------
// validateSuggest
// ---------------------------------------------------------------------------

Deno.test("validateSuggest: 1-4 варианта — ок, дубликаты убираются", () => {
  const r = validateSuggest(["Открыть карточку", "Открыть карточку", "Добавить в корзину"]);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.action.options, ["Открыть карточку", "Добавить в корзину"]);
});

Deno.test("validateSuggest: пустой массив — ошибка", () => {
  assertEquals(validateSuggest([]).ok, false);
  assertEquals(validateSuggest("not an array").ok, false);
});

Deno.test("validateSuggest: вариант длиннее 40 символов — ошибка", () => {
  const r = validateSuggest(["a".repeat(41)]);
  assertEquals(r.ok, false);
});

Deno.test("validateSuggest: больше 4 вариантов — обрезается до 4", () => {
  const r = validateSuggest(["1", "2", "3", "4", "5"]);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.action.options.length, 4);
});

// ---------------------------------------------------------------------------
// normalizeKzPhone (используется fill_form/create_lead)
// ---------------------------------------------------------------------------

Deno.test("normalizeKzPhone", () => {
  assertEquals(normalizeKzPhone("+7 701 234 56 78"), "+77012345678");
  assertEquals(normalizeKzPhone("8 (701) 234-56-78"), "+77012345678");
  assertEquals(normalizeKzPhone("12345"), null);
});

// ---------------------------------------------------------------------------
// collectTurnActions — сборщик действий хода
// ---------------------------------------------------------------------------

const nav = (url: string, label = "Открываю"): UiAction => ({ type: "navigate", url, label });
const hl = (target: (typeof TARGETS)[number], note = "note"): UiAction => ({ type: "highlight", target, note });

Deno.test("collectTurnActions: один navigate — последний выигрывает", () => {
  const out = collectTurnActions([
    nav("https://ekt.kz/a/", "первый"),
    hl("price"),
    nav("https://ekt.kz/b/", "второй"),
  ]);
  const navs = out.filter((a) => a.type === "navigate");
  assertEquals(navs.length, 1);
  assertEquals((navs[0] as { url: string }).url, "https://ekt.kz/b/");
});

Deno.test("collectTurnActions: highlight — лимит 3, дедуп по target (последняя note)", () => {
  const out = collectTurnActions([
    hl("price", "первая"),
    hl("buy_button"),
    hl("characteristics"),
    hl("description"), // 4-й уникальный target — должен быть отброшен (лимит MAX_HIGHLIGHT)
    hl("price", "вторая"), // повтор target — обновляет note, но не добавляет новый слот
  ]);
  const highlights = out.filter((a) => a.type === "highlight") as { target: string; note: string }[];
  assertEquals(highlights.length, MAX_HIGHLIGHT);
  const priceHl = highlights.find((h) => h.target === "price");
  assertEquals(priceHl?.note, "вторая");
  assertEquals(highlights.some((h) => h.target === "description"), false);
});

Deno.test("collectTurnActions: порядок вывода — по хронологии последнего актуального появления", () => {
  const out = collectTurnActions([
    hl("price"),
    nav("https://ekt.kz/a/"),
    hl("buy_button"),
  ]);
  assertEquals(out.map((a) => a.type), ["highlight", "navigate", "highlight"]);
});

Deno.test("collectTurnActions: singleton-типы (click/fill/filter/suggest) — тоже последний выигрывает", () => {
  const click1: UiAction = { type: "click", target: "buy_button", label: "первый" };
  const click2: UiAction = { type: "click", target: "search_submit", label: "второй" };
  const suggest1: UiAction = { type: "suggest", options: ["a"] };
  const suggest2: UiAction = { type: "suggest", options: ["b"] };
  const out = collectTurnActions([click1, suggest1, click2, suggest2]);
  assertEquals(out.filter((a) => a.type === "click").length, 1);
  assertEquals(out.filter((a) => a.type === "suggest").length, 1);
  const kept = out.find((a) => a.type === "click") as { target: string };
  assertEquals(kept.target, "search_submit");
});

Deno.test("collectTurnActions: пустой вход — пустой выход", () => {
  assertEquals(collectTurnActions([]), []);
});
