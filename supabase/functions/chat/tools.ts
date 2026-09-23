// Инструменты консультанта: JSON-схемы для модели и их исполнители (Supabase RPC/таблицы).

import { LIMITS } from "./config.ts";
import type { Db } from "./db.ts";
import type { ToolDef } from "./openai.ts";
import {
  buildNavigateAction,
  CLICK_TARGETS,
  FORM_FIELDS,
  FORMS,
  normalizeKzPhone,
  phoneMentionedByUser,
  TARGETS,
  type UiAction,
  validateClick,
  validateFill,
  validateHighlight,
  validateSuggest,
} from "./ui_actions.ts";

export { normalizeKzPhone };

// ---------------------------------------------------------------------------
// Схемы
// ---------------------------------------------------------------------------

const KNOWLEDGE_KINDS = [
  "faq",
  "howto",
  "payment",
  "return",
  "contacts",
  "about",
  "production",
  "article",
  "tech",
  "news",
] as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Поиск и подбор товаров в каталоге ekt.kz (гибридный: артикул, полнотекст, похожесть названия, семантика). " +
        "Возвращает до 10 товаров: id, название, url карточки, артикул (sku), бренд, категория, цена на сайте и в магазине (₸, Алматы), " +
        "кратность и основные характеристики. Используй для любого вопроса о товарах, ценах, аналогах, артикулах. " +
        "query — что ищем своими словами или артикул (например «лампа светодиодная E27 10 Вт 4000К» или «150200550_»). " +
        "Фильтры сужают выборку до ранжирования; значения attrs сравниваются как подстрока без учёта регистра, " +
        "ключи attrs — точные названия характеристик (узнать их можно через category_facets). " +
        "Если с фильтрами ничего не нашлось, инструмент сам повторит поиск без attrs и вернёт relaxed=true.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Поисковый запрос или артикул. Можно опустить, если заданы только фильтры.",
          },
          brand: {
            type: "string",
            description: "Торговая марка, точное совпадение без учёта регистра (например «IEK», «Schneider Electric»).",
          },
          category: {
            type: "string",
            description: "Часть названия категории или её URL (например «Автоматические выключатели»).",
          },
          price_min: { type: "number", description: "Минимальная цена на сайте, ₸." },
          price_max: { type: "number", description: "Максимальная цена на сайте, ₸ (бюджет клиента)." },
          attrs: {
            type: "object",
            description:
              'Фильтр по характеристикам: {"Название характеристики": "значение"}, например {"Тип цоколя": "E27", "Мощность": "10"}.',
            additionalProperties: { type: "string" },
          },
          limit: {
            type: "integer",
            description: "Сколько товаров вернуть (1–10, по умолчанию 6).",
            minimum: 1,
            maximum: 10,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product",
      description:
        "Полная карточка одного товара: все характеристики, описание, цены, кратность, дата обновления данных. " +
        "Укажи ровно один из параметров: id (из результатов search_products), sku (артикул) или url карточки на ekt.kz.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "ID товара из результатов поиска." },
          sku: { type: "string", description: "Артикул товара (как на сайте)." },
          url: { type: "string", description: "URL карточки товара на ekt.kz." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "category_facets",
      description: "Какие характеристики и их самые частые значения встречаются у товаров категории. " +
        "Используй перед подбором с фильтрами, чтобы узнать точные названия характеристик для attrs в search_products.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Часть названия категории или её URL." },
        },
        required: ["category"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_categories",
      description: "Дерево каталога ekt.kz: без parent_url — корневые разделы, с parent_url — подкатегории раздела " +
        "(url, название, число товаров, есть ли вложенные).",
      parameters: {
        type: "object",
        properties: {
          parent_url: {
            type: "string",
            description: "URL родительской категории из предыдущего ответа list_categories.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Поиск по страницам сайта ekt.kz: FAQ, как оформить заказ, оплата, доставка, возврат, контакты, " +
        "о компании, производство и собственные марки, статьи, техническая информация, новости. " +
        "Возвращает фрагменты текста с url и заголовком страницы.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Вопрос или ключевые слова на русском." },
          kinds: {
            type: "array",
            description:
              "Необязательно: ограничить типами страниц. faq — частые вопросы, howto — как заказать, payment — оплата, " +
              "return — возврат, contacts — контакты, about — о компании, production — производство, article — статьи, " +
              "tech — техническая информация, news — новости.",
            items: { type: "string", enum: [...KNOWLEDGE_KINDS] },
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_branches",
      description: "Филиалы ГК «Электрокомплект» (9 городов Казахстана): адрес, телефоны, e-mail, график работы. " +
        "Без city — все филиалы.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "Город (например «Астана», «Шымкент», «almaty»)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_lead",
      description:
        "Создать заявку менеджеру магазина. Вызывай ТОЛЬКО после того, как клиент сам сообщил номер телефона " +
        "и явно согласился, чтобы с ним связались, и ты подтвердил с ним данные заявки. Никогда не придумывай " +
        "телефон и не бери его из другого источника — сервер проверяет, что телефон дословно встречается в " +
        "сообщениях клиента этого диалога, и откажет, если это не так.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Имя клиента." },
          phone: {
            type: "string",
            description: "Телефон клиента в формате Казахстана (+7XXXXXXXXXX или 8XXXXXXXXXX).",
          },
          email: { type: "string", description: "E-mail клиента, если сообщил." },
          city: { type: "string", description: "Город клиента." },
          request: {
            type: "string",
            description: "Суть запроса: что нужно, количество, объект/опт, удобное время звонка.",
          },
          product_ids: {
            type: "array",
            description: "ID товаров из результатов поиска, о которых идёт речь.",
            items: { type: "integer" },
          },
        },
        required: ["phone", "request"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate_to",
      description:
        "Переводит браузер клиента на другую страницу ekt.kz в этом же окне. Используй, когда клиент хочет " +
        "посмотреть или купить конкретный товар (веди на его карточку) или когда нужно показать страницу " +
        "возврата, оплаты, каталога или контактов. Разрешены только: (a) url, который уже встречался в " +
        "результатах инструментов этого диалога (карточка товара из search_products/get_product, страница базы " +
        "знаний из search_knowledge), или (b) служебные страницы: /return/, /payments/, /about/howto/, " +
        "/about/contacts/, /about/faq/, /catalog/svetilniki_lampy/lampy/, /personal/cart/, /. Никогда не " +
        "придумывай и не изменяй url — используй его ровно как в результатах инструментов, без query-параметров. " +
        "Перед вызовом одной фразой скажи клиенту, что делаешь (например «Открываю карточку товара…»). Не " +
        "вызывай, если клиент уже на этой странице или просто задаёт общий вопрос без намерения куда-то перейти. " +
        "Не больше одного вызова за ответ.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "url страницы ekt.kz из результатов инструментов или служебный путь — абсолютный " +
              "(https://ekt.kz/…) или относительный, начинающийся с «/» (например «/payments/»).",
          },
          label: {
            type: "string",
            description: "Короткая фраза для клиента о том, что открывается, например «Открываю карточку товара».",
          },
        },
        required: ["url", "label"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "highlight",
      description:
        "Подсвечивает на текущей странице сайта элемент, о котором идёт речь (прокрутка, рамка и подсказка). " +
        "Используй вместе с navigate_to (подсветка сработает после перехода) или отдельно, если клиент уже на " +
        "нужной странице. Не больше 3 вызовов за ответ.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Что подсветить.", enum: [...TARGETS] },
          note: { type: "string", description: "Короткая подсказка клиенту, например «Вот цена на сайте»." },
        },
        required: ["target", "note"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "Нажимает элемент на текущей странице сайта: buy_button — добавить товар в корзину; " +
        "search_submit — выполнить поиск (после fill_form form=search); buy_one_click/lead_form — открыть модалку " +
        "«Купить в 1 клик»/«Оставить заявку» (после открытия заполни её через fill_form). Виджет покажет " +
        "предупреждение с кнопкой «Отмена» на 2 секунды, подсветит элемент и нажмёт его. Вызывай ТОЛЬКО после " +
        "того, как клиент явно согласился («да, добавь», «нажми купить» и т. п.), и после того, как ты " +
        "объяснил, что сделаешь. Не оформляет и не подтверждает заказ — только действие в браузере клиента; " +
        "оформление корзины и заказа — на сайте. Не больше одного вызова за ответ.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Что нажать.", enum: [...CLICK_TARGETS] },
          label: { type: "string", description: "Короткая фраза клиенту, например «Добавляю в корзину»." },
        },
        required: ["target", "label"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill_form",
      description:
        "Заполняет поля формы/модалки на текущей странице сайта значениями из диалога (сам открывает модалку, " +
        "если форма в модалке). НЕ отправляет форму — нажимает «Отправить» клиент сам (search — исключение: " +
        "после fill_form form=search можно click_element target=search_submit). Вызывай ТОЛЬКО после того, как " +
        "собрал у клиента нужные данные и он согласился перейти к оформлению. Поля формы lead_form («Оставить " +
        "заявку»): name, email, phone, question — для возврата собери в question «Возврат: заказ №…, дата " +
        "покупки…, товар…, причина…». Поля buy_one_click («Купить в 1 клик»): name, phone, email. Поля search: q. " +
        "Указывай только реальные данные, которые сообщил клиент; поле phone указывай, только если клиент сам " +
        "его написал в этом диалоге — сервер проверяет это и откажет, если телефон в сообщениях клиента не " +
        "встречается. Не больше одного вызова за ответ.",
      parameters: {
        type: "object",
        properties: {
          form: { type: "string", description: "Целевая форма.", enum: [...FORMS] },
          fields: {
            type: "object",
            description: `Значения полей формы. Допустимые ключи: ${
              FORMS.map((f) => `${f} — ${FORM_FIELDS[f].join(", ")}`).join("; ")
            }.`,
            additionalProperties: { type: "string" },
          },
          label: {
            type: "string",
            description: "Короткая фраза клиенту, например «Заполняю заявление на возврат».",
          },
        },
        required: ["form", "fields", "label"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_replies",
      description:
        "Предлагает клиенту 1–4 коротких варианта следующего сообщения (кнопки под твоим ответом); клик по " +
        "кнопке отправляет её текст как сообщение клиента. Используй проактивно в конце ответа, чтобы " +
        "предложить следующий шаг сценария (например «Открыть карточку», «Добавить в корзину», «Оформить " +
        "возврат»). Не больше одного вызова за ответ.",
      parameters: {
        type: "object",
        properties: {
          options: {
            type: "array",
            description: "1–4 коротких варианта ответа (до 40 символов каждый).",
            items: { type: "string" },
            minItems: 1,
            maxItems: 4,
          },
        },
        required: ["options"],
        additionalProperties: false,
      },
    },
  },
];

