// Преобразование данных скрапера в строки БД (чистые функции).
import { createHash } from 'node:crypto';
import { type Chunk, chunkSections } from './chunk.js';
import type { Branch, Category, Page, Product } from './parse/index.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const EMBED_TEXT_MAX = 2000;

export function productSearchText(p: Product): string {
  const attrs = Object.entries(p.attrs).map(([k, v]) => `${k}: ${v}`);
  const parts = [
    p.name,
    p.brand,
    p.sku,
    p.supplier_sku,
    p.category_path.join(' / '),
    ...attrs,
    p.description ? p.description.slice(0, 500) : null,
  ];
  return parts
    .filter((x): x is string => !!x && x.trim() !== '')
    .join('\n');
}

export function productEmbedText(searchText: string): string {
  return searchText.slice(0, EMBED_TEXT_MAX);
}

export interface ProductRow {
  id: number;
  sku: string | null;
  supplier_sku: string | null;
  name: string;
  url: string;
  category_url: string | null;
  category_path: string[];
  brand: string | null;
  price_site: number | null;
  price_store: number | null;
  order_note: string | null;
  currency: string;
  city: string;
  multiplicity: number;
  is_new: boolean;
  image_url: string | null;
  description: string | null;
  attrs: Record<string, string>;
  search_text: string;
  content_hash: string;
  is_active: boolean;
  scraped_at: string;
  updated_at: string;
}

export function productRow(p: Product, scrapedAt: string, knownCategories?: Set<string>): ProductRow {
  const search_text = productSearchText(p);
  const content_hash = sha256(
    [productEmbedText(search_text), p.price_site ?? '', p.price_store ?? ''].join('\u0000'),
  );
  const category_url =
    p.category_url && (!knownCategories || knownCategories.has(p.category_url)) ? p.category_url : null;
  return {
    id: p.id,
    sku: p.sku,
    supplier_sku: p.supplier_sku,
    name: p.name,
    url: p.url,
    category_url,
    category_path: p.category_path,
    brand: p.brand,
    price_site: p.price_site,
    price_store: p.price_store,
    order_note: p.order_note ?? null,
    currency: p.currency ?? 'KZT',
    city: 'almaty',
    multiplicity: p.multiplicity,
    is_new: p.is_new,
    image_url: p.image_url,
    description: p.description,
    attrs: p.attrs,
    search_text,
    content_hash,
    is_active: true,
    scraped_at: scrapedAt,
    updated_at: new Date().toISOString(),
  };
}

export function categoryRow(c: Category, known: Set<string>) {
  return {
    url: c.url,
    name: c.name,
    parent_url: c.parent_url && known.has(c.parent_url) ? c.parent_url : null,
    path: c.path,
    depth: c.depth,
    updated_at: new Date().toISOString(),
  };
}

export function pageRow(p: Page, scrapedAt: string) {
  return {
    url: p.url,
    kind: p.kind,
    title: p.title,
    content: p.content,
    content_hash: sha256([p.kind, p.title, p.content].join('\u0000')),
    scraped_at: scrapedAt,
  };
}

export function pageChunks(p: Page): (Chunk & { chunk_index: number; content_hash: string })[] {
  return chunkSections(p.sections).map((c, i) => ({
    ...c,
    chunk_index: i,
    content_hash: sha256(`${c.heading ?? ''}\u0000${c.content}`),
  }));
}

export function chunkEmbedText(title: string, heading: string | null, content: string): string {
  return [title, heading && heading !== title ? heading : null, content].filter(Boolean).join('\n').slice(0, 4000);
}

export function branchRow(b: Branch) {
  return { ...b, updated_at: new Date().toISOString() };
}
