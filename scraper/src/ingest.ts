// Загрузка data/* в Supabase: категории → товары → страницы и чанки → филиалы, эмбеддинги OpenAI.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { sleep } from './http.js';
import type { Branch, Category, Page, Product } from './parse/index.js';
import {
  type ProductRow,
  branchRow,
  categoryRow,
  chunkEmbedText,
  pageChunks,
  pageRow,
  productEmbedText,
  productRow,
} from './rows.js';

dotenv.config({ path: ['.env.local', '.env'], quiet: true } as dotenv.DotenvConfigOptions);

const DATA_DIR = path.resolve('data');
const BATCH = 500;
const EMBED_BATCH = 100;
const DEACTIVATE_THRESHOLD = 0.9;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const NO_EMBED = args.has('--no-embed');
const EMBED_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

interface ScrapeReport {
  started_at: string;
  finished_at: string;
  total_urls: number;
  fetched: number;
  limit?: number;
  failed: unknown[];
  counts: Record<string, number>;
}

function readJsonl<T>(name: string): T[] {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

function readJson<T>(name: string): T | null {
  const file = path.join(DATA_DIR, name);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null;
}

const chunked = <T>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function dedupe<T>(rows: T[], key: (r: T) => string | number): T[] {
  const m = new Map<string | number, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

// ---------------------------------------------------------------------------
// OpenAI embeddings
// ---------------------------------------------------------------------------

async function embed(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан (или запустите с --no-embed)');
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => t || ' ') }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`OpenAI embeddings HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function selectAll<T>(db: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db.from(table).select(columns).order(table === 'products' ? 'id' : 'url').range(from, from + page - 1);
    if (error) throw new Error(`select ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) return out;
  }
}

