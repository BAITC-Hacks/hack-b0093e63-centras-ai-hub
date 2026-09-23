import type { AnyNode, Element } from 'domhandler';
import { type CheerioAPI, cleanText, nodeToRawText, nodeToText, normalizeMultiline, textOf, urlPath } from './common.js';

export type PageKind =
  | 'faq' | 'howto' | 'payment' | 'return' | 'contacts' | 'about'
  | 'production' | 'article' | 'tech' | 'news' | 'other';

export interface Section {
  heading: string | null;
  content: string;
}

export interface Page {
  url: string;
  kind: PageKind;
  title: string;
  content: string;
  sections: Section[];
}

export function pageKind(url: string): PageKind {
  const p = urlPath(url);
  if (p.startsWith('/about/faq/')) return 'faq';
  if (p.startsWith('/about/howto/')) return 'howto';
  if (p.startsWith('/payments/')) return 'payment';
  if (p.startsWith('/return/')) return 'return';
  if (p.startsWith('/about/contacts/')) return 'contacts';
  if (p.startsWith('/about/production/')) return 'production';
  if (p.startsWith('/about/information/articles/')) return 'article';
  if (p.startsWith('/about/information/technical-information/')) return 'tech';
  if (p.startsWith('/news/')) return 'news';
  if (p.startsWith('/about/')) return 'about';
  return 'other';
}

// Шапка, подвал, меню, модальные окна, формы, баннеры, выбор города, подписка
const BOILERPLATE = [
  'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'link', 'meta',
  'header', 'footer', 'nav', 'form', 'button', 'input', 'select', 'textarea',
  '.breadcrumbs', '.popup', '.modal', '.offcanvas', '.left-sidebar',
  '[class*="select-city"]', '[class*="subscribe"]', '[id*="subscribe"]',
  '.contact-city-nav', '.contacts-map', '.map-left', '.cont_social', '.sales-button',
  '.pagination', '.bx-pagination', '.share', '.ya-share2', '.social',
].join(',');

const PREFERRED = ['.container.project-grid', '.checkout-and-delivery', '.how-to-make-order', '.white-bg'];

function stripBoilerplate($: CheerioAPI): void {
  $(BOILERPLATE).remove();
  $('*')
    .filter((_, el) => {
      const cls = ($(el).attr('class') ?? '') + ' ' + ($(el).attr('id') ?? '');
      return /(^|\s|_|-)(popup|modal|offcanvas|cookie|subscribe|rassylk)/i.test(cls);
    })
    .remove();
}

/** Основной контейнер контента: предпочитаемые блоки, иначе самый «текстовый» блок body. */
function mainContent($: CheerioAPI): Element[] {
  for (const sel of PREFERRED) {
    const found = $(sel)
      .toArray()
      .filter((el) => cleanText($(el).text()).length > 0)
      // только верхнеуровневые совпадения
      .filter((el) => !$(el).parents(PREFERRED.join(',')).length);
    if (found.length) return found as Element[];
  }
  let best: Element | null = null;
  let bestLen = 0;
  $('body')
    .children()
    .each((_, el) => {
      const $el = $(el);
      const clone = $el.clone();
      clone.find('h1').remove();
      const len = cleanText(clone.text()).length;
      if (len > bestLen) {
        best = el as Element;
        bestLen = len;
      }
    });
  return best ? [best] : [];
}

const HEADING_TAGS = new Set(['h2', 'h3', 'h4', 'h5', 'h6']);
const INLINE_BOLD = new Set(['b', 'strong']);

/** Абзац из одного жирного фрагмента («<p><b>Конструкция</b></p>») считается подзаголовком. */
function isBoldHeading($: CheerioAPI, el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (!['p', 'div'].includes(tag)) return false;
  const text = cleanText($(el).text());
  if (!text || text.length > 120) return false;
  if ($(el).find('p,div,ul,ol,table,li').length) return false;
  const bold = cleanText($(el).find('b,strong').text());
  return bold === text;
}