export const TOOL_LABELS: Record<string, string> = {
  search_products: "Ищу товары…",
  get_product: "Открываю карточку товара…",
  category_facets: "Смотрю характеристики в категории…",
  list_categories: "Смотрю каталог…",
  search_knowledge: "Ищу информацию на сайте…",
  get_branches: "Смотрю контакты филиалов…",
  create_lead: "Оформляю заявку…",
  navigate_to: "Перехожу на страницу…",
  highlight: "Показываю на странице…",
  click_element: "Нажимаю на сайте…",
  fill_form: "Заполняю форму…",
  suggest_replies: "Предлагаю варианты…",
};

// ---------------------------------------------------------------------------
// Типы и утилиты
// ---------------------------------------------------------------------------

export interface ToolContext {
  db: Db;
  sessionId: string;
  /** Эмбеддинг запроса; null — если недоступен (поиск тогда без векторной части). */
  embed: (text: string) => Promise<number[] | null>;
  /**
   * Известные url ekt.kz этого диалога (из результатов инструментов текущего хода и истории) —
   * используется navigate_to для проверки допустимости перехода. Мутируется вызывающим кодом
   * между раундами цикла инструментов (chat.ts), чтобы позже вызванный navigate_to видел url,
   * найденные раньше в этом же ходе.
   */
  knownUrls: Set<string>;
  /**
   * Тексты сообщений клиента этого диалога (история + текущее) — используется fill_form (поле
   * phone) и create_lead, чтобы проверить, что телефон, который собирается указать модель,
   * действительно встречается в словах клиента, а не придуман/подставлен моделью.
   */
  userTexts: string[];
}

