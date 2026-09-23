import { type CheerioAPI, cleanText } from './common.js';

export interface Branch {
  city_slug: string;
  city: string;
  address: string | null;
  phones: string[];
  emails: string[];
  hours: string | null;
  sort: number;
}

// id вкладки на странице контактов → slug; порядок = sort
const TAB_SLUGS: Record<string, string> = {
  almaty: 'almaty',
  'nur-sultan': 'astana',
  astana: 'astana',
  shymkent: 'shymkent',
  aktau: 'aktau',
  atyrau: 'atyrau',
  taraz: 'taraz',
  'ust-kamenogorsk': 'ust-kamenogorsk',
  karaganda: 'karaganda',
  taldykorgan: 'taldykorgan',
};

function itemsText($: CheerioAPI, $block: ReturnType<CheerioAPI>): string[] {
  const lis = $block.find('li').toArray().map((li) => cleanText($(li).text())).filter(Boolean);
  if (lis.length) return lis;
  const clone = $block.clone();
  clone.find('.contact-items-title').remove();
  const t = cleanText(clone.text());
  return t ? [t] : [];
}

export function parseBranches($: CheerioAPI): Branch[] {
  const branches: Branch[] = [];
  const panes = $('.contact-tab-content .tab-pane').length ? $('.contact-tab-content .tab-pane') : $('.tab-pane');
  panes.each((i, pane) => {
    const $pane = $(pane);
    const heading = cleanText($pane.find('h1,h2,h3,h4,h5').first().text());
    const cityMatch = heading.match(/г\.\s*(.+)$/);
    const tabId = ($pane.attr('id') ?? '').toLowerCase();
    const city = cityMatch ? cityMatch[1].trim() : cleanText($(`#${tabId}-tab`).first().text());
    if (!city) return;
    const slug = TAB_SLUGS[tabId] ?? tabId;

    const fields: Record<string, string[]> = {};
    $pane.find('.contact-items').each((_, item) => {
      const title = cleanText($(item).find('.contact-items-title').first().text()).toLowerCase();
      fields[title] = itemsText($, $(item).find('.contact-items-inner').first());
    });
    const pick = (re: RegExp) => Object.entries(fields).find(([k]) => re.test(k))?.[1] ?? [];

    const phones = $pane
      .find('a[href^="tel:"]')
      .toArray()
      .map((a) => cleanText($(a).text()))
      .filter(Boolean);
    const emails = $pane
      .find('a[href^="mailto:"]')
      .toArray()
      .map((a) => ($(a).attr('href') ?? '').replace(/^mailto:/i, '').trim())
      .filter(Boolean);
    const address = pick(/заходите|адрес/).join('; ');
    const hours = pick(/график|режим/).join('; ');

    branches.push({
      city_slug: slug,
      city,
      address: address || null,
      phones: [...new Set(phones.length ? phones : pick(/звоните|телефон/))],
      emails: [...new Set(emails.length ? emails : pick(/пишите|почт|e-?mail/))],
      hours: hours || null,
      sort: (i + 1) * 10,
    });
  });
  return branches;
}
