// Обход ekt.kz: sitemap → фильтр robots.txt (+ список служебных страниц) → парсинг → data/*.jsonl
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { USER_AGENT, envInt, fetchText, runPool } from './http.js';
import { type Branch, type Category, type Product, classifyAndParse } from './parse/index.js';
import { mergeCategories } from './parse/category.js';
import { canonicalUrl } from './parse/common.js';
import { type Robots, fetchRobots } from './robots.js';

dotenv.config({ path: ['.env.local', '.env'], quiet: true } as dotenv.DotenvConfigOptions);

const ORIGIN = 'https://ekt.kz';
const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;

/** Служебные страницы, закрытые robots.txt, но нужные консультанту (см. дизайн-док). */
export const SERVICE_PAGES = [
  `${ORIGIN}/about/faq/`,
  `${ORIGIN}/about/howto/`,
  `${ORIGIN}/payments/`,
  `${ORIGIN}/return/`,
];

const DATA_DIR = path.resolve('data');
const F = {
  products: path.join(DATA_DIR, 'products.jsonl'),
  categories: path.join(DATA_DIR, 'categories.jsonl'),
  pages: path.join(DATA_DIR, 'pages.jsonl'),
  branches: path.join(DATA_DIR, 'branches.json'),
  report: path.join(DATA_DIR, 'scrape-report.json'),
  progress: path.join(DATA_DIR, 'progress.json'),
};

type Failure = { url: string; status: number; error?: string };

interface Progress {
  started_at: string;
  done: string[];
  failed: Failure[];
  counts: Record<string, number>;
  skipped: Record<string, number>;
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return []; // оборванная последняя строка после падения
      }
    });
}

async function loadSitemapUrls(url: string, depth = 0): Promise<string[]> {
  const res = await fetchText(url);
  if (res.status !== 200) throw new Error(`sitemap ${url}: HTTP ${res.status} ${res.error ?? ''}`);
  const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) =>
    m[1].replace(/&amp;/g, '&'),
  );
  if (/<sitemapindex/i.test(res.body) && depth < 2) {
    const nested = await Promise.all(locs.map((l) => loadSitemapUrls(l, depth + 1)));
    return nested.flat();
  }
  return locs;
}

function buildUrlList(sitemapUrls: string[], robots: Robots, skipService: boolean) {
  const service = skipService ? [] : SERVICE_PAGES;
  const seen = new Set<string>();
  const urls: string[] = [];
  const blocked: string[] = [];
  for (const raw of [...sitemapUrls, ...service]) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.search) continue; // никаких query-строк
    if (u.hostname !== 'ekt.kz' && u.hostname !== 'www.ekt.kz') continue;
    const url = canonicalUrl(u.toString()).replace('://www.', '://');
    if (seen.has(url)) continue;
    seen.add(url);
    if (!service.includes(url) && !robots.isAllowed(url)) {
      blocked.push(url);
      continue;
    }
    urls.push(url);
  }
  return { urls, blocked };
}

/**
 * SCRAPER_LIMIT: все некаталожные URL + N каталожных. В sitemap сначала идут категории,
 * поэтому каталожные URL берём равномерно по всему списку (иначе в выборку не попадут товары).
 */
export function applyLimit(urls: string[], limit: number): string[] {
  if (limit <= 0) return urls;
  const isCatalog = (u: string) => new URL(u).pathname.startsWith('/catalog/');
  const catalog = urls.filter(isCatalog);
  const step = Math.max(1, catalog.length / limit);
  const sample: string[] = [];
  for (let i = 0; i < catalog.length && sample.length < limit; i += step) sample.push(catalog[Math.floor(i)]);
  return [...urls.filter((u) => !isCatalog(u)), ...sample];
}

const isCatalogUrl = (u: string) => new URL(u).pathname.startsWith('/catalog/');

/** Порядок «вразброс»: 0, n/2, n/4, 3n/4… — чтобы первые N каталожных URL покрывали все подкатегории. */
export function spreadOrder<T>(items: T[]): T[] {
  const out: T[] = [];
  const taken = new Set<number>();
  for (let step = items.length; step >= 1 && out.length < items.length; step = Math.floor(step / 2)) {
    for (let i = 0; i < items.length; i += step) {
      if (!taken.has(i)) {
        taken.add(i);
        out.push(items[i]);
      }
    }
    if (step === 1) break;
  }
  return out;
}

/**
 * Режим «одна категория, N товаров» (SCRAPER_CATEGORY + SCRAPER_MAX_PRODUCTS):
 * все некаталожные страницы + каталожные URL внутри категории. Уже отслеживаемые товары идут
 * первыми — ежедневный прогон перепроверяет цены тех же товаров, остальные добирают до лимита.
 */