/** Карточка товара для события `products` виджета. */
export interface ProductCard {
  id: number;
  name: string;
  url: string;
  sku: string | null;
  brand: string | null;
  price_site: number | null;
  price_store: number | null;
  image_url: string | null;
}

export interface ToolOutcome {
  name: string;
  args: Record<string, unknown>;
  /** То, что уходит модели (JSON). */
  result: Record<string, unknown>;
  /** Товары, найденные этим вызовом. */
  cards: ProductCard[];
  /** UI-действие (navigate/highlight/click/fill/suggest), если инструмент его успешно провалидировал. */
  uiAction?: UiAction;
  error?: string;
}

const SKIP_ATTRS = new Set(["Артикул", "Артикул поставщика", "Новинка"]);
const MAX_ATTRS = 12;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown, max = 500): string | undefined => {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
};

export function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max).trimEnd() + "…";
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

export function compactAttrs(attrs: unknown, max = MAX_ATTRS): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attrs || typeof attrs !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (SKIP_ATTRS.has(k) || v === null || v === undefined || v === "") continue;
    out[k] = truncate(String(v), 80);
    if (++n >= max) break;
  }
  return out;
}

export function isoDate(ts: unknown): string | null {
  if (typeof ts !== "string" || !ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Almaty" }); // YYYY-MM-DD
}

function oldestDate(values: unknown[]): string | null {
  const dates = values.map(isoDate).filter((d): d is string => !!d).sort();
  return dates[0] ?? null;
}

function toCard(r: Record<string, unknown>): ProductCard {
  return {
    id: Number(r.id),
    name: String(r.name ?? ""),
    url: String(r.url ?? ""),
    sku: (r.sku as string) ?? null,
    brand: (r.brand as string) ?? null,
    price_site: num(r.price_site),
    price_store: num(r.price_store),
    image_url: (r.image_url as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Исполнители
// ---------------------------------------------------------------------------

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<Omit<ToolOutcome, "name" | "args">>;

/** Изменение цены сайта товара, известное клиенту: с какой суммы на текущую и когда. */
export interface PriceChange {
  from: number;
  at: string;
}

interface ProductMeta {
  dataUpdatedAt: string | null;
  /** product_id -> изменение цены, только если оно произошло за последние 30 дней. */
  priceChanges: Map<number, PriceChange>;
}

const PRICE_CHANGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Один запрос: дата обновления данных + недавние (30 дней) изменения цены сайта — для карточек search_products. */
async function productMeta(db: Db, ids: number[]): Promise<ProductMeta> {
  if (!ids.length) return { dataUpdatedAt: null, priceChanges: new Map() };
  const { data, error } = await db
    .from("products")
    .select("id, scraped_at, price_site_prev, price_changed_at")
    .in("id", ids);
  if (error) return { dataUpdatedAt: null, priceChanges: new Map() };
  const rows = (data ?? []) as {
    id: unknown;
    scraped_at: unknown;
    price_site_prev: unknown;
    price_changed_at: unknown;
  }[];
  const dataUpdatedAt = oldestDate(rows.map((r) => r.scraped_at));
  const now = Date.now();
  const priceChanges = new Map<number, PriceChange>();
  for (const r of rows) {
    if (!r.price_changed_at) continue;
    const changedAt = new Date(r.price_changed_at as string);
    const from = num(r.price_site_prev);
    const at = isoDate(r.price_changed_at);
    if (isNaN(changedAt.getTime()) || from === null || !at) continue;
    if (now - changedAt.getTime() > PRICE_CHANGE_WINDOW_MS) continue;
    priceChanges.set(Number(r.id), { from, at });
  }
  return { dataUpdatedAt, priceChanges };
}

const searchProducts: Executor = async (args, ctx) => {
  const query = str(args.query, 300);
  const brand = str(args.brand, 100);
  const category = str(args.category, 200);
  const priceMin = num(args.price_min);
  const priceMax = num(args.price_max);
  const limit = Math.max(1, Math.min(10, Math.trunc(num(args.limit) ?? 6)));
  let attrs: Record<string, string> | null = null;
  if (args.attrs && typeof args.attrs === "object" && !Array.isArray(args.attrs)) {
    const entries = Object.entries(args.attrs as Record<string, unknown>)
      .map(([k, v]) => [k.trim(), str(v, 100)] as const)
      .filter(([k, v]) => k && v)
      .slice(0, 10) as [string, string][];
    if (entries.length) attrs = Object.fromEntries(entries);
  }
  if (!query && !brand && !category && priceMin === null && priceMax === null && !attrs) {
    return { result: { error: "Укажи query или хотя бы один фильтр." }, cards: [] };
  }

  const embedding = query ? await ctx.embed(query) : null;
  const run = async (withAttrs: Record<string, string> | null, withCategory: string | undefined) => {
    const { data, error } = await ctx.db.rpc("search_products", {
      q: query ?? null,
      q_embedding: embedding ? JSON.stringify(embedding) : null,
      p_brand: brand ?? null,
      p_category: withCategory ?? null,
      p_price_min: priceMin,
      p_price_max: priceMax,
      p_attrs: withAttrs,
      p_limit: limit,
    });
    if (error) throw new Error(`search_products: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  };

  let rows = await run(attrs, category);
  const relaxed: string[] = [];
  if (rows.length === 0 && attrs) {
    rows = await run(null, category);
    relaxed.push("attrs");
  }
  if (rows.length === 0 && category && query) {
    rows = await run(null, undefined);
    relaxed.push("category");
  }

  const meta = await productMeta(ctx.db, rows.map((r) => Number(r.id)));
  const items = rows.map((r) => {
    const id = Number(r.id);
    const priceChanged = meta.priceChanges.get(id);
    return {
      id,
      name: r.name,
      url: r.url,
      sku: r.sku ?? null,
      brand: r.brand ?? null,
      category: Array.isArray(r.category_path) ? (r.category_path as string[]).join(" / ") : null,
      price_site: num(r.price_site),
      price_store: num(r.price_store),
      ...(r.order_note ? { order_note: r.order_note } : {}),
      ...(priceChanged ? { price_changed: priceChanged } : {}),
      multiplicity: num(r.multiplicity),
      attrs: compactAttrs(r.attrs),
    };
  });
  const result: Record<string, unknown> = {
    count: items.length,
    items,
    data_updated_at: meta.dataUpdatedAt,
    prices_note:
      "Цены в ₸ для Алматы; наличие и итоговую цену уточняет менеджер. price_site = null — цены на сайте нет (см. order_note, напр. «Под заказ»): говори «цена по запросу», предлагай заявку.",
  };
  if (relaxed.length) {
    result.relaxed = true;
    result.relaxed_note = `С исходными фильтрами ничего не нашлось; поиск повторён без: ${relaxed.join(", ")}. ` +
      "Проверь, что найденные товары действительно подходят, и скажи клиенту об этом.";
  }
  if (!items.length) {
    result.note = "Ничего не найдено. Не выдумывай товары; предложи уточнить запрос или оставить заявку.";
  }
  return { result, cards: rows.map(toCard) };
};

const PRODUCT_COLUMNS =
  "id, sku, supplier_sku, name, url, category_url, category_path, brand, price_site, price_store, order_note, currency, " +
  "city, multiplicity, is_new, image_url, description, attrs, is_active, scraped_at, " +
  "price_site_prev, price_store_prev, price_changed_at";

function urlVariants(raw: string): string[] {
  const u = raw.trim().replace(/^http:\/\//i, "https://").replace(/^https:\/\/www\./i, "https://");
  const base = u.split(/[?#]/)[0];
  const noSlash = base.replace(/\/+$/, "");
  return [...new Set([raw.trim(), base, noSlash, noSlash + "/"])];
}

const getProduct: Executor = async (args, ctx) => {
  const id = num(args.id);
  const sku = str(args.sku, 100);
  const url = str(args.url, 500);
  const q = () => ctx.db.from("products").select(PRODUCT_COLUMNS);
  let row: Record<string, unknown> | null = null;

  if (id !== null) {
    const { data, error } = await q().eq("id", id).maybeSingle();
    if (error) throw new Error(`get_product: ${error.message}`);
    row = data as unknown as Record<string, unknown> | null;
  }
  if (!row && url) {
    const { data, error } = await q().in("url", urlVariants(url)).limit(1);
    if (error) throw new Error(`get_product: ${error.message}`);
    row = (data?.[0] as unknown as Record<string, unknown>) ?? null;
  }
  if (!row && sku) {
    for (const [col, val] of [["sku", sku], ["sku", sku + "_"], ["supplier_sku", sku]] as const) {
      const { data, error } = await q().ilike(col, escapeLike(val)).order("is_active", { ascending: false }).limit(1);
      if (error) throw new Error(`get_product: ${error.message}`);
      if (data?.length) {
        row = data[0] as unknown as Record<string, unknown>;
        break;
      }
    }
  }
  if (id === null && !sku && !url) return { result: { error: "Укажи id, sku или url." }, cards: [] };
  if (!row) return { result: { found: false, note: "Товар не найден в каталоге ekt.kz." }, cards: [] };

  const priceChangedAt = row.price_changed_at ? isoDate(row.price_changed_at) : null;
  const item = {
    id: Number(row.id),
    name: row.name,
    url: row.url,
    sku: row.sku ?? null,
    supplier_sku: row.supplier_sku ?? null,
    brand: row.brand ?? null,
    category: Array.isArray(row.category_path) ? (row.category_path as string[]).join(" / ") : null,
    category_url: row.category_url ?? null,
    price_site: num(row.price_site),
    price_store: num(row.price_store),
    order_note: row.order_note ?? null,
    currency: row.currency,
    multiplicity: num(row.multiplicity),
    is_new: row.is_new,
    is_active: row.is_active,
    description: truncate(row.description as string, 1500),
    attrs: row.attrs ?? {},
    ...(priceChangedAt
      ? {
        price_site_prev: num(row.price_site_prev),
        price_store_prev: num(row.price_store_prev),
        price_changed_at: priceChangedAt,
      }
      : {}),
  };
  const result: Record<string, unknown> = {
    found: true,
    item,
    data_updated_at: isoDate(row.scraped_at),
    prices_note:
      "Цены в ₸ для Алматы; наличие и итоговую цену уточняет менеджер. price_site = null — цены на сайте нет (см. order_note, напр. «Под заказ»): говори «цена по запросу», предлагай заявку.",
  };
  if (!row.is_active) result.note = "Товар снят с продажи / отсутствует на сайте при последнем обновлении.";
  return { result, cards: row.is_active ? [toCard(row)] : [] };
};

const categoryFacets: Executor = async (args, ctx) => {
  const category = str(args.category, 200);
  if (!category) return { result: { error: "Укажи category." }, cards: [] };
  const { data, error } = await ctx.db.rpc("category_facets", { p_category: category, p_limit: 12 });
  if (error) throw new Error(`category_facets: ${error.message}`);
  const facets = ((data ?? []) as { key: string; top_values: string[] | null; products: number }[]).map((f) => ({
    key: f.key,
    values: (f.top_values ?? []).slice(0, 15).map((v) => truncate(v, 60)),
    products: f.products,
  }));
  return {
    result: facets.length
      ? { category, facets }
      : { category, facets: [], note: "Категория не найдена; попробуй list_categories или другое название." },
    cards: [],
  };
};

const listCategories: Executor = async (args, ctx) => {
  const parent = str(args.parent_url, 500) ?? null;
  const { data, error } = await ctx.db.rpc("list_categories", { p_parent_url: parent });
  if (error) throw new Error(`list_categories: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  return {
    result: {
      parent_url: parent,
      count: rows.length,
      categories: rows.slice(0, 40).map((r) => ({
        url: r.url,
        name: r.name,
        product_count: r.product_count,
        has_children: r.has_children,
      })),
    },
    cards: [],
  };
};

const searchKnowledge: Executor = async (args, ctx) => {
  const query = str(args.query, 300);
  if (!query) return { result: { error: "Укажи query." }, cards: [] };
  const kinds = Array.isArray(args.kinds)
    ? (args.kinds as unknown[]).filter((k): k is string =>
      typeof k === "string" && (KNOWLEDGE_KINDS as readonly string[]).includes(k)
    )
    : [];
  const embedding = await ctx.embed(query);
  const { data, error } = await ctx.db.rpc("search_chunks", {
    q: query,
    q_embedding: embedding ? JSON.stringify(embedding) : null,
    p_kinds: kinds.length ? kinds : null,
    p_limit: 5,
  });
  if (error) throw new Error(`search_knowledge: ${error.message}`);
  const items = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    url: r.url,
    title: r.title,
    kind: r.kind,
    heading: r.heading ?? null,
    content: truncate(r.content as string, 1200),
  }));
  return {
    result: items.length ? { count: items.length, items } : {
      count: 0,
      items: [],
      note: "Ничего не найдено на страницах сайта. Не выдумывай; предложи связаться с филиалом.",
    },
    cards: [],
  };
};

const CITY_ALIASES: Record<string, string[]> = {
  "алматы": ["almaty", "алма-ата", "алмата", "alma-ata"],
  "астана": ["astana", "нур-султан", "нурсултан", "nur-sultan", "акмола"],
  "шымкент": ["shymkent", "чимкент", "chimkent"],
  "актау": ["aktau", "ақтау"],
  "атырау": ["atyrau"],
  "тараз": ["taraz", "жамбыл"],
  "усть-каменогорск": ["ust-kamenogorsk", "оскемен", "өскемен", "oskemen", "уск"],
  "караганда": ["karaganda", "қарағанды", "караганды", "karagandy"],
  "талдыкорган": ["taldykorgan", "талдықорған"],
};

const normCity = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-яәғқңөұүһі0-9]/g, "");

export function canonicalCity(q: string): string {
  const n = normCity(q);
  for (const [canon, aliases] of Object.entries(CITY_ALIASES)) {
    if (normCity(canon) === n || aliases.some((a) => normCity(a) === n)) return canon;
  }
  return q;
}

const getBranches: Executor = async (args, ctx) => {
  const { data, error } = await ctx.db
    .from("branches")
    .select("city_slug, city, address, phones, emails, hours, sort")
    .order("sort");
  if (error) throw new Error(`get_branches: ${error.message}`);
  const all = (data ?? []) as Record<string, unknown>[];
  const city = str(args.city, 100);
  let rows = all;
  let note: string | undefined;
  if (city) {
    const canon = normCity(canonicalCity(city));
    const raw = normCity(city);
    rows = all.filter((b) => {
      const c = normCity(String(b.city ?? ""));
      const slug = normCity(String(b.city_slug ?? ""));
      return c === canon || slug === raw || (raw.length >= 3 && (c.includes(raw) || slug.includes(raw)));
    });
    if (!rows.length) {
      rows = all;
      note = `Филиала в городе «${city}» нет; ниже все филиалы.`;
    }
  }
  const branches = rows.map(({ sort: _s, ...b }) => b);
  return { result: note ? { note, branches } : { branches }, cards: [] };
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const createLead: Executor = async (args, ctx) => {
  const phoneRaw = str(args.phone, 40);
  const phone = phoneRaw ? normalizeKzPhone(phoneRaw) : null;
  if (!phone) {
    return {
      result: {
        ok: false,
        error: "Некорректный номер телефона. Попроси клиента указать номер в формате +7 7XX XXX XX XX.",
      },
      cards: [],
    };
  }
  if (!phoneMentionedByUser(phone, ctx.userTexts)) {
    return {
      result: {
        ok: false,
        error:
          "Телефон не найден в сообщениях клиента. Указывай телефон, только если клиент сам его написал в этом диалоге.",
      },
      cards: [],
    };
  }
  const request = str(args.request, 1500);
  if (!request) return { result: { ok: false, error: "Не указана суть заявки (request)." }, cards: [] };
  const email = str(args.email, 200);
  if (email && !EMAIL_RE.test(email)) {
    return { result: { ok: false, error: "Некорректный e-mail; уточни или не указывай его." }, cards: [] };
  }

  const { count } = await ctx.db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("session_id", ctx.sessionId);
  if ((count ?? 0) >= LIMITS.maxLeadsPerSession) {
    return {
      result: { ok: false, error: "Лимит заявок в этом диалоге исчерпан. Предложи позвонить в филиал." },
      cards: [],
    };
  }

  const ids = Array.isArray(args.product_ids)
    ? [...new Set((args.product_ids as unknown[]).map(num).filter((n): n is number => n !== null))].slice(0, 20)
    : [];
  let products: unknown[] = [];
  if (ids.length) {
    const { data } = await ctx.db.from("products").select("id, name, url, sku, price_site").in("id", ids);
    products = data ?? [];
  }

  const { data, error } = await ctx.db
    .from("leads")
    .insert({
      session_id: ctx.sessionId,
      name: str(args.name, 200) ?? null,
      phone,
      email: email ?? null,
      city: str(args.city, 100) ?? null,
      request,
      products,
    })
    .select("id")
    .single();
  if (error) throw new Error(`create_lead: ${error.message}`);
  return {
    result: {
      ok: true,
      lead_id: (data as { id: number }).id,
      phone,
      note: "Заявка передана менеджеру. Сообщи клиенту номер заявки и дай контакты филиала его города (get_branches).",
    },
    cards: [],
  };
};

// ---------------------------------------------------------------------------
// UI-действия (navigate/highlight/click/fill/suggest) — валидация в ui_actions.ts,
// здесь только разбор аргументов и упаковка в ToolOutcome.uiAction.
// ---------------------------------------------------------------------------

const navigateTo: Executor = (args, ctx) => {
  const url = str(args.url, 500) ?? "";
  const label = str(args.label, 200) ?? "";
  const v = buildNavigateAction(url, label, ctx.knownUrls);
  if (!v.ok) return Promise.resolve({ result: { ok: false, error: v.error }, cards: [] });
  return Promise.resolve({
    result: { ok: true, note: "Переход будет выполнен после ответа, в том же окне." },
    cards: [],
    uiAction: v.action,
  });
};

const highlightEl: Executor = (args) => {
  const target = str(args.target, 60) ?? "";
  const note = str(args.note, 200) ?? "";
  const v = validateHighlight(target, note);
  if (!v.ok) return Promise.resolve({ result: { ok: false, error: v.error }, cards: [] });
  return Promise.resolve({
    result: { ok: true, note: "Подсветка будет показана после ответа." },
    cards: [],
    uiAction: v.action,
  });
};

const clickElement: Executor = (args) => {
  const target = str(args.target, 60) ?? "";
  const label = str(args.label, 200) ?? "";
  const v = validateClick(target, label);
  if (!v.ok) return Promise.resolve({ result: { ok: false, error: v.error }, cards: [] });
  return Promise.resolve({
    result: { ok: true, note: "Нажатие будет выполнено после ответа." },
    cards: [],
    uiAction: v.action,
  });
};

const fillForm: Executor = (args, ctx) => {
  const form = str(args.form, 60) ?? "";
  const label = str(args.label, 200) ?? "";
  const v = validateFill(form, args.fields, label);
  if (!v.ok) return Promise.resolve({ result: { ok: false, error: v.error }, cards: [] });
  if (v.action.fields.phone && !phoneMentionedByUser(v.action.fields.phone, ctx.userTexts)) {
    return Promise.resolve({
      result: {
        ok: false,
        error:
          "Телефон не найден в сообщениях клиента. Указывай поле phone, только если клиент сам написал его в этом диалоге.",
      },
      cards: [],
    });
  }
  return Promise.resolve({
    result: { ok: true, note: "Форма будет заполнена после ответа; отправляет её клиент сам." },
    cards: [],
    uiAction: v.action,
  });
};

const suggestReplies: Executor = (args) => {
  const v = validateSuggest(args.options);
  if (!v.ok) return Promise.resolve({ result: { ok: false, error: v.error }, cards: [] });
  return Promise.resolve({
    result: { ok: true, note: "Варианты будут показаны клиенту после ответа." },
    cards: [],
    uiAction: v.action,
  });
};

const EXECUTORS: Record<string, Executor> = {
  search_products: searchProducts,
  get_product: getProduct,
  category_facets: categoryFacets,
  list_categories: listCategories,
  search_knowledge: searchKnowledge,
  get_branches: getBranches,
  create_lead: createLead,
  navigate_to: navigateTo,
  highlight: highlightEl,
  click_element: clickElement,
  fill_form: fillForm,
  suggest_replies: suggestReplies,
};

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
  } catch {
    return { name, args: {}, result: { error: "Некорректный JSON аргументов." }, cards: [], error: "bad_args" };
  }
  const exec = EXECUTORS[name];
  if (!exec) {
    return { name, args, result: { error: `Неизвестный инструмент ${name}.` }, cards: [], error: "unknown_tool" };
  }
  try {
    const out = await exec(args, ctx);
    return { name, args, ...out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`tool ${name} failed`, msg);
    return {
      name,
      args,
      result: { error: "Инструмент временно недоступен. Не выдумывай данные; предложи связаться с филиалом." },
      cards: [],
      error: msg.slice(0, 300),
    };
  }
}

