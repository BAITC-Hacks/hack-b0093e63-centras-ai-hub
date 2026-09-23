import { assertEquals } from "jsr:@std/assert@1";
import {
  CLICK_TARGETS,
  collectKnownUrls,
  collectTurnActions,
  FORMS,
  MAX_HIGHLIGHT,
  normalizeEktUrl,
  normalizeKzPhone,
  phoneMentionedByUser,
  TARGETS,
  type UiAction,
  validateClick,
  validateFill,
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

Deno.test("validateNavigate: разрешён url из результатов инструментов (knownUrls), канонический с хвостовым /", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/lampa-a60-10w/"]);
  const r = validateNavigate("https://ekt.kz/catalog/lampy/lampa-a60-10w/", known);
  assertEquals(r.ok, true);
  // action.url — ровно та строка, что была в knownUrls (с хвостовым /, как в БД/на сайте), а не
  // «схлопнутый» ключ сравнения без слэша (регрессия из живого прогона: navigate терял /).
  assertEquals(r.url, "https://ekt.kz/catalog/lampy/lampa-a60-10w/");
});

Deno.test("validateNavigate: модель прислала url без хвостового / — в action.url всё равно канонический вид из knownUrls", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/termoizluchatel_t_230_40_vt_e27_100/"]);
  const r = validateNavigate("https://ekt.kz/catalog/lampy/termoizluchatel_t_230_40_vt_e27_100", known);
  assertEquals(r.ok, true);
  assertEquals(r.url, "https://ekt.kz/catalog/lampy/termoizluchatel_t_230_40_vt_e27_100/");
});

Deno.test("validateNavigate: нормализация совпадает независимо от www./http/хвостового слэша (сравнение), но url — канонический", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/lampa-a60-10w/"]);
  const r = validateNavigate("http://www.ekt.kz/catalog/lampy/lampa-a60-10w", known);
  assertEquals(r.ok, true);
  assertEquals(r.url, "https://ekt.kz/catalog/lampy/lampa-a60-10w/");
});

Deno.test("validateNavigate: служебные страницы разрешены без knownUrls, url — с хвостовым / как в SERVICE_NAV_PATHS", () => {
  for (
    const [url, expected] of [
      ["https://ekt.kz/return/", "https://ekt.kz/return/"],
      ["https://ekt.kz/payments/", "https://ekt.kz/payments/"],
      ["https://ekt.kz/about/howto/", "https://ekt.kz/about/howto/"],
      ["https://ekt.kz/about/contacts/", "https://ekt.kz/about/contacts/"],
      ["https://ekt.kz/about/faq/", "https://ekt.kz/about/faq/"],
      ["https://ekt.kz/catalog/svetilniki_lampy/lampy/", "https://ekt.kz/catalog/svetilniki_lampy/lampy/"],
      ["https://ekt.kz/personal/cart/", "https://ekt.kz/personal/cart/"],
      ["https://ekt.kz/", "https://ekt.kz/"],
      // модель прислала без хвостового / — результат всё равно канонический, с /.
      ["https://ekt.kz/return", "https://ekt.kz/return/"],
    ] as const
  ) {
    const r = validateNavigate(url, new Set());
    assertEquals(r.ok, true, `expected ok for ${url}`);
    assertEquals(r.url, expected);
  }
});

Deno.test("validateNavigate: javascript:/protocol-relative/поддельный поддомен/UPPERCASE host", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/x/"]);
  assertEquals(validateNavigate("javascript:alert(1)", known).ok, false);
  assertEquals(validateNavigate("//evil.example/phishing", known).ok, false);
  assertEquals(validateNavigate("https://ekt.kz.evil.com/phishing", known).ok, false);
  assertEquals(validateNavigate("https://evil-ekt.kz/phishing", known).ok, false);
  // UPPERCASE host — валидный ekt.kz, должен нормально сматчиться и вернуть канонический вид.
  const r = validateNavigate("https://EKT.KZ/catalog/lampy/x/", known);
  assertEquals(r.ok, true);
  assertEquals(r.url, "https://ekt.kz/catalog/lampy/x/");
});

