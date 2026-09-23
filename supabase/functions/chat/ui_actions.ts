// UI-действия консультанта на странице сайта: чистая логика валидации и сборки за один ход диалога.
// Контракт (SSE `action`, допустимые url/target/форма, лимиты) — см. Global Constraints в
// docs/superpowers/plans/2026-09-23-agent-hands.md. Никакой сети/БД здесь нет — легко тестируется.

// ---------------------------------------------------------------------------
// Константы контракта
// ---------------------------------------------------------------------------

/**
 * Цели подсветки (`highlight`) — селекторы реального ekt.kz см. в плане (РАЗВОРОТ), здесь только
 * имена для контракта/промпта.
 */
export const TARGETS = [
  "price",
  "buy_button",
  "characteristics",
  "description",
  "return_conditions",
  "payment_methods",
  "contacts_phone",
  "catalog_list",
  "search",
  "cart",
] as const;
export type Target = typeof TARGETS[number];

/**
 * Цели нажатия (`click`): `buy_button` — add2basket; `search_submit` — сабмит формы поиска;
 * `buy_one_click`/`lead_form` — открыть соответствующую модалку сайта (сама форма — через fill).
 */
export const CLICK_TARGETS = ["buy_button", "search_submit", "buy_one_click", "lead_form"] as const;
export type ClickTarget = typeof CLICK_TARGETS[number];

/**
 * Формы для заполнения (`fill`) — реальные модалки/формы ekt.kz. Возврата как отдельной формы на
 * сайте нет: сценарий возврата — страница условий `/return/` + заявка через `lead_form.question`.
 */
export const FORMS = ["lead_form", "buy_one_click", "search"] as const;
export type Form = typeof FORMS[number];

/** Допустимые ключи полей для каждой формы (как в реальных модалках/формах ekt.kz). */
export const FORM_FIELDS: Record<Form, readonly string[]> = {
  lead_form: ["name", "email", "phone", "question"],
  buy_one_click: ["name", "phone", "email"],
  search: ["q"],
};

/** Служебные страницы, на которые всегда можно перейти (без query, https://ekt.kz + путь). */
export const SERVICE_NAV_PATHS = [
  "/return/",
  "/payments/",
  "/about/howto/",
  "/about/contacts/",
  "/about/faq/",
  "/catalog/svetilniki_lampy/lampy/",
  "/personal/cart/",
  "/",
] as const;

export const MAX_HIGHLIGHT = 3;
const MAX_SUGGEST_OPTIONS = 4;
const MAX_OPTION_LEN = 40;
const MAX_FIELD_LEN = 200;
const MAX_LABEL_LEN = 120;
const MAX_NOTE_LEN = 200;

// ---------------------------------------------------------------------------
// Типы действий
// ---------------------------------------------------------------------------

export interface NavigateAction {
  type: "navigate";
  url: string;
  label: string;
}
export interface HighlightAction {
  type: "highlight";
  target: Target;
  note: string;
}
export interface ClickAction {
  type: "click";
  target: ClickTarget;
  label: string;
}
export interface FillAction {
  type: "fill";
  form: Form;
  fields: Record<string, string>;
  label: string;
}
export interface SuggestAction {
  type: "suggest";
  options: string[];
}

export type UiAction = NavigateAction | HighlightAction | ClickAction | FillAction | SuggestAction;

export type Validation<T> = { ok: true; action: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// normalizeKzPhone — используется fill_form (поле phone) и create_lead (tools.ts).
// ---------------------------------------------------------------------------

/** Нормализует телефон Казахстана в +7XXXXXXXXXX; null — если формат неверный. */
export function normalizeKzPhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  let national: string | null = null;
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) national = digits.slice(1);
  else if (digits.length === 10 && !trimmed.startsWith("+")) national = digits;
  if (!national || national[0] !== "7") return null;
  return "+7" + national;
}

/**
 * Проверяет, что телефон (нормализованный, +7XXXXXXXXXX) действительно встречается среди цифр
 * сообщений клиента — используется fill_form (поле phone) и create_lead, чтобы модель не могла
 * указать телефон, который клиент сам не писал в этом диалоге.
 */