function isHeading($: CheerioAPI, el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (HEADING_TAGS.has(tag)) return cleanText($(el).text()).length > 0;
  return isBoldHeading($, el);
}

function containsHeading($: CheerioAPI, el: Element): boolean {
  return $(el)
    .find('h2,h3,h4,h5,h6,p,div')
    .toArray()
    .some((d) => isHeading($, d as Element));
}

type Block = { h: string } | { t: string };

function collectBlocks($: CheerioAPI, root: Element, out: Block[]): void {
  let inline: AnyNode[] = [];
  const flushInline = () => {
    if (!inline.length) return;
    const t = inline.map((n) => nodeToRawText(n)).join('');
    const norm = normalizeMultiline(t);
    if (norm) out.push({ t: norm });
    inline = [];
  };
  for (const child of root.children) {
    if (child.type !== 'tag') {
      if (child.type === 'text') inline.push(child);
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (INLINE_BOLD.has(tag) || tag === 'br' || tag === 'a' || tag === 'span' || tag === 'i' || tag === 'em') {
      inline.push(el);
      continue;
    }
    flushInline();
    if (tag === 'h1') continue;
    if (isHeading($, el)) {
      out.push({ h: cleanText($(el).text()).replace(/:$/, '') });
    } else if (containsHeading($, el)) {
      collectBlocks($, el, out);
    } else {
      const t = nodeToText(el);
      if (t) out.push({ t });
    }
  }
  flushInline();
}

function blocksToSections(input: Block[]): Section[] {
  // «1» / «2.» перед заголовком (нумерованные шаги) — переносим в заголовок
  const blocks: Block[] = [];
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    const next = input[i + 1];
    if ('t' in b && /^\d{1,2}\.?$/.test(b.t) && next && 'h' in next) {
      blocks.push({ h: `${b.t.replace(/\.$/, '')}. ${next.h}` });
      i++;
      continue;
    }
    blocks.push(b);
  }
  const sections: Section[] = [];
  let cur: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  const push = () => {
    const content = normalizeMultiline(cur.lines.join('\n'));
    if (content) sections.push({ heading: cur.heading, content });
    else if (cur.heading) pendingHeading = cur.heading;
  };
  let pendingHeading: string | null = null;
  for (const b of blocks) {
    if ('h' in b) {
      push();
      // заголовок без текста (h5 сразу за h4) склеиваем со следующим
      const h = pendingHeading ? `${pendingHeading}. ${b.h}` : b.h;
      pendingHeading = null;
      cur = { heading: h, lines: [] };
    } else {
      cur.lines.push(b.t);
    }
  }
  push();
  return sections;
}

function parseFaq($: CheerioAPI): Section[] {
  const sections: Section[] = [];
  $('ul.accordion-menu > li').each((_, li) => {
    const $li = $(li);
    const q = cleanText($li.find('.dropdownlink').first().text());
    const answerEl = $li.find('.submenuItems').first();
    let a = answerEl.length ? textOf(answerEl) : '';
    if (!a) {
      const clone = $li.clone();
      clone.find('.dropdownlink').remove();
      a = textOf(clone);
    }
    if (q && a) sections.push({ heading: q, content: a });
  });
  return sections;
}

export function sectionsToContent(sections: Section[]): string {
  return sections.map((s) => (s.heading ? `${s.heading}\n${s.content}` : s.content)).join('\n\n');
}

export function parsePage($: CheerioAPI, url: string): Page | null {
  const kind = pageKind(url);
  const title =
    cleanText($('h1').first().text()) ||
    cleanText($('meta[property="og:title"]').attr('content')) ||
    cleanText($('title').text());

  let sections = kind === 'faq' ? parseFaq($) : [];
  if (!sections.length) {
    stripBoilerplate($);
    const blocks: Block[] = [];
    for (const el of mainContent($)) collectBlocks($, el, blocks);
    sections = blocksToSections(blocks);
  }
  const content = sectionsToContent(sections);
  if (!title || !content) return null;
  return { url, kind, title, content, sections };
}