export function selectCategoryUrls(urls: string[], categoryPath: string, tracked: Set<string>): string[] {
  // Git Bash под Windows превращает "/catalog/..." в "C:/Program Files/Git/catalog/..." — берём путь с /catalog/
  let p = categoryPath.trim();
  try {
    p = new URL(p).pathname;
  } catch {
    /* не URL — путь */
  }
  const i = p.indexOf('/catalog/');
  if (i > 0) p = p.slice(i);
  const prefix = p.endsWith('/') ? p : `${p}/`;
  const inCategory = urls.filter((u) => isCatalogUrl(u) && new URL(u).pathname.startsWith(prefix));
  const trackedFirst = inCategory.filter((u) => tracked.has(u));
  const rest = spreadOrder(inCategory.filter((u) => !tracked.has(u)));
  return [...urls.filter((u) => !isCatalogUrl(u)), ...trackedFirst, ...rest];
}

/** URL товаров, цены которых уже отслеживаются: из базы (если есть ключи) или из seed/products.jsonl. */
async function loadTrackedUrls(): Promise<Set<string>> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      const res = await fetch(`${url}/rest/v1/products?select=url&is_active=eq.true&limit=5000`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ekt' },
      });
      if (res.ok) {
        const rows = (await res.json()) as { url: string }[];
        if (rows.length) return new Set(rows.map((r) => r.url));
      }
    } catch {
      /* нет сети до БД — берём seed */
    }
  }
  return new Set(readJsonl<{ url: string }>(path.resolve('seed', 'products.jsonl')).map((p) => p.url));
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}ч${m}м` : m ? `${m}м${s}с` : `${s}с`;
}

async function main() {
  const resume = process.argv.includes('--resume');
  const concurrency = envInt('SCRAPER_CONCURRENCY', 3);
  const delayMs = envInt('SCRAPER_DELAY_MS', 300);
  const limit = envInt('SCRAPER_LIMIT', 0);
  const skipService = process.env.SCRAPER_SKIP_SERVICE_PAGES === '1';
  const category = (process.env.SCRAPER_CATEGORY ?? '').trim();
  const maxProducts = envInt('SCRAPER_MAX_PRODUCTS', 0);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(
    `[scrape] UA="${USER_AGENT}" concurrency=${concurrency} delay=${delayMs}ms limit=${limit || 'нет'} ` +
      `category=${category || 'все'} max_products=${maxProducts || 'нет'} resume=${resume}`,
  );

  const robots = await fetchRobots(ORIGIN, fetchText, USER_AGENT);
  const sitemapUrls = await loadSitemapUrls(SITEMAP_URL);
  const { urls: allUrls, blocked } = buildUrlList(sitemapUrls, robots, skipService);
  const tracked = category ? await loadTrackedUrls() : new Set<string>();
  const urls = category ? selectCategoryUrls(allUrls, category, tracked) : applyLimit(allUrls, limit);
  console.log(
    `[scrape] sitemap: ${sitemapUrls.length} URL, к обходу: ${allUrls.length}, закрыто robots.txt: ${blocked.length}` +
      (category ? `, в категории + страницы: ${urls.length}, отслеживаемых товаров: ${tracked.size}` : '') +
      (!category && limit > 0 ? `, с учётом SCRAPER_LIMIT: ${urls.length}` : ''),
  );
  const productLimitReached = (url: string) =>
    maxProducts > 0 && isCatalogUrl(url) && !tracked.has(url) && (progress.counts.product ?? 0) >= maxProducts;

  let progress: Progress = {
    started_at: new Date().toISOString(),
    done: [],
    failed: [],
    counts: { product: 0, category: 0, page: 0, skip: 0 },
    skipped: {},
  };
  if (resume && fs.existsSync(F.progress)) {
    progress = JSON.parse(fs.readFileSync(F.progress, 'utf8')) as Progress;
    // неудачные URL пробуем снова
    const prevFailed = new Set(progress.failed.map((f) => f.url));
    progress.done = progress.done.filter((u) => !prevFailed.has(u));
    progress.failed = [];
    console.log(`[scrape] продолжение: уже обработано ${progress.done.length} URL`);
  } else {
    for (const f of [F.products, F.categories, F.pages]) fs.writeFileSync(f, '');
    if (fs.existsSync(F.branches)) fs.rmSync(F.branches);
  }
  const done = new Set(progress.done);
  const todo = urls.filter((u) => !done.has(u));

  const out = {
    products: fs.createWriteStream(F.products, { flags: 'a' }),
    categories: fs.createWriteStream(F.categories, { flags: 'a' }),
    pages: fs.createWriteStream(F.pages, { flags: 'a' }),
  };
  const saveProgress = () => {
    progress.done = [...done];
    fs.writeFileSync(F.progress, JSON.stringify(progress));
  };

  let processed = 0;
  const tStart = Date.now();
  await runPool(
    todo,
    async (url) => {
      if (productLimitReached(url)) {
        progress.skipped.max_products = (progress.skipped.max_products ?? 0) + 1;
        done.add(url);
        processed++;
        return;
      }
      const res = await fetchText(url);
      if (res.status !== 200 || !res.body) {
        progress.failed.push({ url, status: res.status, ...(res.error ? { error: res.error } : {}) });
      } else {
        try {
          // после редиректа берём итоговый URL, если он на ekt.kz и без query
          const finalUrl = (() => {
            try {
              const f = new URL(res.url);
              return f.hostname === 'ekt.kz' && !f.search ? canonicalUrl(res.url) : url;
            } catch {
              return url;
            }
          })();
          const r = classifyAndParse(finalUrl, res.body);
          progress.counts[r.type] = (progress.counts[r.type] ?? 0) + 1;
          if (r.type === 'product') out.products.write(`${JSON.stringify(r.data)}\n`);
          else if (r.type === 'category') out.categories.write(`${JSON.stringify(r.data)}\n`);
          else if (r.type === 'page') {
            out.pages.write(`${JSON.stringify(r.data)}\n`);
            if (r.branches?.length) fs.writeFileSync(F.branches, JSON.stringify(r.branches, null, 2));
          } else progress.skipped[r.data.reason] = (progress.skipped[r.data.reason] ?? 0) + 1;
        } catch (e) {
          progress.failed.push({ url, status: res.status, error: `parse: ${e instanceof Error ? e.message : e}` });
        }
      }
      done.add(url);
      processed++;
      if (processed % 25 === 0) saveProgress();
      if (processed % 200 === 0 || processed === todo.length) {
        const elapsed = (Date.now() - tStart) / 1000;
        const rate = processed / elapsed;
        const eta = (todo.length - processed) / rate;
        console.log(
          `[scrape] ${processed}/${todo.length} (${rate.toFixed(2)} URL/с, ETA ${fmtDuration(eta)}) ` +
            `товары=${progress.counts.product} категории=${progress.counts.category} страницы=${progress.counts.page} ошибки=${progress.failed.length}`,
        );
      }
    },
    { concurrency, delayMs },
  );
  await Promise.all(Object.values(out).map((s) => new Promise((r) => s.end(r))));
  saveProgress();

  // Дедупликация и дерево категорий (страницы категорий + крошки товаров)
  let products = dedupeBy(readJsonl<Product>(F.products), (p) => String(p.id));
  if (maxProducts > 0 && products.length > maxProducts) {
    // параллельные потоки могли добрать чуть больше лимита; отслеживаемые — в приоритете
    products = [...products.filter((p) => tracked.has(p.url)), ...products.filter((p) => !tracked.has(p.url))].slice(0, maxProducts);
  }
  writeJsonl(F.products, products);
  writeJsonl(F.pages, dedupeBy(readJsonl<{ url: string }>(F.pages), (p) => p.url));
  const fetchedCats = dedupeBy(readJsonl<Category>(F.categories).filter((c) => c.fetched), (c) => c.url);
  const categories = mergeCategories(fetchedCats, products.map((p) => p.breadcrumb_categories));
  writeJsonl(F.categories, categories);

  const branches: Branch[] = fs.existsSync(F.branches) ? JSON.parse(fs.readFileSync(F.branches, 'utf8')) : [];
  const finished = new Date();
  const failedSet = new Set(progress.failed.map((f) => f.url));
  const fetched = urls.filter((u) => done.has(u) && !failedSet.has(u)).length;
  const report = {
    started_at: progress.started_at,
    finished_at: finished.toISOString(),
    duration_s: Math.round((Date.now() - t0) / 1000),
    limit,
    sitemap_urls: sitemapUrls.length,
    robots_blocked: blocked.length,
    service_pages: skipService ? [] : SERVICE_PAGES,
    total_urls: urls.length,
    fetched,
    failed: progress.failed,
    counts: {
      ...progress.counts,
      products_unique: products.length,
      categories_fetched: fetchedCats.length,
      categories_total: categories.length,
      branches: branches.length,
    },
    skipped: progress.skipped,
  };
  fs.writeFileSync(F.report, JSON.stringify(report, null, 2));
  console.log(
    `[scrape] готово за ${fmtDuration(report.duration_s)}: обработано ${fetched}/${urls.length}, ошибок ${progress.failed.length}; ` +
      `товаров ${products.length}, категорий ${categories.length} (со страниц ${fetchedCats.length}), филиалов ${branches.length}`,
  );
  if (!branches.length) console.warn('[scrape] ВНИМАНИЕ: филиалы не собраны (страница контактов не обработана?)');
}

function dedupeBy<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r); // побеждает последняя запись
  return [...m.values()];
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

main().catch((e) => {
  console.error('[scrape] ошибка:', e);
  process.exit(1);
});
