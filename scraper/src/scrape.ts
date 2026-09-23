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

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`[scrape] UA="${USER_AGENT}" concurrency=${concurrency} delay=${delayMs}ms limit=${limit || 'нет'} resume=${resume}`);

  const robots = await fetchRobots(ORIGIN, fetchText, USER_AGENT);
  const sitemapUrls = await loadSitemapUrls(SITEMAP_URL);
  const { urls: allUrls, blocked } = buildUrlList(sitemapUrls, robots, skipService);
  const urls = applyLimit(allUrls, limit);
  console.log(
    `[scrape] sitemap: ${sitemapUrls.length} URL, к обходу: ${allUrls.length}, закрыто robots.txt: ${blocked.length}` +
      (limit > 0 ? `, с учётом SCRAPER_LIMIT: ${urls.length}` : ''),
  );

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
  const products = dedupeBy(readJsonl<Product>(F.products), (p) => String(p.id));
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
