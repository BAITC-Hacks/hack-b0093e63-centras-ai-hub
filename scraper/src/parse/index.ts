import { type Branch, parseBranches } from './branches.js';
import { type Category, parseCategory } from './category.js';
import { load, urlPath } from './common.js';
import { type Page, type Section, parsePage, sectionsToContent } from './page.js';
import { type Product, isProductPage, parseProduct } from './product.js';

export type { Branch, Category, Page, Product, Section };
export { pageKind } from './page.js';
export { categoriesFromCrumbs } from './category.js';

export type ParseResult =
  | { type: 'product'; data: Product }
  | { type: 'category'; data: Category }
  | { type: 'page'; data: Page; branches?: Branch[] }
  | { type: 'skip'; data: { reason: string } };

const skip = (reason: string): ParseResult => ({ type: 'skip', data: { reason } });

export function branchSection(b: Branch): Section {
  const lines = [
    b.address && `Адрес: ${b.address}`,
    b.phones.length && `Телефоны: ${b.phones.join(', ')}`,
    b.emails.length && `E-mail: ${b.emails.join(', ')}`,
    b.hours && `График работы: ${b.hours}`,
  ].filter(Boolean);
  return { heading: `Филиал ЭлектроКомплект в г. ${b.city}`, content: lines.join('\n') };
}

/** Определяет тип страницы по URL и разметке и разбирает её. */
export function classifyAndParse(url: string, html: string): ParseResult {
  const path = urlPath(url);
  const $ = load(html);

  if (path.startsWith('/catalog/')) {
    if (path === '/catalog/') return skip('catalog root');
    if (isProductPage($)) {
      const p = parseProduct($, url);
      return p ? { type: 'product', data: p } : skip('product without id/name');
    }
    const c = parseCategory($, url);
    return c ? { type: 'category', data: c } : skip('catalog page without h1');
  }

  if (path === '/' || path === '') return skip('home page');

  if (path.startsWith('/about/contacts/')) {
    const branches = parseBranches(load(html));
    const page = parsePage($, url);
    if (!page) return skip('empty contacts page');
    if (branches.length) {
      // структурированный текст по филиалам вместо «сырой» вёрстки вкладок
      page.sections = branches.map(branchSection);
      page.content = sectionsToContent(page.sections);
    }
    return { type: 'page', data: page, branches };
  }

  const page = parsePage($, url);
  return page ? { type: 'page', data: page } : skip('empty page');
}
