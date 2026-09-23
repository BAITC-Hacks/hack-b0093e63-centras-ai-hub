import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAndParse, pageKind } from '../src/parse/index.js';
import type { Branch, Category, Page, Product } from '../src/parse/index.js';
import { mergeCategories } from '../src/parse/category.js';
import { absolutize, normalizeMultiline, parsePrice } from '../src/parse/common.js';
import { parseRobots } from '../src/robots.js';

const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.html`), 'utf8');

const URLS = {
  product: 'https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/led_lampa_a60_standart_10w_900lm_230v_4000k_e27_megalight_100/',
  product2: 'https://ekt.kz/catalog/kabel_provod/kabel_silovoy_dlya_statsionarnoy_prokladki_/mednyy_ognestoykiy_vvgng_frls_/vvgng_a_frls_5kh6/',
  category: 'https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/',
  faq: 'https://ekt.kz/about/faq/',
  return: 'https://ekt.kz/return/',
  payments: 'https://ekt.kz/payments/',
  howto: 'https://ekt.kz/about/howto/',
  article: 'https://ekt.kz/about/information/articles/lotok-lestnichnyy-provolochnyy-ekt/',
  contacts: 'https://ekt.kz/about/contacts/',
} as const;

function parse(name: keyof typeof URLS) {
  return classifyAndParse(URLS[name], fixture(name));
}
function asProduct(name: keyof typeof URLS): Product {
  const r = parse(name);
  expect(r.type).toBe('product');
  return r.data as Product;
}
function asPage(name: keyof typeof URLS): Page {
  const r = parse(name);
  expect(r.type).toBe('page');
  return r.data as Page;
}

const BOILERPLATE = ['Подписаться', 'Оставить заявку', 'Ваш город', 'Личный кабинет', 'Вы добавили товар в корзину', 'Экономьте свое время'];

describe('product', () => {
  const p = asProduct('product');

  it('parses exact fields', () => {
    expect(p.id).toBe(20094);
    expect(p.name).toBe('LED ЛАМПА A60 "Standart" 10W 900Lm 230V 4000K E27 MEGALIGHT (100)');
    expect(p.url).toBe(URLS.product);
    expect(p.price_site).toBe(281);
    expect(p.price_store).toBe(294);
    expect(p.sku).toBe('150200550_');
    expect(p.supplier_sku).toBe('150200550_');
    expect(p.brand).toBe('MEGALIGHT');
    expect(p.multiplicity).toBe(1);
    expect(p.is_new).toBe(false);
    expect(p.currency).toBe('KZT');
  });

  it('keeps all characteristics in attrs', () => {
    expect(p.attrs['Тип цоколя']).toBe('E27');
    expect(p.attrs['Мощность']).toBe('10');
    expect(p.attrs['Артикул']).toBe('150200550_');
    expect(p.attrs['Новинка']).toBe('Нет');
    expect(Object.keys(p.attrs)).toHaveLength(11);
    expect(Object.keys(p.attrs).every((k) => !k.endsWith(':'))).toBe(true);
  });

  it('parses category path, image and description', () => {
    expect(p.category_path).toEqual(['Светильники / Лампы', 'Лампы', 'LED ЛАМПЫ серии A "Standart"']);
    expect(p.category_path.at(-1)).toBe('LED ЛАМПЫ серии A "Standart"');
    expect(p.category_url).toBe('https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/');
    expect(p.image_url).toMatch(/^https:\/\/ekt\.kz\/upload\/iblock\//);
    expect(p.image_url).not.toContain('//upload');
    expect(p.description).toContain('Светодиодные лампы MEGALIGHT');
    expect(p.description).not.toContain('Артикул:');
  });

  it('product2 (под заказ, без цены) sanity', () => {
    const p2 = asProduct('product2');
    expect(p2.id).toBe(20515);
    expect(p2.name).toBe('ВВГнг (А)-FRLS 5х6');
    expect(p2.sku).toBe('щт-0000855');
    expect(p2.supplier_sku).toBe('ВВГнг-FRLS 5х6');
    expect(p2.price_site).toBeNull();
    expect(p2.order_note).toBe('Под заказ');
    expect(p2.category_path).toEqual([
      'Кабель / Провод',
      'Кабель силовой для стационарной прокладки',
      'Медный огнестойкий ВВГнг FRLs',
    ]);
    expect(p2.description).toContain('Конструкция');
  });
});

describe('category', () => {
  it('parses category page', () => {
    const r = parse('category');
    expect(r.type).toBe('category');
    const c = r.data as Category;
    expect(c.name).toBe('LED ЛАМПЫ серии A "Standart"');
    expect(c.url).toBe(URLS.category);
    expect(c.parent_url).toBe('https://ekt.kz/catalog/svetilniki_lampy/lampy/');
    expect(c.path).toEqual(['Светильники / Лампы', 'Лампы', 'LED ЛАМПЫ серии A "Standart"']);
    expect(c.depth).toBe(2);
  });

  it('merges breadcrumb categories with fetched ones', () => {
    const c = parse('category').data as Category;
    const p = asProduct('product2');
    const merged = mergeCategories([c], [p.breadcrumb_categories]);
    expect(merged.map((m) => m.url)).toContain('https://ekt.kz/catalog/kabel_provod/');
    expect(merged.find((m) => m.url === 'https://ekt.kz/catalog/svetilniki_lampy/')?.parent_url).toBeNull();
    const root = merged.find((m) => m.url === 'https://ekt.kz/catalog/svetilniki_lampy/lampy/');
    expect(root?.parent_url).toBe('https://ekt.kz/catalog/svetilniki_lampy/');
    expect(merged.find((m) => m.url === URLS.category)?.fetched).toBe(true);
    // родители раньше детей
    const depths = merged.map((m) => m.depth);
    expect([...depths].sort((a, b) => a - b)).toEqual(depths);
  });
});

describe('pages', () => {
  it('faq: one section per Q/A', () => {
    const p = asPage('faq');
    expect(p.kind).toBe('faq');
    expect(p.title).toBe('Часто задаваемые вопросы (FAQ)');
    expect(p.sections.length).toBeGreaterThan(5);
    const first = p.sections[0];
    expect(first.heading).toBe('Как связаться с EKT для консультации?');
    expect(first.content).toContain('Контакты необходимо выбирать');
    expect(first.content).toContain('- город;');
    expect(p.sections.every((s) => s.heading && s.content)).toBe(true);
  });

  it('return: content without boilerplate', () => {
    const p = asPage('return');
    expect(p.kind).toBe('return');
    expect(p.content).toContain('14 дней');
    expect(p.content).toContain('- Товары с нарушенной одноразовой упаковкой');
    for (const b of BOILERPLATE) expect(p.content).not.toContain(b);
  });

  it.each(['payments', 'howto', 'article'] as const)('%s: main content only', (name) => {
    const p = asPage(name);
    expect(p.content.length).toBeGreaterThan(500);
    expect(p.sections.length).toBeGreaterThan(1);
    for (const b of BOILERPLATE) expect(p.content).not.toContain(b);
  });

  it('howto: numbered steps become headings', () => {
    const p = asPage('howto');
    expect(p.kind).toBe('howto');
    expect(p.sections.map((s) => s.heading)).toContain('1. Подбор Товара');
    expect(p.content).toContain('15 000 тенге');
  });

  it('article kind and title', () => {
    const p = asPage('article');
    expect(p.kind).toBe('article');
    expect(p.title).toBe('Лоток лестничный, проволочный EKT');
  });

  it('payments kind', () => {
    expect(asPage('payments').kind).toBe('payment');
  });
});

describe('contacts / branches', () => {
  const r = parse('contacts');
  const branches = (r.type === 'page' ? r.branches : []) as Branch[];

  it('parses 9 branches', () => {
    expect(branches).toHaveLength(9);
    expect(branches.map((b) => b.city_slug)).toEqual([
      'almaty', 'astana', 'shymkent', 'aktau', 'atyrau', 'taraz', 'ust-kamenogorsk', 'karaganda', 'taldykorgan',
    ]);
  });

  it('almaty branch details', () => {
    const a = branches[0];
    expect(a.city).toBe('Алматы');
    expect(a.phones).toContain('+7 (727) 346-88-88');
    expect(a.emails).toEqual(['almaty@ekt.kz']);
    expect(a.address).toContain('Кудерина, 47Б');
    expect(a.hours).toContain('Пн-Пт 09.00-18.00');
    expect(branches.every((b) => b.phones.length > 0 && b.emails.length > 0 && b.address)).toBe(true);
  });

  it('contacts page is emitted as kind contacts', () => {
    expect(r.type).toBe('page');
    const p = r.data as Page;
    expect(p.kind).toBe('contacts');
    expect(p.content).toContain('+7 (727) 346-88-88');
    expect(p.sections).toHaveLength(9);
  });
});

describe('classification', () => {
  it('maps kinds by url', () => {
    expect(pageKind('https://ekt.kz/about/faq/')).toBe('faq');
    expect(pageKind('https://ekt.kz/about/howto/')).toBe('howto');
    expect(pageKind('https://ekt.kz/payments/')).toBe('payment');
    expect(pageKind('https://ekt.kz/return/')).toBe('return');
    expect(pageKind('https://ekt.kz/about/contacts/')).toBe('contacts');
    expect(pageKind('https://ekt.kz/about/production/x/')).toBe('production');
    expect(pageKind('https://ekt.kz/about/information/articles/x/')).toBe('article');
    expect(pageKind('https://ekt.kz/about/information/technical-information/x/')).toBe('tech');
    expect(pageKind('https://ekt.kz/news/x/')).toBe('news');
    expect(pageKind('https://ekt.kz/about/our-team/')).toBe('about');
  });

  it('skips home page', () => {
    expect(classifyAndParse('https://ekt.kz/', fixture('return')).type).toBe('skip');
  });
});

describe('parsePrice', () => {
  it.each([
    ['Цена на сайте 281 ₸', 281],
    ['1 234 ₸', 1234],
    ['12 345 ₸', 12345],
    ['12 345,50 ₸', 12345.5],
    ['1 234,5', 1234.5],
    ['99.90', 99.9],
    ['1.234.567', 1234567],
    ['1,234', 1234],
    ['1 234.56 тг', 1234.56],
    ['Цена по запросу', null],
    ['', null],
    [null, null],
  ])('%s → %s', (input, expected) => {
    expect(parsePrice(input as string | null)).toBe(expected);
  });
});

describe('common', () => {
  it('fixes double slash in og:image', () => {
    expect(absolutize('https://ekt.kz//upload/a.jpg')).toBe('https://ekt.kz/upload/a.jpg');
    expect(absolutize('/catalog/x/')).toBe('https://ekt.kz/catalog/x/');
    expect(absolutize('javascript:void(0)')).toBeNull();
  });

  it('normalizes bullets and blank lines', () => {
    expect(normalizeMultiline('a\n\n\n•   b\n-\nc\n\n')).toBe('a\n- b\n- c');
  });
});

describe('robots', () => {
  const robots = parseRobots(
    [
      'User-Agent: *',
      'Disallow: /*index.php$',
      'Disallow: /bitrix/',
      'Disallow: /*?*',
      'Disallow: /about/faq/',
      'Disallow: */filter/*',
      'Disallow: /upload/brands/ЖЫЛУ%20Квадрат.png',
      'Allow: /bitrix/public/',
      '',
      'User-agent: BadBot',
      'Disallow: /',
      '',
      'Sitemap: https://ekt.kz/sitemap.xml',
    ].join('\n'),
    'EKT-Consultant-Bot/1.0',
  );

  it.each([
    ['https://ekt.kz/catalog/kabel_provod/', true],
    ['https://ekt.kz/catalog/kabel_provod/?PAGEN_1=2', false],
    ['https://ekt.kz/bitrix/js/x.js', false],
    ['https://ekt.kz/bitrix/public/x.js', true],
    ['https://ekt.kz/about/faq/', false],
    ['https://ekt.kz/about/contacts/', true],
    ['https://ekt.kz/catalog/index.php', false],
    ['https://ekt.kz/catalog/index.php/x', true],
    ['https://ekt.kz/catalog/lampy/filter/brand-is-x/apply/', false],
    ['https://ekt.kz/upload/brands/%D0%96%D0%AB%D0%9B%D0%A3%20%D0%9A%D0%B2%D0%B0%D0%B4%D1%80%D0%B0%D1%82.png', false],
  ])('%s → %s', (url, allowed) => {
    expect(robots.isAllowed(url)).toBe(allowed);
  });

  it('collects sitemaps and ignores other agents', () => {
    expect(robots.sitemaps).toEqual(['https://ekt.kz/sitemap.xml']);
    expect(parseRobots('User-agent: BadBot\nDisallow: /', 'EKT-Consultant-Bot').isAllowed('https://ekt.kz/x/')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /', 'x').isAllowed('https://ekt.kz/x/')).toBe(false);
  });
});