Deno.test("validateNavigate: относительный путь от корня сайта резолвится от https://ekt.kz (служебный)", () => {
  for (
    const [rel, expected] of [
      ["/payments/", "https://ekt.kz/payments/"],
      ["/return/", "https://ekt.kz/return/"],
      ["/personal/cart/", "https://ekt.kz/personal/cart/"],
      ["/", "https://ekt.kz/"],
      // без хвостового / — тоже резолвится и приводится к каноническому виду.
      ["/payments", "https://ekt.kz/payments/"],
    ] as const
  ) {
    const r = validateNavigate(rel, new Set());
    assertEquals(r.ok, true, `expected ok for ${rel}`);
    assertEquals(r.url, expected);
  }
});

Deno.test("validateNavigate: относительный путь к известному товару (из knownUrls) резолвится", () => {
  const known = new Set(["https://ekt.kz/catalog/lampy/lampa-a60-10w/"]);
  const r = validateNavigate("/catalog/lampy/lampa-a60-10w/", known);
  assertEquals(r.ok, true);
  assertEquals(r.url, "https://ekt.kz/catalog/lampy/lampa-a60-10w/");
});

Deno.test("validateNavigate: относительный путь вне known/служебных — по-прежнему ошибка", () => {
  const r = validateNavigate("/catalog/lampy/some-other-product/", new Set());
  assertEquals(r.ok, false);
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
// collectKnownUrls — объединяет заранее извлечённые (структурные) списки url, без разбора
// произвольного JSON/args (см. navUrlsOf в tools.ts, где url реально извлекаются).
// ---------------------------------------------------------------------------

Deno.test("collectKnownUrls: объединяет несколько списков с дедупом, пропускает пустые/undefined", () => {
  const urls = collectKnownUrls([
    ["https://ekt.kz/catalog/lampy/a/", "https://ekt.kz/catalog/lampy/b/"],
    undefined,
    [],
    ["https://ekt.kz/catalog/lampy/a/", "https://ekt.kz/about/faq/"],
    null,
  ]);
  assertEquals([...urls].sort(), [
    "https://ekt.kz/about/faq/",
    "https://ekt.kz/catalog/lampy/a/",
    "https://ekt.kz/catalog/lampy/b/",
  ]);
});

Deno.test("collectKnownUrls: пустой вход — пустой Set", () => {
  assertEquals(collectKnownUrls([]).size, 0);
});

// ---------------------------------------------------------------------------
// validateHighlight
// ---------------------------------------------------------------------------

Deno.test("validateHighlight: известный target — ок (cart есть, return_form упразднён)", () => {
  for (const t of TARGETS) {
    const r = validateHighlight(t, "подсказка");
    assertEquals(r.ok, true);
  }
  assertEquals(TARGETS.includes("cart"), true);
  assertEquals((TARGETS as readonly string[]).includes("return_form"), false);
  assertEquals(validateHighlight("return_form", "подсказка").ok, false);
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

Deno.test("validateClick: известные target ок (buy_button/search_submit/buy_one_click/lead_form), неизвестный — ошибка", () => {
  assertEquals([...CLICK_TARGETS].sort(), ["buy_button", "buy_one_click", "lead_form", "search_submit"]);
  for (const t of CLICK_TARGETS) assertEquals(validateClick(t, "жми").ok, true);
  assertEquals(validateClick("delete_account", "жми").ok, false);
  assertEquals(validateClick("buy_button", "").ok, false);
});

// ---------------------------------------------------------------------------
// validateFill
// ---------------------------------------------------------------------------

Deno.test("validateFill: разрешённые поля формы lead_form принимаются, телефон нормализуется", () => {
  const r = validateFill(
    "lead_form",
    { name: "Иван", email: "ivan@example.com", phone: "8 701 234 56 78", question: "Возврат: заказ №123" },
    "Заполняю заявку",
  );
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.action.fields.phone, "+77012345678");
    assertEquals(r.action.fields.name, "Иван");
    assertEquals(r.action.form, "lead_form");
  }
});

Deno.test("validateFill: buy_one_click принимает name/phone/email", () => {
  const r = validateFill("buy_one_click", { name: "Иван", phone: "+7 701 234 56 78" }, "Заполняю «Купить в 1 клик»");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.action.form, "buy_one_click");
});

Deno.test("validateFill: неизвестное поле формы — ошибка", () => {
  const r = validateFill("lead_form", { credit_card: "1234" }, "Заполняю");
  assertEquals(r.ok, false);
});

Deno.test("validateFill: неизвестная форма (в т.ч. упразднённая return_form) — ошибка", () => {
  assertEquals(validateFill("checkout_form", { q: "x" }, "Заполняю").ok, false);
  assertEquals(validateFill("return_form", { name: "x" }, "Заполняю").ok, false);
});

Deno.test("validateFill: некорректный телефон — ошибка", () => {
  const r = validateFill("lead_form", { phone: "123" }, "Заполняю");
  assertEquals(r.ok, false);
});

Deno.test("validateFill: пустые поля (после trim) — ошибка «нет значений»", () => {
  const r = validateFill("search", { q: "   " }, "Ищу");
  assertEquals(r.ok, false);
});

Deno.test("validateFill: допустимые формы — lead_form, buy_one_click, search (return_form упразднена)", () => {
  assertEquals(FORMS.includes("lead_form"), true);
  assertEquals(FORMS.includes("buy_one_click"), true);
  assertEquals(FORMS.includes("search"), true);
  assertEquals((FORMS as readonly string[]).includes("return_form"), false);
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
// phoneMentionedByUser — телефон в fill_form/create_lead можно указывать, только если клиент
// сам его написал в этом диалоге.
// ---------------------------------------------------------------------------

Deno.test("phoneMentionedByUser: телефон встречается в сообщении клиента (разные форматы записи)", () => {
  assertEquals(
    phoneMentionedByUser("+77012345678", ["Здравствуйте, мой номер +7 701 234 56 78, перезвоните"]),
    true,
  );
  assertEquals(phoneMentionedByUser("+77012345678", ["8(701)234-56-78, буду ждать звонка"]), true);
});

Deno.test("phoneMentionedByUser: телефона нет ни в одном сообщении — false", () => {
  assertEquals(phoneMentionedByUser("+77012345678", ["Хочу оформить возврат", "Добавьте в корзину"]), false);
});

Deno.test("phoneMentionedByUser: похожий, но другой номер — false", () => {
  assertEquals(phoneMentionedByUser("+77012345678", ["Мой номер +7 701 234 56 79"]), false);
});

Deno.test("phoneMentionedByUser: пустой список сообщений — false", () => {
  assertEquals(phoneMentionedByUser("+77012345678", []), false);
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

Deno.test("collectTurnActions: singleton-типы (click/fill/suggest) — тоже последний выигрывает", () => {
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

// ---------------------------------------------------------------------------
// collectTurnActions — автодобавление click(search_submit) после fill(form="search")
// ---------------------------------------------------------------------------

const fillSearch = (q: string, label = "Ищу"): UiAction => ({
  type: "fill",
  form: "search",
  fields: { q },
  label,
});

Deno.test("collectTurnActions: fill(search) без click — добавляет click(search_submit) сразу после fill", () => {
  const out = collectTurnActions([fillSearch("лампа GX53")]);
  assertEquals(out.map((a) => a.type), ["fill", "click"]);
  const click = out[1] as { type: "click"; target: string; label: string };
  assertEquals(click.target, "search_submit");
  assertEquals(click.label, "Ищу на сайте");
});

Deno.test("collectTurnActions: fill(search) + свой click(search_submit) — дубль не добавляется", () => {
  const out = collectTurnActions([
    fillSearch("лампа GX53"),
    { type: "click", target: "search_submit", label: "Свой вариант" },
  ]);
  assertEquals(out.filter((a) => a.type === "click").length, 1);
  const click = out.find((a) => a.type === "click") as { label: string };
  assertEquals(click.label, "Свой вариант");
});

Deno.test("collectTurnActions: fill(search) + click(buy_button) — не добавляет search_submit (лимит click ≤ 1)", () => {
  const out = collectTurnActions([
    fillSearch("лампа GX53"),
    { type: "click", target: "buy_button", label: "Добавляю в корзину" },
  ]);
  assertEquals(out.filter((a) => a.type === "click").length, 1);
  const click = out.find((a) => a.type === "click") as { target: string };
  assertEquals(click.target, "buy_button");
});

Deno.test("collectTurnActions: fill(lead_form) — click(search_submit) не добавляется (не поиск)", () => {
  const out = collectTurnActions([
    { type: "fill", form: "lead_form", fields: { name: "Иван" }, label: "Заполняю" },
  ]);
  assertEquals(out.some((a) => a.type === "click"), false);
});

Deno.test("collectTurnActions: highlight между fill(search) и авто-click не мешает вставке сразу после fill", () => {
  const out = collectTurnActions([fillSearch("лампа GX53"), hl("catalog_list")]);
  assertEquals(out.map((a) => a.type), ["fill", "click", "highlight"]);
});