export function phoneMentionedByUser(normalizedPhone: string, userTexts: Iterable<string>): boolean {
  const digits = (normalizedPhone ?? "").replace(/\D/g, "");
  const national = digits.slice(-10);
  if (national.length !== 10) return false;
  for (const t of userTexts) {
    if ((t ?? "").replace(/\D/g, "").includes(national)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// navigate_to
// ---------------------------------------------------------------------------

/**
 * Нормализует url ekt.kz для СРАВНЕНИЯ: https, без www., без хвостового /. Иначе null.
 * Это ключ сравнения, а не значение, которое можно отдавать наружу — хвостовой / из реальных url
 * (как в БД и на самом ekt.kz) теряется, поэтому `validateNavigate` возвращает не эту функцию, а
 * исходную (каноническую) строку из knownUrls/служебного списка.
 */
export function normalizeEktUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const s = trimmed.replace(/^http:\/\//i, "https://").replace(/^https:\/\/www\./i, "https://");
  const m = s.match(/^https:\/\/ekt\.kz(\/.*)?$/i);
  if (!m) return null;
  const path = (m[1] ?? "/").replace(/\/+$/, "");
  return "https://ekt.kz" + (path || "/");
}

/** Полные служебные url (https://ekt.kz + путь), с хвостовым / как в SERVICE_NAV_PATHS. */
const SERVICE_NAV_URLS: readonly string[] = SERVICE_NAV_PATHS.map((p) => "https://ekt.kz" + p);

export interface NavigateCheck {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Проверяет url для navigate_to: только https://ekt.kz/… (или относительный путь от корня сайта,
 * начинающийся с "/" — резолвится от https://ekt.kz), без query/hash, и только если url встречался
 * в результатах инструментов этого диалога (knownUrls) или входит в служебные пути.
 * При успехе возвращает КАНОНИЧЕСКУЮ форму — ровно ту строку, что была в knownUrls или в служебном
 * списке (с хвостовым /, как на самом ekt.kz), а не «схлопнутый» ключ сравнения без слэша.
 */
export function validateNavigate(url: string, knownUrls: Iterable<string>): NavigateCheck {
  let raw = (url ?? "").trim();
  if (!raw) return { ok: false, error: "Пустой url." };
  if (raw.includes("?") || raw.includes("#")) {
    return { ok: false, error: "url не должен содержать query-параметры или fragment." };
  }
  // Относительный путь ("/return/") — модель иногда присылает именно так; резолвим от ekt.kz.
  // Простая конкатенация строк, не разбор URL — так "//evil.example/x" остаётся путём ПОД ekt.kz
  // ("https://ekt.kz//evil.example/x"), а не превращается в переход на чужой хост.
  if (raw.startsWith("/")) raw = "https://ekt.kz" + raw;
  const key = normalizeEktUrl(raw);
  if (!key) return { ok: false, error: "Разрешены только ссылки на https://ekt.kz (или относительный путь от /)." };

  for (const svc of SERVICE_NAV_URLS) {
    if (normalizeEktUrl(svc) === key) return { ok: true, url: svc };
  }
  for (const u of knownUrls) {
    const known = (u ?? "").trim();
    if (known && normalizeEktUrl(known) === key) return { ok: true, url: known };
  }
  return {
    ok: false,
    error: "Этот url не встречался в результатах инструментов этого диалога и не входит в список служебных страниц.",
  };
}

export function buildNavigateAction(
  url: string,
  label: string,
  knownUrls: Iterable<string>,
): Validation<NavigateAction> {
  const v = validateNavigate(url, knownUrls);
  if (!v.ok) return { ok: false, error: v.error! };
  const l = (label ?? "").trim().slice(0, MAX_LABEL_LEN);
  if (!l) return { ok: false, error: "Укажи label — короткую фразу о том, что делаешь." };
  return { ok: true, action: { type: "navigate", url: v.url!, label: l } };
}

/**
 * Объединяет несколько списков УЖЕ ПРОВЕРЕННЫХ url (ekt.kz) в один Set с дедупом. Каждый список —
 * это заранее извлечённые из СТРУКТУРНЫХ полей (products[].url / item.url / search_knowledge
 * items[].url / url успешного navigate) url конкретного вызова инструмента — см. `navUrlsOf` в
 * tools.ts. Здесь намеренно нет разбора произвольного JSON/текста: если сканировать весь объект
 * результата (включая `args`), в allow-list могут просочиться url, которые модель просто
 * ПОПЫТАЛАСЬ передать (в т.ч. отклонённые navigate_to или url несуществующего товара в
 * get_product(url=…)), а не те, что реально подтверждены инструментом.
 */
export function collectKnownUrls(urlLists: Iterable<Iterable<string> | undefined | null>): Set<string> {
  const urls = new Set<string>();
  for (const list of urlLists) {
    if (!list) continue;
    for (const u of list) if (u) urls.add(u);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// highlight
// ---------------------------------------------------------------------------

export function validateHighlight(target: string, note: string): Validation<HighlightAction> {
  const t = (target ?? "").trim();
  if (!(TARGETS as readonly string[]).includes(t)) {
    return { ok: false, error: `Неизвестный target «${t}». Допустимые значения: ${TARGETS.join(", ")}.` };
  }
  const n = (note ?? "").trim().slice(0, MAX_NOTE_LEN);
  if (!n) return { ok: false, error: "Укажи note — короткую подсказку для клиента." };
  return { ok: true, action: { type: "highlight", target: t as Target, note: n } };
}

// ---------------------------------------------------------------------------
// click_element
// ---------------------------------------------------------------------------

export function validateClick(target: string, label: string): Validation<ClickAction> {
  const t = (target ?? "").trim();
  if (!(CLICK_TARGETS as readonly string[]).includes(t)) {
    return { ok: false, error: `Неизвестный target «${t}». Допустимые значения: ${CLICK_TARGETS.join(", ")}.` };
  }
  const l = (label ?? "").trim().slice(0, MAX_LABEL_LEN);
  if (!l) return { ok: false, error: "Укажи label — короткую фразу о том, что делаешь." };
  return { ok: true, action: { type: "click", target: t as ClickTarget, label: l } };
}

// ---------------------------------------------------------------------------
// fill_form
// ---------------------------------------------------------------------------

export function validateFill(form: string, fields: unknown, label: string): Validation<FillAction> {
  const f = (form ?? "").trim();
  if (!(FORMS as readonly string[]).includes(f)) {
    return { ok: false, error: `Неизвестная форма «${f}». Допустимые значения: ${FORMS.join(", ")}.` };
  }
  const allowed = FORM_FIELDS[f as Form];
  const entries = fields && typeof fields === "object" && !Array.isArray(fields)
    ? Object.entries(fields as Record<string, unknown>)
    : [];
  const unknownKeys = entries.map(([k]) => k).filter((k) => !allowed.includes(k));
  if (unknownKeys.length) {
    return {
      ok: false,
      error: `Неизвестные поля формы «${f}»: ${unknownKeys.join(", ")}. Допустимые поля: ${allowed.join(", ")}.`,
    };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (!s) continue;
    if (s.length > MAX_FIELD_LEN) {
      return { ok: false, error: `Значение поля «${k}» длиннее ${MAX_FIELD_LEN} символов.` };
    }
    if (k === "phone") {
      const norm = normalizeKzPhone(s);
      if (!norm) return { ok: false, error: "Некорректный номер телефона в поле phone." };
      out[k] = norm;
      continue;
    }
    out[k] = s;
  }
  if (!Object.keys(out).length) return { ok: false, error: "Не указано ни одного значения полей." };
  const l = (label ?? "").trim().slice(0, MAX_LABEL_LEN);
  if (!l) return { ok: false, error: "Укажи label — короткую фразу о том, что делаешь." };
  return { ok: true, action: { type: "fill", form: f as Form, fields: out, label: l } };
}

// ---------------------------------------------------------------------------
// suggest_replies
// ---------------------------------------------------------------------------

export function validateSuggest(options: unknown): Validation<SuggestAction> {
  if (!Array.isArray(options)) return { ok: false, error: "options должен быть массивом строк." };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of options) {
    const s = typeof o === "string" ? o.trim() : "";
    if (!s) continue;
    if (s.length > MAX_OPTION_LEN) {
      return { ok: false, error: `Вариант «${s.slice(0, 20)}…» длиннее ${MAX_OPTION_LEN} символов.` };
    }
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SUGGEST_OPTIONS) break;
  }
  if (!out.length) return { ok: false, error: "Укажи от 1 до 4 вариантов ответа." };
  return { ok: true, action: { type: "suggest", options: out } };
}

// Служебные url → цель подсветки по умолчанию, когда navigate есть, а модель highlight не прислала.
const DEFAULT_HIGHLIGHT_BY_URL: ReadonlyMap<string, Target> = new Map([
  ["https://ekt.kz/return/", "return_conditions"],
  ["https://ekt.kz/payments/", "payment_methods"],
  ["https://ekt.kz/about/contacts/", "contacts_phone"],
  ["https://ekt.kz/personal/cart/", "cart"],
  ["https://ekt.kz/catalog/svetilniki_lampy/lampy/", "catalog_list"],
]);

/** Короткая подсказка по умолчанию для автодобавленной подсветки (D1) — по target. */
const DEFAULT_HIGHLIGHT_NOTE: Record<Target, string> = {
  price: "Вот цена на сайте",
  buy_button: "Кнопка «Купить»",
  characteristics: "Характеристики",
  description: "Описание товара",
  return_conditions: "Условия возврата",
  payment_methods: "Способы оплаты",
  contacts_phone: "Телефон филиала",
  catalog_list: "Список товаров",
  search: "Поиск по сайту",
  cart: "Ваша корзина",
};

/**
 * Цель подсветки по умолчанию для url перехода: точное совпадение со служебной страницей (см.
 * DEFAULT_HIGHLIGHT_BY_URL) или, если url — карточка товара из результатов этого диалога
 * (productUrls), `price`. Для прочих url (например произвольная страница базы знаний без
 * очевидной цели) — null: лучше не подсветить ничего, чем угадать неверную цель.
 */
function defaultHighlightTarget(url: string, productUrls: Iterable<string>): Target | null {
  const svc = DEFAULT_HIGHLIGHT_BY_URL.get(url);
  if (svc) return svc;
  for (const u of productUrls) if (u === url) return "price";
  return null;
}

// ---------------------------------------------------------------------------
// Сборщик действий хода
// ---------------------------------------------------------------------------

/**
 * Собирает финальный список действий за один ход диалога, в порядке вызова:
 * navigate/click/fill/suggest — не больше одного (последний по времени вызова выигрывает,
 * более ранние того же типа отбрасываются); highlight — не больше MAX_HIGHLIGHT, дедуп по target
 * (последняя note выигрывает), оставляются первые встретившиеся различные target.
 *
 * Автодобавление 1: fill(form="search") без click(target="search_submit") сам по себе не
 * запускает поиск на сайте — заполняет поле и всё. Если в ходе нет НИКАКОГО click (лимит click ≤ 1
 * не даёт добавить его молча поверх другого click, например buy_button — тогда оставляем как
 * есть), сразу после fill добавляется click(target="search_submit"). Модель может по-прежнему
 * прислать этот click сама — тогда ничего не добавляется, дублей не будет.
 *
 * Автодобавление 2: navigate без НИКАКОГО highlight в ходе — клиент попадает на новую страницу
 * без единой подсветки, хотя обычно есть очевидная цель (цена товара, условия возврата и т. п.).
 * Если у navigate.url есть цель по умолчанию (см. `defaultHighlightTarget`; для этого функции
 * нужны `productUrls` — url карточек товаров этого диалога, из ProductCard[].url), она
 * добавляется. Модель может по-прежнему прислать свой highlight — тогда ничего не добавляется.
 */
export function collectTurnActions(
  actions: UiAction[],
  opts: { productUrls?: Iterable<string> } = {},
): UiAction[] {
  const lastSingleIndex = new Map<UiAction["type"], number>();
  const lastHighlightIndexByTarget = new Map<Target, number>();
  const highlightTargetsInOrder: Target[] = [];
  const seenTargets = new Set<Target>();

  actions.forEach((a, i) => {
    if (a.type === "highlight") {
      lastHighlightIndexByTarget.set(a.target, i);
      if (!seenTargets.has(a.target)) {
        seenTargets.add(a.target);
        highlightTargetsInOrder.push(a.target);
      }
    } else {
      lastSingleIndex.set(a.type, i);
    }
  });

  const keptTargets = new Set(highlightTargetsInOrder.slice(0, MAX_HIGHLIGHT));
  const keepIndices = new Set<number>();
  for (const idx of lastSingleIndex.values()) keepIndices.add(idx);
  for (const [target, idx] of lastHighlightIndexByTarget) {
    if (keptTargets.has(target)) keepIndices.add(idx);
  }

  const result = actions
    .map((a, i) => ({ a, i }))
    .filter(({ i }) => keepIndices.has(i))
    .sort((x, y) => x.i - y.i)
    .map(({ a }) => a);

  const fillSearchIdx = result.findIndex((a) => a.type === "fill" && a.form === "search");
  const hasClick = result.some((a) => a.type === "click");
  if (fillSearchIdx !== -1 && !hasClick) {
    const autoSubmit: ClickAction = { type: "click", target: "search_submit", label: "Ищу на сайте" };
    result.splice(fillSearchIdx + 1, 0, autoSubmit);
  }

  const navIdx = result.findIndex((a) => a.type === "navigate");
  const hasHighlight = result.some((a) => a.type === "highlight");
  if (navIdx !== -1 && !hasHighlight) {
    const nav = result[navIdx] as NavigateAction;
    const target = defaultHighlightTarget(nav.url, opts.productUrls ?? []);
    if (target) {
      const autoHighlight: HighlightAction = { type: "highlight", target, note: DEFAULT_HIGHLIGHT_NOTE[target] };
      result.splice(navIdx + 1, 0, autoHighlight);
    }
  }

  return result;
}
