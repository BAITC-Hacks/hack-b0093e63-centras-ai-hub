// Проверка: зависят ли цены от города.
// Город на ekt.kz выбирается компонентом sotbit:regions.choose (singleDomain = 'N'):
// каждый регион — свой поддомен (Астана → nursultan.ekt.kz) + cookie sotbit_regions_id.
// Запуск: npx tsx scraper/src/check-city-prices.ts [--all] [url ...]
import fs from 'node:fs';
import { fetchText, sleep } from './http.js';
import { load } from './parse/common.js';
import { parseProduct } from './parse/product.js';
import { parseRobots } from './robots.js';

const REGIONS = [
  { slug: 'almaty', name: 'Алматы', host: 'ekt.kz', id: 53 },
  { slug: 'astana', name: 'Астана', host: 'nursultan.ekt.kz', id: 54 },
  { slug: 'shymkent', name: 'Шымкент', host: 'shymkent.ekt.kz', id: 55 },
  { slug: 'taraz', name: 'Тараз', host: 'taraz.ekt.kz', id: 56 },
  { slug: 'atyrau', name: 'Атырау', host: 'atyrau.ekt.kz', id: 57 },
  { slug: 'aktau', name: 'Актау', host: 'aktau.ekt.kz', id: 58 },
  { slug: 'karaganda', name: 'Караганда', host: 'karaganda.ekt.kz', id: 59 },
  { slug: 'taldykorgan', name: 'Талдыкорган', host: 'taldykorgan.ekt.kz', id: 60 },
  { slug: 'ust-kamenogorsk', name: 'Усть-Каменогорск', host: 'ust-kamenogorsk.ekt.kz', id: 61 },
];

const DEFAULT_URLS = [
  'https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/led_lampa_a60_standart_10w_900lm_230v_4000k_e27_megalight_100/',
];

function productUrls(): string[] {
  const fromArgs = process.argv.slice(2).filter((a) => a.startsWith('http'));
  if (fromArgs.length) return fromArgs;
  const file = 'data/products.jsonl';
  if (fs.existsSync(file)) {
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { url: string; price_site: number | null });
    const priced = rows.filter((r) => r.price_site !== null).map((r) => r.url);
    if (priced.length) return priced.slice(0, 5);
  }
  return DEFAULT_URLS;
}

async function main() {
  const all = process.argv.includes('--all');
  const regions = all ? REGIONS : REGIONS.filter((r) => r.slug === 'almaty' || r.slug === 'astana');
  const urls = productUrls();

  for (const r of regions.slice(1)) {
    const robots = await fetchText(`https://${r.host}/robots.txt`);
    const ok = parseRobots(robots.body).isAllowed(`https://${r.host}/catalog/x/`);
    if (!ok) console.warn(`robots.txt ${r.host} запрещает /catalog/ — пропуск`);
  }

  let diffs = 0;
  let compared = 0;
  for (const url of urls) {
    const path = new URL(url).pathname;
    const row: string[] = [];
    let base: number | null | undefined;
    for (const r of regions) {
      const res = await fetchText(`https://${r.host}${path}`, {
        headers: { Cookie: `sotbit_regions_id=${r.id}; sotbit_regions_city_choosed=Y` },
      });
      const $ = load(res.body);
      const p = res.status === 200 ? parseProduct($, url) : null;
      const cityShown = $('.select-city__block__text-city').first().text().trim();
      const price = p ? `${p.price_site ?? '—'}/${p.price_store ?? '—'}` : `HTTP ${res.status}`;
      row.push(`${r.name}[${cityShown || '?'}]: ${price}`);
      if (p) {
        if (base === undefined) base = p.price_site;
        else {
          compared++;
          if (p.price_site !== base) diffs++;
        }
      }
      await sleep(400);
    }
    console.log(`${path}\n  ${row.join(' | ')}`);
  }
  console.log(`\nСравнений: ${compared}, расхождений цены «на сайте»: ${diffs}`);
  console.log(diffs === 0 ? 'Вывод: цены не зависят от города (по выборке).' : 'Вывод: цены РАЗЛИЧАЮТСЯ по городам.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
