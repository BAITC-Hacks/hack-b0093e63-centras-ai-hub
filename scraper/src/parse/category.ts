import { type CheerioAPI, catalogCrumbs, cleanText, parseBreadcrumbs, urlPath } from './common.js';

export interface Category {
  url: string;
  name: string;
  parent_url: string | null;
  path: string[];
  depth: number;
  /** true — данные со страницы категории; false — восстановлено из хлебных крошек товара */
  fetched: boolean;
  /** Предки из хлебных крошек (от корня), чтобы в дереве были все родители */
  ancestors?: { url: string; name: string }[];
}

export function parseCategory($: CheerioAPI, url: string): Category | null {
  const name = cleanText($('h1').first().text());
  if (!name) return null;
  const crumbs = catalogCrumbs(parseBreadcrumbs($));
  // крошки до самой категории (последняя крошка — она же, без ссылки или со ссылкой на себя)
  const ancestors = crumbs.filter((c) => c.url !== null && urlPath(c.url) !== urlPath(url));
  const path = [...ancestors.map((c) => c.name), name];
  const parent = ancestors[ancestors.length - 1];
  return {
    url,
    name,
    parent_url: parent ? parent.url : null,
    path,
    depth: path.length - 1,
    fetched: true,
    ancestors: ancestors.map((c) => ({ url: c.url as string, name: c.name })),
  };
}

/**
 * Сливает категории со страниц и из крошек (товаров и самих категорий) по url;
 * данные со страницы категории приоритетнее восстановленных из крошек.
 */
export function mergeCategories(
  fetched: Category[],
  chains: { url: string; name: string }[][],
): Category[] {
  const byUrl = new Map<string, Category>();
  const allChains = [...chains, ...fetched.map((c) => c.ancestors ?? [])];
  for (const chain of allChains) {
    for (const c of categoriesFromCrumbs(chain)) if (!byUrl.has(c.url)) byUrl.set(c.url, c);
  }
  for (const c of fetched) byUrl.set(c.url, c);
  return [...byUrl.values()]
    .map(({ ancestors: _a, ...c }) => c)
    .sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
}

/** Категории из цепочки крошек товара: [{url,name}, ...] от корня. */
export function categoriesFromCrumbs(chain: { url: string; name: string }[]): Category[] {
  return chain.map((c, i) => ({
    url: c.url,
    name: c.name,
    parent_url: i > 0 ? chain[i - 1].url : null,
    path: chain.slice(0, i + 1).map((x) => x.name),
    depth: i,
    fetched: false,
  }));
}
