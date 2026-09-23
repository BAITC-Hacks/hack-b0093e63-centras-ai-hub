import {
  type CheerioAPI,
  absolutize,
  catalogCrumbs,
  cleanText,
  parseBreadcrumbs,
  parsePrice,
  textOf,
} from './common.js';

export interface Product {
  id: number;
  url: string;
  name: string;
  sku: string | null;
  supplier_sku: string | null;
  brand: string | null;
  price_site: number | null;
  price_store: number | null;
  currency: 'KZT';
  multiplicity: number;
  is_new: boolean;
  /** Подпись в блоке покупки вместо цены, например «Под заказ» (в БД не хранится). */
  order_note: string | null;
  image_url: string | null;
  description: string | null;
  attrs: Record<string, string>;
  category_url: string | null;
  category_path: string[];
  /** Категории из хлебных крошек (от корня), для построения дерева без обхода страниц категорий. */
  breadcrumb_categories: { url: string; name: string }[];
}

/** Признак карточки товара: блок покупки + вкладки описания/характеристик. */
export function isProductPage($: CheerioAPI): boolean {
  return $('.detail_info').length > 0 && ($('.tab_item_chars').length > 0 || $('.detail_info__price').length > 0);
}

function productId($: CheerioAPI): { id: number | null; kratnost: string | undefined } {
  const scope = $('.detail_info').first();
  const btn = scope.find('.btn-cart[data-id]').first();
  const candidates = [
    btn,
    scope.find('.tqBuyOneClick[data-id]').first(),
    scope.find('[data-id]').first(),
    $('.detail .btn-cart[data-id]').first(),
  ];
  for (const c of candidates) {
    const raw = c.attr('data-id');
    if (raw && /^\d+$/.test(raw.trim())) return { id: Number(raw.trim()), kratnost: btn.attr('data-kratnost') };
  }
  return { id: null, kratnost: undefined };
}

function priceFrom($: CheerioAPI, block: string): number | null {
  const $b = $(block).first();
  if (!$b.length) return null;
  const val = $b.find(`${block}__value`).first();
  return parsePrice(val.length ? val.text() : $b.text());
}

export function parseProduct($: CheerioAPI, url: string): Product | null {
  const name = cleanText($('h1').first().text());
  const { id, kratnost } = productId($);
  if (!name || id === null) return null;

  const attrs: Record<string, string> = {};
  $('.tab_item_chars__item').each((_, el) => {
    const k = cleanText($(el).find('.tab_item_chars__item__name').first().text()).replace(/\s*:\s*$/, '');
    const v = cleanText($(el).find('.tab_item_chars__item__value').first().text());
    if (k && v && !(k in attrs)) attrs[k] = v;
  });

  let description: string | null = null;
  $('.detail_tabs__body__item__value').each((_, el) => {
    if (description !== null || $(el).hasClass('tab_item_chars')) return;
    const t = textOf($(el));
    if (t) description = t;
  });

  const crumbs = catalogCrumbs(parseBreadcrumbs($));
  // последняя крошка — сам товар (без ссылки)
  const cats = crumbs.filter((c, i) => c.url !== null && !(i === crumbs.length - 1 && c.name === name));
  const category_path = cats.map((c) => c.name);
  const category_url = cats.length ? cats[cats.length - 1].url : null;

  const mult = kratnost ? Number(kratnost.replace(',', '.')) : NaN;
  const note = cleanText($('.detail_info__buttons > span').first().text());

  return {
    id,
    url,
    name,
    sku: attrs['Артикул'] ?? null,
    supplier_sku: attrs['Артикул поставщика'] ?? null,
    brand: attrs['Торговая марка'] ?? null,
    price_site: priceFrom($, '.detail_info__price__site'),
    price_store: priceFrom($, '.detail_info__price__shop'),
    currency: 'KZT',
    multiplicity: Number.isFinite(mult) && mult > 0 ? mult : 1,
    is_new: (attrs['Новинка'] ?? '').toLowerCase() === 'да',
    order_note: note || null,
    image_url: absolutize($('meta[property="og:image"]').attr('content')),
    description,
    attrs,
    category_url,
    category_path,
    breadcrumb_categories: cats.map((c) => ({ url: c.url as string, name: c.name })),
  };
}
