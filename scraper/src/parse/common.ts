import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

export type CheerioAPI = cheerio.CheerioAPI;

export const SITE_ORIGIN = 'https://ekt.kz';

export function load(html: string): CheerioAPI {
  return cheerio.load(html);
}

// nbsp, тонкие пробелы, пробел нулевой ширины, BOM (переводы строк не трогаем)
const SPACE_CHARS = new RegExp(`[${String.fromCharCode(0xa0, 0x2007, 0x2009, 0x202f, 0x200b, 0xfeff, 0x2060, 0x200c, 0x200d)}]`, "g");

/** Схлопывает пробелы (включая nbsp и тонкие пробелы) в одну строку. */
export function cleanText(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(SPACE_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Нормализует многострочный текст: пробелы внутри строк, пустые строки, маркеры списков «- ». */
export function normalizeMultiline(s: string): string {
  const lines = s
    .replace(/\r\n?/g, '\n')
    .replace(SPACE_CHARS, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .map((l) => l.replace(/^[•·●▪◦‣∙✓✔]\s*/, '- '));
  const out: string[] = [];
  let bullet = false;
  for (let l of lines) {
    // «-» отдельной строкой (li > p) — маркер для следующей непустой строки
    if (l === '-') {
      bullet = true;
      continue;
    }
    if (l === '') {
      if (bullet || out.length === 0 || out[out.length - 1] === '') continue;
    } else if (bullet) {
      if (!l.startsWith('- ')) l = `- ${l}`;
      bullet = false;
    }
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  // пустые строки между пунктами одного списка не нужны
  return out
    .filter((l, i) => !(l === '' && out[i + 1]?.startsWith('- ')))
    .join('\n');
}

/** Парсит цену: «Цена на сайте 1 234,50 ₸» → 1234.5; нет цифр → null. */
export function parsePrice(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = s.replace(SPACE_CHARS, '').replace(/\s+/g, '');
  const m = t.match(/\d[\d.,]*/);
  if (!m) return null;
  let num = m[0].replace(/[.,]+$/, '');
  const seps = num.match(/[.,]/g) ?? [];
  if (seps.length) {
    const last = Math.max(num.lastIndexOf(','), num.lastIndexOf('.'));
    const frac = num.slice(last + 1);
    const intPart = num.slice(0, last).replace(/[.,]/g, '');
    const mixed = num.includes(',') && num.includes('.');
    // один тип разделителя и ровно 3 цифры после него (или разделителей несколько) — это тысячи
    const isThousands = !mixed && (seps.length > 1 || frac.length === 3);
    num = isThousands ? intPart + frac : `${intPart}.${frac}`;
  }
  const v = Number(num);
  return Number.isFinite(v) ? v : null;
}

/** Абсолютный URL; исправляет двойной слеш после домена («https://ekt.kz//upload» → «https://ekt.kz/upload»). */
export function absolutize(href: string | undefined | null, base = SITE_ORIGIN): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(javascript:|#|mailto:|tel:)/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Канонический вид URL для дедупликации: https, без query/hash, без двойных слешей. */
export function canonicalUrl(url: string): string {
  const u = new URL(url);
  u.protocol = 'https:';
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  return u.toString();
}

export function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export interface Crumb {
  name: string;
  url: string | null;
}

/** Хлебные крошки без пустых элементов и дублей (соседние элементы с одинаковым названием склеиваются). */
export function parseBreadcrumbs($: CheerioAPI): Crumb[] {
  const crumbs: Crumb[] = [];
  $('.breadcrumbs').first().find('li').each((_, li) => {
    const $li = $(li);
    let name = cleanText($li.find('[itemprop=name]').first().text());
    if (!name) name = cleanText($li.clone().find('.nav-item').remove().end().text());
    if (!name) return;
    const url = absolutize($li.find('a[href]').first().attr('href'));
    const prev = crumbs[crumbs.length - 1];
    if (prev && prev.name === name && (prev.url === url || !prev.url || !url)) {
      if (!prev.url && url) prev.url = url;
      return;
    }
    crumbs.push({ name, url });
  });
  return crumbs;
}

/** Крошки внутри каталога: всё, что после «Каталог». */
export function catalogCrumbs(crumbs: Crumb[]): Crumb[] {
  const i = crumbs.findIndex((c) => c.name === 'Каталог' || (c.url !== null && urlPath(c.url) === '/catalog/'));
  return i >= 0 ? crumbs.slice(i + 1) : [];
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'blockquote', 'dl', 'dt', 'dd', 'pre', 'figure', 'figcaption', 'address', 'hr', 'center',
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'button', 'input', 'select', 'textarea']);

/** DOM-узел → «сырой» текст с переносами: блоки — новая строка, li — «- », br — перенос, ячейки — « | ». */
export function nodeToRawText(node: AnyNode): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === 'text') {
      parts.push((n as unknown as { data: string }).data.replace(/\s+/g, ' '));
      return;
    }
    if (n.type !== 'tag' && n.type !== 'script' && n.type !== 'style') return;
    const el = n as Element;
    const tag = el.tagName?.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    if (tag === 'li') {
      parts.push('\n- ');
      el.children.forEach(walk);
      parts.push('\n');
      return;
    }
    if (tag === 'td' || tag === 'th') {
      el.children.forEach(walk);
      parts.push(' | ');
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    el.children.forEach(walk);
    if (block) parts.push('\n');
  };
  walk(node);
  return parts.join('').replace(/ \| *(?=\n|$)/g, '');
}

export function nodeToText(node: AnyNode): string {
  return normalizeMultiline(nodeToRawText(node));
}

export function textOf($el: cheerio.Cheerio<AnyNode>): string {
  const node = $el.get(0);
  return node ? nodeToText(node) : '';
}