/** upsert пачками; при ошибке пачки — построчно, чтобы одна плохая строка не роняла всё. */
async function upsertBatched(
  db: SupabaseClient,
  table: string,
  rows: object[],
  onConflict: string,
  errors: string[],
): Promise<number> {
  let ok = 0;
  for (const batch of chunked(rows, BATCH)) {
    const { error } = await db.from(table).upsert(batch, { onConflict });
    if (!error) {
      ok += batch.length;
      continue;
    }
    console.warn(`[ingest] ${table}: пачка не записана (${error.message}), пробую построчно`);
    for (const row of batch) {
      const r = await db.from(table).upsert(row, { onConflict });
      if (r.error) errors.push(`${table} ${JSON.stringify(row).slice(0, 120)}: ${r.error.message}`);
      else ok++;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------

async function main() {
  const report = readJson<ScrapeReport>('scrape-report.json');
  const products = dedupe(readJsonl<Product>('products.jsonl'), (p) => p.id);
  const categories = dedupe(readJsonl<Category>('categories.jsonl'), (c) => c.url).sort((a, b) => a.depth - b.depth);
  const pages = dedupe(readJsonl<Page>('pages.jsonl'), (p) => p.url);
  const branches = readJson<Branch[]>('branches.json') ?? [];
  if (!report) throw new Error('data/scrape-report.json не найден — сначала запустите npm run scrape');
  if (!products.length && !pages.length) throw new Error('data/ пуст — нечего загружать');

  const scrapedAt = report.finished_at ?? new Date().toISOString();
  const catUrls = new Set(categories.map((c) => c.url));
  const categoryRows = categories.map((c) => categoryRow(c, catUrls));
  const productRows = products.map((p) => productRow(p, scrapedAt, catUrls));
  const pageRows = pages.map((p) => ({ row: pageRow(p, scrapedAt), chunks: pageChunks(p), title: p.title }));
  const ratio = report.total_urls ? report.fetched / report.total_urls : 0;
  const fullRun = !report.limit;
  const canDeactivate = fullRun && ratio >= DEACTIVATE_THRESHOLD;

  const summary = {
    products: productRows.length,
    products_with_price: productRows.filter((r) => r.price_site !== null).length,
    products_without_category: productRows.filter((r) => !r.category_url).length,
    categories: categoryRows.length,
    pages: pageRows.length,
    page_chunks: pageRows.reduce((n, p) => n + p.chunks.length, 0),
    branches: branches.length,
    fetched_ratio: Number(ratio.toFixed(4)),
    full_run: fullRun,
    will_deactivate_missing: canDeactivate,
  };
  console.log('[ingest] данные:', summary);

  if (DRY_RUN) {
    const sample = productRows[0];
    if (sample) console.log('[ingest] пример товара:', { ...sample, search_text: sample.search_text.slice(0, 300) + '…' });
    const kinds = pageRows.reduce<Record<string, number>>((m, p) => ((m[p.row.kind] = (m[p.row.kind] ?? 0) + 1), m), {});
    console.log('[ingest] страницы по типам:', kinds);
    const lens = pageRows.flatMap((p) => p.chunks.map((c) => c.content.length));
    if (lens.length) console.log(`[ingest] чанки: ${lens.length}, длина min/avg/max = ${Math.min(...lens)}/${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}/${Math.max(...lens)}`);
    console.log('[ingest] --dry-run: в БД ничего не записано');
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [!url && 'SUPABASE_URL', !key && 'SUPABASE_SERVICE_ROLE_KEY', !NO_EMBED && !process.env.OPENAI_API_KEY && 'OPENAI_API_KEY'].filter(Boolean);
  if (missing.length) {
    throw new Error(`не заданы переменные окружения: ${missing.join(', ')} (см. .env.example; для загрузки без эмбеддингов — --no-embed)`);
  }
  const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });

  const run = await db.from('scrape_runs').insert({ status: 'running', stats: { scrape: report.counts } }).select('id').single();
  if (run.error) throw new Error(`scrape_runs: ${run.error.message}`);
  const runId = run.data.id as number;
  const errors: string[] = [];
  const stats: Record<string, unknown> = { ...summary, scrape_report: { total_urls: report.total_urls, fetched: report.fetched, failed: report.failed.length } };

  try {
    // 1. Категории (родители раньше детей)
    stats.categories_upserted = await upsertBatched(db, 'categories', categoryRows, 'url', errors);
    console.log(`[ingest] категории: ${stats.categories_upserted}`);

    // 2. Товары
    const existing = await selectAll<{ id: number; content_hash: string; embedded_hash: string | null; is_active: boolean }>(
      db, 'products', 'id, content_hash, embedded_hash, is_active',
    );
    const existingById = new Map(existing.map((e) => [e.id, e]));
    stats.products_new = productRows.filter((r) => !existingById.has(r.id)).length;
    stats.products_changed = productRows.filter((r) => existingById.has(r.id) && existingById.get(r.id)!.content_hash !== r.content_hash).length;
    stats.products_upserted = await upsertBatched(db, 'products', productRows, 'id', errors);
    console.log(`[ingest] товары: ${stats.products_upserted} (новых ${stats.products_new}, изменённых ${stats.products_changed})`);

    // 3. Эмбеддинги товаров — только где embedded_hash ≠ content_hash
    if (!NO_EMBED) {
      const need = productRows.filter((r) => existingById.get(r.id)?.embedded_hash !== r.content_hash);
      let done = 0;
      for (const batch of chunked(need, EMBED_BATCH)) {
        const vectors = await embed(batch.map((r) => productEmbedText(r.search_text)));
        const rows = batch.map((r: ProductRow, i) => ({ ...r, embedding: vectors[i], embedded_hash: r.content_hash }));
        await upsertBatched(db, 'products', rows, 'id', errors);
        done += batch.length;
        if (done % 1000 < EMBED_BATCH || done === need.length) console.log(`[ingest] эмбеддинги товаров: ${done}/${need.length}`);
      }
      stats.products_embedded = done;
    }

    // 4. Деактивация исчезнувших товаров
    if (canDeactivate) {
      const seen = new Set(productRows.map((r) => r.id));
      const gone = existing.filter((e) => e.is_active && !seen.has(e.id)).map((e) => e.id);
      for (const ids of chunked(gone, 200)) {
        const { error } = await db.from('products').update({ is_active: false, updated_at: new Date().toISOString() }).in('id', ids);
        if (error) errors.push(`deactivate: ${error.message}`);
      }
      stats.products_deactivated = gone.length;
      console.log(`[ingest] деактивировано товаров: ${gone.length}`);
    } else {
      console.log(`[ingest] деактивация пропущена (полный обход: ${fullRun}, доля обработанных URL ${ratio.toFixed(3)} < ${DEACTIVATE_THRESHOLD} или лимит)`);
    }

    // 5. Страницы и чанки (чанки пересоздаются только при изменении content_hash страницы)
    const existingPages = await selectAll<{ id: number; url: string; content_hash: string }>(db, 'pages', 'id, url, content_hash');
    const pageByUrl = new Map(existingPages.map((p) => [p.url, p]));
    let pagesChanged = 0;
    for (const p of pageRows) {
      const old = pageByUrl.get(p.row.url);
      const up = await db.from('pages').upsert(p.row, { onConflict: 'url' }).select('id').single();
      if (up.error) {
        errors.push(`pages ${p.row.url}: ${up.error.message}`);
        continue;
      }
      if (old && old.content_hash === p.row.content_hash) continue;
      pagesChanged++;
      const pageId = up.data.id as number;
      const del = await db.from('page_chunks').delete().eq('page_id', pageId);
      if (del.error) errors.push(`page_chunks delete ${p.row.url}: ${del.error.message}`);
      const ins = await db.from('page_chunks').insert(
        p.chunks.map((c) => ({ page_id: pageId, chunk_index: c.chunk_index, heading: c.heading, content: c.content, content_hash: c.content_hash })),
      );
      if (ins.error) errors.push(`page_chunks insert ${p.row.url}: ${ins.error.message}`);
    }
    stats.pages_changed = pagesChanged;
    if (canDeactivate) {
      const seenPages = new Set(pageRows.map((p) => p.row.url));
      const stale = existingPages.filter((p) => !seenPages.has(p.url)).map((p) => p.id);
      for (const ids of chunked(stale, 200)) {
        const { error } = await db.from('pages').delete().in('id', ids);
        if (error) errors.push(`pages delete: ${error.message}`);
      }
      stats.pages_deleted = stale.length;
    }
    console.log(`[ingest] страницы: ${pageRows.length} (изменено ${pagesChanged})`);

    // 6. Эмбеддинги чанков без вектора
    if (!NO_EMBED) {
      const titles = new Map<number, string>();
      const allPages = await selectAll<{ id: number; url: string; title: string }>(db, 'pages', 'id, url, title');
      for (const p of allPages) titles.set(p.id, p.title);
      const pending: { id: number; page_id: number; heading: string | null; content: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from('page_chunks').select('id, page_id, heading, content').is('embedding', null).order('id').range(from, from + 999);
        if (error) throw new Error(`page_chunks select: ${error.message}`);
        pending.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      for (const batch of chunked(pending, EMBED_BATCH)) {
        const vectors = await embed(batch.map((c) => chunkEmbedText(titles.get(c.page_id) ?? '', c.heading, c.content)));
        await Promise.all(
          batch.map(async (c, i) => {
            const { error } = await db.from('page_chunks').update({ embedding: vectors[i] }).eq('id', c.id);
            if (error) errors.push(`page_chunks embed ${c.id}: ${error.message}`);
          }),
        );
      }
      stats.chunks_embedded = pending.length;
      console.log(`[ingest] эмбеддинги чанков: ${pending.length}`);
    }

    // 7. Филиалы
    if (branches.length) stats.branches_upserted = await upsertBatched(db, 'branches', branches.map(branchRow), 'city_slug', errors);

    // 8. Счётчики категорий
    const rpc = await db.rpc('refresh_category_counts');
    if (rpc.error) errors.push(`refresh_category_counts: ${rpc.error.message}`);

    stats.errors = errors.slice(0, 50);
    stats.error_count = errors.length;
    const status = canDeactivate && errors.length === 0 ? 'ok' : 'partial';
    await db.from('scrape_runs').update({ status, finished_at: new Date().toISOString(), stats }).eq('id', runId);
    console.log(`[ingest] готово: статус ${status}, ошибок ${errors.length}`);
    if (errors.length) console.log(errors.slice(0, 10).join('\n'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from('scrape_runs').update({ status: 'failed', finished_at: new Date().toISOString(), stats, error: msg }).eq('id', runId);
    throw e;
  }
}

main().catch((e) => {
  console.error('[ingest] ошибка:', e instanceof Error ? e.message : e);
  process.exit(1);
});