/**
 * url, разрешённые для будущих navigate_to этого диалога: карточки товаров (cards — от
 * search_products/get_product), страницы базы знаний (search_knowledge.items[].url), url
 * успешного перехода (navigate_to). НАМЕРЕННО не берёт url из `args` (в т.ч. отклонённых вызовов
 * navigate_to или get_product(url=…) без найденного товара) и не берёт url категорий
 * (list_categories) — категория не входит в допустимые цели navigate_to по контракту.
 */
export function navUrlsOf(o: ToolOutcome): string[] {
  const urls = new Set<string>();
  for (const c of o.cards) if (c.url) urls.add(c.url);
  if (o.name === "search_knowledge" && Array.isArray(o.result.items)) {
    for (const it of o.result.items as Record<string, unknown>[]) {
      if (typeof it.url === "string" && it.url) urls.add(it.url);
    }
  }
  if (o.uiAction && o.uiAction.type === "navigate") urls.add(o.uiAction.url);
  return [...urls];
}

/** Компактная запись результата для аудита в chat_messages.tool_results. */
export function compactOutcome(o: ToolOutcome): Record<string, unknown> {
  const r = o.result;
  const out: Record<string, unknown> = { name: o.name, args: o.args };
  if (o.error) out.error = o.error;
  if (o.cards.length) out.products = o.cards;
  if (o.uiAction) out.action = o.uiAction;
  const navUrls = navUrlsOf(o);
  if (navUrls.length) out.nav_urls = navUrls;
  const urls = new Set<string>();
  const collect = (list: unknown) => {
    if (Array.isArray(list)) {
      for (const x of list) {
        if (x && typeof x === "object" && typeof (x as { url?: unknown }).url === "string") {
          urls.add((x as { url: string }).url);
        }
      }
    }
  };
  collect(r.items);
  collect(r.categories);
  if (urls.size && !o.cards.length) out.urls = [...urls];
  for (const k of ["count", "found", "relaxed", "ok", "lead_id", "data_updated_at"]) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  if (Array.isArray(r.branches)) out.branches = (r.branches as { city?: unknown }[]).map((b) => b.city);
  if (Array.isArray(r.facets)) out.facets = (r.facets as { key?: unknown }[]).map((f) => f.key);
  return out;
}
