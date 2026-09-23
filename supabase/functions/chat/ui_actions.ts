// UI-действия консультанта на странице сайта: чистая логика валидации и сборки за один ход диалога.
// Контракт (SSE `action`, допустимые url/target/форма, лимиты) — см. Global Constraints в
// docs/superpowers/plans/2026-09-23-agent-hands.md. Никакой сети/БД здесь нет — легко тестируется.

import { extractUrls } from "./validate.ts";

// ---------------------------------------------------------------------------
// Константы контракта
// ---------------------------------------------------------------------------

/** Цели подсветки (`highlight`) — селекторы см. в плане, здесь только имена для контракта/промпта. */
export const TARGETS = [
  "price",
  "buy_button",
  "characteristics",
  "description",
  "return_conditions",
  "return_form",
  "payment_methods",
  "contacts_phone",
  "catalog_list",
  "search",
] as const;
export type Target = typeof TARGETS[number];

/** Цели нажатия (`click`). */
export const CLICK_TARGETS = ["buy_button", "search_submit"] as const;
export type ClickTarget = typeof CLICK_TARGETS[number];

/** Формы для заполнения (`fill`). */
export const FORMS = ["return_form", "lead_form", "search"] as const;
export type Form = typeof FORMS[number];

/** Допустимые ключи полей для каждой формы. */
export const FORM_FIELDS: Record<Form, readonly string[]> = {
  return_form: ["name", "phone", "order_number", "purchase_date", "product", "reason"],
  lead_form: ["name", "phone", "city", "comment"],
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
  "/",
] as const;

export const MAX_HIGHLIGHT = 3;
const MAX_FILTERS = 8;
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
export interface FilterAction {
  type: "filter";
  filters: Record<string, string>;
  label: string;
}
export interface SuggestAction {
  type: "suggest";
  options: string[];
}

export type UiAction = NavigateAction | HighlightAction | ClickAction | FillAction | FilterAction | SuggestAction;

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

// ---------------------------------------------------------------------------
// navigate_to
// ---------------------------------------------------------------------------

/** Нормализует url ekt.kz к каноническому виду: https, без www., без хвостового /. Иначе null. */
export function normalizeEktUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const s = trimmed.replace(/^http:\/\//i, "https://").replace(/^https:\/\/www\./i, "https://");
  const m = s.match(/^https:\/\/ekt\.kz(\/.*)?$/i);
  if (!m) return null;
  const path = (m[1] ?? "/").replace(/\/+$/, "");
  return "https://ekt.kz" + (path || "/");
}

function isServicePath(normalized: string): boolean {
  return (SERVICE_NAV_PATHS as readonly string[]).some((p) => normalizeEktUrl("https://ekt.kz" + p) === normalized);
}

export interface NavigateCheck {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Проверяет url для navigate_to: только https://ekt.kz/…, без query/hash, и только если url
 * встречался в результатах инструментов этого диалога (knownUrls) или входит в служебные пути.
 */
export function validateNavigate(url: string, knownUrls: Iterable<string>): NavigateCheck {
  const raw = (url ?? "").trim();
  if (!raw) return { ok: false, error: "Пустой url." };
  if (raw.includes("?") || raw.includes("#")) {
    return { ok: false, error: "url не должен содержать query-параметры или fragment." };
  }
  const norm = normalizeEktUrl(raw);
  if (!norm) return { ok: false, error: "Разрешены только ссылки на https://ekt.kz." };
  if (isServicePath(norm)) return { ok: true, url: norm };
  const known = new Set<string>();
  for (const u of knownUrls) {
    const n = normalizeEktUrl(u);
    if (n) known.add(n);
  }
  if (!known.has(norm)) {
    return {
      ok: false,
      error: "Этот url не встречался в результатах инструментов этого диалога и не входит в список служебных страниц.",
    };
  }
  return { ok: true, url: norm };
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

/** Собирает набор известных url (ekt.kz) из произвольных данных результатов инструментов/истории. */
export function collectKnownUrls(dataItems: unknown[]): Set<string> {
  const urls = new Set<string>();
  for (const item of dataItems) {
    let text: string;
    try {
      text = JSON.stringify(item) ?? "";
    } catch {
      continue;
    }
    for (const u of extractUrls(text)) urls.add(u);
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
// apply_filters
// ---------------------------------------------------------------------------

export function validateFilter(filters: unknown, label: string): Validation<FilterAction> {
  const entries = filters && typeof filters === "object" && !Array.isArray(filters)
    ? Object.entries(filters as Record<string, unknown>)
    : [];
  const out: Record<string, string> = {};
  for (const [rawKey, v] of entries) {
    const key = rawKey.trim();
    const val = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (!key || !val) continue;
    if (key.length > 100 || val.length > MAX_FIELD_LEN) {
      return { ok: false, error: `Слишком длинный фильтр «${key}».` };
    }
    out[key] = val;
    if (Object.keys(out).length >= MAX_FILTERS) break;
  }
  if (!Object.keys(out).length) return { ok: false, error: "Укажи хотя бы один фильтр." };
  const l = (label ?? "").trim().slice(0, MAX_LABEL_LEN);
  if (!l) return { ok: false, error: "Укажи label — короткую фразу о том, что делаешь." };
  return { ok: true, action: { type: "filter", filters: out, label: l } };
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

// ---------------------------------------------------------------------------
// Сборщик действий хода
// ---------------------------------------------------------------------------

/**
 * Собирает финальный список действий за один ход диалога, в порядке вызова:
 * navigate/click/fill/filter/suggest — не больше одного (последний по времени вызова выигрывает,
 * более ранние того же типа отбрасываются); highlight — не больше MAX_HIGHLIGHT, дедуп по target
 * (последняя note выигрывает), оставляются первые встретившиеся различные target.
 */
export function collectTurnActions(actions: UiAction[]): UiAction[] {
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

  return actions
    .map((a, i) => ({ a, i }))
    .filter(({ i }) => keepIndices.has(i))
    .sort((x, y) => x.i - y.i)
    .map(({ a }) => a);
}
