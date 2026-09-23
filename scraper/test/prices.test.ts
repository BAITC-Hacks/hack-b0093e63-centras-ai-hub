import { describe, expect, it } from 'vitest';
import { detectPriceChanges, type ExistingPrice, type ProductRow } from '../src/rows.js';

function productRow(overrides: Partial<ProductRow> & Pick<ProductRow, 'id'>): ProductRow {
  return {
    sku: null,
    supplier_sku: null,
    name: `Товар ${overrides.id}`,
    url: `https://ekt.kz/product/${overrides.id}/`,
    category_url: null,
    category_path: [],
    brand: null,
    price_site: null,
    price_store: null,
    order_note: null,
    currency: 'KZT',
    city: 'almaty',
    multiplicity: 1,
    is_new: false,
    image_url: null,
    description: null,
    attrs: {},
    search_text: '',
    content_hash: 'hash',
    is_active: true,
    scraped_at: '2026-09-23T00:00:00.000Z',
    updated_at: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('detectPriceChanges', () => {
  it('detects a changed site price', () => {
    const existing = new Map<number, ExistingPrice>([[1, { price_site: 100, price_store: 90 }]]);
    const rows = [productRow({ id: 1, price_site: 120, price_store: 90 })];
    const changes = detectPriceChanges(existing, rows);
    expect(changes).toEqual([
      {
        product_id: 1,
        name: 'Товар 1',
        url: 'https://ekt.kz/product/1/',
        price_site_old: 100,
        price_site_new: 120,
        price_store_old: 90,
        price_store_new: 90,
      },
    ]);
  });

  it('detects a changed store price', () => {
    const existing = new Map<number, ExistingPrice>([[1, { price_site: 100, price_store: 90 }]]);
    const rows = [productRow({ id: 1, price_site: 100, price_store: 95 })];
    const changes = detectPriceChanges(existing, rows);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ price_store_old: 90, price_store_new: 95, price_site_old: 100, price_site_new: 100 });
  });

  it('treats null -> number as a change', () => {
    const existing = new Map<number, ExistingPrice>([[1, { price_site: null, price_store: 90 }]]);
    const rows = [productRow({ id: 1, price_site: 100, price_store: 90 })];
    const changes = detectPriceChanges(existing, rows);
    expect(changes).toHaveLength(1);
    expect(changes[0].price_site_old).toBeNull();
    expect(changes[0].price_site_new).toBe(100);
  });

  it('treats number -> null as a change', () => {
    const existing = new Map<number, ExistingPrice>([[1, { price_site: 100, price_store: 90 }]]);
    const rows = [productRow({ id: 1, price_site: null, price_store: 90 })];
    const changes = detectPriceChanges(existing, rows);
    expect(changes).toHaveLength(1);
    expect(changes[0].price_site_old).toBe(100);
    expect(changes[0].price_site_new).toBeNull();
  });

  it('reports no change when prices are equal', () => {
    const existing = new Map<number, ExistingPrice>([[1, { price_site: 100, price_store: 90 }]]);
    const rows = [productRow({ id: 1, price_site: 100, price_store: 90 })];
    expect(detectPriceChanges(existing, rows)).toEqual([]);
  });

  it('does not report a new product (not present in existing) as a change', () => {
    const existing = new Map<number, ExistingPrice>();
    const rows = [productRow({ id: 1, price_site: 100, price_store: 90 })];
    expect(detectPriceChanges(existing, rows)).toEqual([]);
  });

  it('compares numeric strings and numbers by value ("299.00" === 299)', () => {
    const existing = new Map<number, ExistingPrice>([[1, { price_site: '299.00', price_store: '90.00' }]]);
    const rows = [productRow({ id: 1, price_site: 299, price_store: 90 })];
    expect(detectPriceChanges(existing, rows)).toEqual([]);
  });

  it('still detects a real change alongside numeric-string equality on the other field', () => {
    const existing = new Map<number, ExistingPrice>([[1, { price_site: '299.00', price_store: '90.00' }]]);
    const rows = [productRow({ id: 1, price_site: 299, price_store: 120 })];
    const changes = detectPriceChanges(existing, rows);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ price_site_old: 299, price_site_new: 299, price_store_old: 90, price_store_new: 120 });
  });
});
