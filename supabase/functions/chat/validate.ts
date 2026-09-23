// Детерминированная проверка ответа модели: ссылки на ekt.kz и цены сверяются с данными инструментов.
// Результат пишется только во flags сообщения (клиенту не показывается).

export interface ValidationFlags {
  unknown_urls?: string[];
  unmatched_prices?: number[];
  no_tool_price?: boolean;
}

export interface ValidationInput {
  answer: string;
  /** Сырые результаты (и аргументы) инструментов этого хода и, опционально, прошлых ходов. */
  toolData: unknown[];
  /** Был ли вызван хотя бы один инструмент в этом ходе. */
  toolCalled: boolean;
  /** Тексты, из которых цены тоже считаются «известными» (например, сообщение клиента с бюджетом). */
  extraTexts?: string[];
}

const EKT_URL_RE = /https?:\/\/(?:www\.)?ekt\.kz(?:\/[^\s<>"'`()\[\]{}]*)?/gi;
// Число с пробелами-разделителями тысяч (обычный, неразрывный, узкий неразрывный) и копейками.
const PRICE_RE =
  /(?<![\d.,])(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:₸|тг\.?(?![а-яё])|тенге|kzt\b)/giu;

/** Приводит URL ekt.kz к каноническому виду для сравнения. */
export function normalizeUrl(u: string): string {
  let s = u.trim().replace(/[.,;:!?…»"')\]]+$/u, "");
  s = s.replace(/^http:\/\//i, "https://").replace(/^https:\/\/www\./i, "https://");
  s = s.split("#")[0];
  const m = s.match(/^https:\/\/ekt\.kz(.*)$/i);
  if (!m) return s;
  let path = m[1] || "/";
  try {
    path = decodeURI(path);
  } catch { /* оставляем как есть */ }
  path = path.replace(/\/+$/, "") || "/";
  return "https://ekt.kz" + path.toLowerCase();
}

export function extractUrls(text: string): string[] {
  return [...text.matchAll(EKT_URL_RE)].map((m) => m[0]);
}

export function extractPrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const int = m[1].replace(/[   ]/g, "");
    const frac = m[2] ? "." + m[2] : "";
    const n = Number(int + frac);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export interface KnownData {
  urls: Set<string>;
  prices: number[];
}

/** Рекурсивно собирает известные URL и цены из данных инструментов. */
export function collectKnown(data: unknown[], extraTexts: string[] = []): KnownData {
  const urls = new Set<string>(["https://ekt.kz/"].map(normalizeUrl));
  const prices: number[] = [];
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === "string") {
      for (const u of extractUrls(v)) urls.add(normalizeUrl(u));
      prices.push(...extractPrices(v));
      if (/price/i.test(key)) {
        const n = Number(v);
        if (Number.isFinite(n)) prices.push(n);
      }
      return;
    }
    if (typeof v === "number") {
      if (/price/i.test(key)) prices.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
    }
  };
  for (const d of data) walk(d, "", 0);
  for (const t of extraTexts) {
    prices.push(...extractPrices(t));
    // Бюджет клиента часто пишут без знака валюты: «до 5000».
    for (const m of t.matchAll(/\d{1,3}(?:[   ]\d{3})+|\d{3,}/g)) {
      prices.push(Number(m[0].replace(/[   ]/g, "")));
    }
  }
  return { urls, prices };
}

const priceKnown = (p: number, known: number[]) => known.some((k) => Math.abs(k - p) < 1);

export function validateAnswer(input: ValidationInput): ValidationFlags {
  const known = collectKnown(input.toolData, input.extraTexts);
  const flags: ValidationFlags = {};

  const unknownUrls = [...new Set(extractUrls(input.answer).map((u) => normalizeUrl(u)))]
    .filter((u) => !known.urls.has(u));
  if (unknownUrls.length) flags.unknown_urls = unknownUrls;

  const prices = extractPrices(input.answer);
  if (prices.length) {
    const unmatched = [...new Set(prices.filter((p) => !priceKnown(p, known.prices)))];
    if (unmatched.length) flags.unmatched_prices = unmatched;
    if (!input.toolCalled) flags.no_tool_price = true;
  }
  return flags;
}

export interface CardLike {
  id: number;
  url: string;
  sku: string | null;
}

/**
 * Товары, упомянутые в ответе (по URL, иначе по артикулу), в порядке первого упоминания.
 * Дубликаты по id убираются; возвращается не больше `max`.
 */
export function pickMentionedProducts<T extends CardLike>(answer: string, cards: T[], max: number): T[] {
  const firstUrlPos = new Map<string, number>();
  for (const m of answer.matchAll(EKT_URL_RE)) {
    const n = normalizeUrl(m[0]);
    if (!firstUrlPos.has(n)) firstUrlPos.set(n, m.index ?? 0);
  }
  const lower = answer.toLowerCase();
  const found = new Map<number, { card: T; at: number }>();
  for (const c of cards) {
    if (!c.url || found.has(c.id)) continue;
    let at = firstUrlPos.get(normalizeUrl(c.url));
    if (at === undefined && c.sku && c.sku.length >= 5) {
      const idx = lower.indexOf(c.sku.toLowerCase());
      if (idx !== -1) at = idx;
    }
    if (at !== undefined) found.set(c.id, { card: c, at });
  }
  return [...found.values()].sort((a, b) => a.at - b.at).slice(0, max).map((x) => x.card);
}
