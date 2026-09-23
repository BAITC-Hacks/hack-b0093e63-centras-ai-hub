import { describe, expect, it } from 'vitest';
import { chunkSections } from '../src/chunk.js';
import { productRow, productSearchText } from '../src/rows.js';
import type { Product } from '../src/parse/index.js';

describe('chunkSections', () => {
  it('keeps short sections as single chunks with heading', () => {
    const chunks = chunkSections([
      { heading: 'Вопрос 1?', content: 'Ответ 1.' },
      { heading: 'Вопрос 2?', content: 'Ответ 2.' },
    ]);
    expect(chunks).toEqual([
      { heading: 'Вопрос 1?', content: 'Ответ 1.' },
      { heading: 'Вопрос 2?', content: 'Ответ 2.' },
    ]);
  });

  it('splits long sections to ~maxChars with overlap and carries heading', () => {
    const para = (i: number) => `Абзац ${i}. ` + 'Текст про кабель и автоматы. '.repeat(12);
    const content = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkSections([{ heading: 'Доставка', content }], { maxChars: 1200, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.heading).toBe('Доставка');
      expect(c.content.length).toBeLessThanOrEqual(1200 + 5);
    }
    // перекрытие: второй чанк начинается с хвоста первого
    expect(chunks[1].content.startsWith('…')).toBe(true);
    // ничего не потеряно
    for (let i = 0; i < 12; i++) expect(chunks.some((c) => c.content.includes(`Абзац ${i}.`))).toBe(true);
  });

  it('hard-splits a single huge word', () => {
    const chunks = chunkSections([{ heading: null, content: 'x'.repeat(5000) }], { maxChars: 1000, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.every((c) => c.content.length <= 1000)).toBe(true);
  });

  it('skips empty sections and merges tiny headless ones', () => {
    const chunks = chunkSections([
      { heading: 'A', content: 'Первый раздел.' },
      { heading: null, content: '' },
      { heading: null, content: 'хвост' },
    ]);
    expect(chunks).toEqual([{ heading: 'A', content: 'Первый раздел.\nхвост' }]);
  });
});

describe('product rows', () => {
  const p: Product = {
    id: 1,
    url: 'https://ekt.kz/catalog/a/b/',
    name: 'Лампа LED 10W E27',
    sku: '123_',
    supplier_sku: 'S-1',
    brand: 'MEGALIGHT',
    price_site: 281,
    price_store: 294,
    currency: 'KZT',
    multiplicity: 1,
    is_new: false,
    order_note: null,
    image_url: null,
    description: 'Описание '.repeat(100),
    attrs: { 'Тип цоколя': 'E27' },
    category_url: 'https://ekt.kz/catalog/a/',
    category_path: ['Светильники / Лампы', 'Лампы'],
    breadcrumb_categories: [],
  };

  it('builds search_text', () => {
    const t = productSearchText(p);
    expect(t).toContain('Лампа LED 10W E27');
    expect(t).toContain('MEGALIGHT');
    expect(t).toContain('123_');
    expect(t).toContain('S-1');
    expect(t).toContain('Светильники / Лампы / Лампы');
    expect(t).toContain('Тип цоколя: E27');
    expect(t.length).toBeLessThan(700);
  });

  it('content_hash changes with price, drops unknown category', () => {
    const a = productRow(p, 'now');
    const b = productRow({ ...p, price_site: 300 }, 'now');
    expect(a.content_hash).not.toBe(b.content_hash);
    expect(productRow(p, 'now', new Set()).category_url).toBeNull();
    expect(a.category_url).toBe('https://ekt.kz/catalog/a/');
  });
});
