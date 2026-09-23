// @vitest-environment happy-dom
/**
 * UI actions on the real ekt.kz markup (scraper/test/fixtures/product.html — a saved product page):
 * target lookup, highlight overlay, navigate with «Отмена», deferred queue, click / fill of the
 * site's own controls and Bootstrap modals («Оставить заявку», «Купить в 1 клик», search).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIGHLIGHT_MS,
  NAV_MS,
  PLATE_MS,
  clearHighlights,
  fillForm,
  findTarget,
  highlightElement,
  pageKey,
  parseAction,
  resumePending,
  cancelActions,
  runActions,
  safeNavUrl,
  setFieldValue,
  type UIAction,
} from '../src/actions';
import { PENDING_KEY, PENDING_TTL_MS, savePending, takePending } from '../src/storage';

const FIXTURE = readFileSync(resolve(process.cwd(), 'scraper/test/fixtures/product.html'), 'utf8');
// Fragments of the saved page (cheerio extracts them verbatim; happy-dom trips over the full
// Bitrix header). No scripts/iframes: happy-dom must not fetch anything from the network.
const $ = load(FIXTURE);
$('script, noscript, iframe, style, link').remove();
const BODY = [
  '<header class="nav-down">',
  $.html($('.phones_head').first()),
  $.html($('a.root-item[data-bs-target="#zayavka"]').first()),
  $.html($('#search')),
  $.html($('.bx-basket').first()),
  '</header>',
  $.html($('h1').first()),
  $.html($('.product_detail_row')),
  $.html($('.detail_tabs')),
  $.html($('#zayavka')),
  $.html($('#buyoneclick')),
  $.html($('#delivery')),
].join('\n');
const PRODUCT_URL = 'https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/led_lampa_a60_standart_10w_900lm_230v_4000k_e27_megalight_100/';

const t = { cancel: 'Отмена', going: 'Перехожу', openEkt: 'Открыть на ekt.kz', close: 'Закрыть' };
const w = window as any;
const layer = () => document.querySelector('[data-ekt-overlay]')?.shadowRoot ?? null;
const rings = () => Array.from(layer()?.querySelectorAll('.ring') ?? []).filter((r) => !r.classList.contains('out'));
const plateEl = () => layer()?.querySelector('.plate') as HTMLElement | null;
const setUrl = (u: string) => w.happyDOM.setURL(u);

function setReducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes('reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} })) as any;
}
function loadProductPage() {
  document.body.innerHTML = BODY;
}

beforeEach(() => {
  setUrl(PRODUCT_URL);
  document.body.innerHTML = '';
  sessionStorage.clear();
  delete w.jQuery;
  delete w.bootstrap;
  setReducedMotion(false);
});
afterEach(() => {
  clearHighlights();
  vi.useRealTimers();
});

/* ── parsing ─────────────────────────────────────────────── */

describe('parseAction', () => {
  it('accepts the real-site contract', () => {
    expect(parseAction({ type: 'navigate', url: 'https://ekt.kz/return/', label: 'Открываю возврат' })).toEqual({
      type: 'navigate',
      url: 'https://ekt.kz/return/',
      label: 'Открываю возврат',
    });
    expect(parseAction({ type: 'highlight', target: 'price', note: 'Вот цена' })).toEqual({ type: 'highlight', target: 'price', note: 'Вот цена' });
    for (const target of ['buy_button', 'search_submit', 'buy_one_click', 'lead_form']) {
      expect(parseAction({ type: 'click', target })).toEqual({ type: 'click', target, label: undefined });
    }
    expect(parseAction({ type: 'fill', form: 'lead_form', fields: { name: 'Айгерим', phone: '+7 701 123 45 67', question: 'Возврат' } })).toEqual({
      type: 'fill',
      form: 'lead_form',
      fields: { name: 'Айгерим', phone: '+7 701 123 45 67', question: 'Возврат' },
      label: undefined,
    });
    expect(parseAction({ type: 'fill', form: 'buy_one_click', fields: { email: 'a@b.kz' } })).not.toBeNull();
    expect(parseAction({ type: 'fill', form: 'search', fields: { q: 'E27' } })).not.toBeNull();
    expect(parseAction({ type: 'suggest', options: ['Открыть карточку', 'Добавить в корзину'] })).toEqual({
      type: 'suggest',
      options: ['Открыть карточку', 'Добавить в корзину'],
    });
  });

  it('rejects unknown or removed types, targets, forms and foreign or unsafe URLs', () => {
    for (const bad of [
      null,
      'navigate',
      { type: 'teleport' },
      { type: 'filter', filters: { 'Тип цоколя': 'E27' } }, // removed from the contract
      { type: 'navigate', url: 'https://evil.example/ekt.kz/' },
      { type: 'navigate', url: 'javascript:alert(1)' },
      { type: 'navigate', url: 'https://ekt.kz.evil.example/' },
      { type: 'highlight', target: 'constructor' },
      { type: 'highlight', target: 'nope' },
      { type: 'click', target: 'price' },
      { type: 'fill', form: 'return_form', fields: { name: 'x' } }, // removed from the contract
      { type: 'fill', form: 'payment_form', fields: { card: '4111' } },
      { type: 'fill', form: 'lead_form', fields: {} },
      { type: 'fill', form: 'lead_form', fields: 'name=1' },
      { type: 'suggest', options: [] },
      { type: 'suggest', options: ['  ', null] },
    ]) {
      expect(parseAction(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseAction({ type: 'navigate', url: 'https://www.ekt.kz/about/contacts/' })).not.toBeNull();
  });

  it('trims, dedupes and caps suggestions and field values', () => {
    const a = parseAction({ type: 'suggest', options: [' Да ', 'Да', 'Б', 'В', 'Г', 'Д'] });
    expect(a).toEqual({ type: 'suggest', options: ['Да', 'Б', 'В', 'Г'] });
    const f = parseAction({ type: 'fill', form: 'lead_form', fields: { question: 'я'.repeat(900), bad: { x: 1 } } }) as any;
    expect(f.fields.question).toHaveLength(200);
    expect(f.fields.bad).toBeUndefined();
  });

  it('pageKey ignores www, trailing slash and hash', () => {
    expect(pageKey('https://www.ekt.kz/return/')).toBe(pageKey('https://ekt.kz/return#x'));
    expect(pageKey('https://ekt.kz/return/')).not.toBe(pageKey('https://ekt.kz/payments/'));
  });
});

/* ── targets on the real markup ──────────────────────────── */

describe('findTarget on a saved ekt.kz product page', () => {
  it('finds the product controls by ekt.kz classes', () => {
    loadProductPage();
    expect(findTarget('price')?.querySelector('.detail_info__price__site__value')?.textContent).toBe('281 ₸');
    expect(findTarget('buy_button')?.closest('.detail_info__buttons')).not.toBeNull();
    expect(findTarget('characteristics')?.classList.contains('tab_item_chars')).toBe(true);
    expect(findTarget('description')?.classList.contains('tab_item_chars')).toBe(false);
    expect(findTarget('description')?.textContent).toContain('Светодиодные лампы MEGALIGHT');
    expect(findTarget('cart')?.classList.contains('bx-basket')).toBe(true);
    expect(findTarget('lead_form')?.classList.contains('form_zayavka-js')).toBe(true);
    expect(findTarget('buy_one_click')?.classList.contains('form_buyoneclick-js')).toBe(true);
  });

  it('the header search is found, but only as a fallback (strict mode waits for page content)', () => {
    loadProductPage();
    const q = findTarget('search') as HTMLInputElement;
    expect(q.name).toBe('q');
    expect(q.closest('#search form')?.getAttribute('action')).toBe('/catalog/');
    expect(findTarget('search', document, true)).toBeNull();
  });

  it('skips content of closed modals (ekt.kz keeps a hidden «Оплата и доставка» modal on every page)', () => {
    loadProductPage();
    expect(document.querySelector('#delivery .checkout-and-delivery')).not.toBeNull();
    expect(findTarget('payment_methods')).toBeNull();
    document.getElementById('delivery')!.classList.add('show');
    expect(findTarget('payment_methods')?.closest('#delivery')).not.toBeNull();
  });

  it('prefers [data-ekt-target] and page content over header/footer; priority order of selectors', () => {
    document.body.innerHTML = `
      <header><a href="tel:+77273468888" id="head">+7 727</a></header>
      <div class="container project-grid" id="grid"><div class="row"><div class="col-md-10" id="cond"></div></div></div>
      <main><a href="tel:+77002220514" id="main">+7 700</a></main>
      <div class="detail_info__price__site" id="cls"></div><div data-ekt-target="price" id="pinned"></div>`;
    expect(findTarget('price')?.id).toBe('pinned');
    expect(findTarget('contacts_phone')?.id).toBe('main');
    expect(findTarget('return_conditions')?.id).toBe('cond'); // .col-md-10 before its .project-grid parent
    expect(findTarget('unknown')).toBeNull();
  });

  it('catalog_list falls back to the grid around ekt.kz product cards', () => {
    document.body.innerHTML = '<div class="row" id="grid"><div class="small_card_catalog"></div><div class="small_card_catalog"></div></div>';
    expect(findTarget('catalog_list')?.id).toBe('grid');
  });
});

/* ── highlight overlay ───────────────────────────────────── */

describe('highlight', () => {
  it('draws a ring with a note outside the widget, then removes it after 6 s', async () => {
    vi.useFakeTimers();
    loadProductPage();
    await runActions([{ type: 'highlight', target: 'price', note: 'Вот цена на сайте' }], { t });
    expect(rings()).toHaveLength(1);
    expect(layer()?.querySelector('.note')?.textContent).toBe('Вот цена на сайте');
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_MS + 400);
    expect(layer()?.querySelectorAll('.ring')).toHaveLength(0);
  });

  it('is dismissed by a click on the page', async () => {
    document.body.innerHTML = '<div id="a" class="btn-cart">Купить</div><p id="elsewhere">x</p>';
    highlightElement(document.getElementById('a')!, 'Кнопка');
    expect(rings()).toHaveLength(1);
    document.getElementById('elsewhere')!.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(rings()).toHaveLength(0);
  });

  it('respects prefers-reduced-motion: no pulse, no smooth scroll', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    a.scrollIntoView = vi.fn();
    b.scrollIntoView = vi.fn();
    highlightElement(a);
    expect(a.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    expect(rings()[0].classList.contains('pulse')).toBe(true);
    clearHighlights();
    setReducedMotion(true);
    highlightElement(b);
    expect(b.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    expect(rings()[0].classList.contains('pulse')).toBe(false);
  });

  it('opens the ekt.kz product tab that hides the characteristics', async () => {
    loadProductPage();
    const head = document.querySelector<HTMLElement>('.detail_tabs__head__item[tab="chars"]')!;
    const clicked = vi.fn();
    head.addEventListener('click', clicked);
    await runActions([{ type: 'highlight', target: 'characteristics', note: 'Характеристики' }], { t });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(rings()).toHaveLength(1);
  });

  it('silently ignores a missing element', async () => {
    vi.useFakeTimers();
    const run = runActions([{ type: 'highlight', target: 'return_conditions' }], { t });
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(rings()).toHaveLength(0);
  });
});

/* ── navigate ────────────────────────────────────────────── */

describe('navigate', () => {
  const nav: UIAction = { type: 'navigate', url: 'https://ekt.kz/return/', label: 'Открываю условия возврата' };
  const hl: UIAction = { type: 'highlight', target: 'return_conditions', note: 'Условия' };

  it('shows «Перехожу: … · Отмена» for 2 s, stores the other actions, then navigates in the same tab', async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    const beforeNavigate = vi.fn();
    const run = runActions([hl, nav, { type: 'suggest', options: ['Да'] }], { t, assign, beforeNavigate });
    await vi.advanceTimersByTimeAsync(10);
    expect(plateEl()?.textContent).toContain('Перехожу: Открываю условия возврата');
    expect(plateEl()?.querySelector('button')?.textContent).toBe('Отмена');
    expect(assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PLATE_MS);
    await run;
    expect(beforeNavigate).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://ekt.kz/return/');
    const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY)!);
    expect(saved.page).toBe(pageKey('https://ekt.kz/return/'));
    expect(saved.actions).toEqual([hl]); // suggest is rendered by the chat, navigate is done
    expect(plateEl()).toBeNull();
  });

  it('«Отмена» stops the navigation and drops the queued actions', async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    const run = runActions([nav, hl], { t, assign });
    await vi.advanceTimersByTimeAsync(500);
    plateEl()!.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(PLATE_MS * 2);
    await run;
    expect(assign).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('the last navigate wins', async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    const run = runActions([nav, { type: 'navigate', url: 'https://ekt.kz/payments/' }], { t, assign });
    await vi.advanceTimersByTimeAsync(PLATE_MS + 10);
    await run;
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('https://ekt.kz/payments/');
  });

  it('already on that page (www / slash differences too): acts here without navigating', async () => {
    setUrl('https://www.ekt.kz/return');
    const assign = vi.fn();
    document.body.innerHTML = '<div class="container project-grid"><div class="row"><div class="col-md-10">Условия</div></div></div>';
    await runActions([nav, hl], { t, assign });
    expect(assign).not.toHaveBeenCalled();
    expect(rings()).toHaveLength(1);
  });

  it('off ekt.kz (landing page): a plate with a link to ekt.kz, no navigation', async () => {
    setUrl('https://ekt-consultant.example/');
    const assign = vi.fn();
    await runActions([{ type: 'navigate', url: PRODUCT_URL, label: 'Карточка' }, hl], { t, assign });
    const a = plateEl()?.querySelector('a');
    expect(a?.getAttribute('href')).toBe(PRODUCT_URL);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(assign).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

/* ── deferred queue ──────────────────────────────────────── */

describe('deferred actions survive the page load', () => {
  it('order: the queue is in sessionStorage before the plate shows and when location.assign runs', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const assign = vi.fn(() => seen.push('assign:' + (sessionStorage.getItem(PENDING_KEY) ? 'queued' : 'EMPTY')));
    const run = runActions([{ type: 'navigate', url: 'https://ekt.kz/payments/' }, { type: 'highlight', target: 'payment_methods' }], { t, assign });
    // synchronously, before any timer: queue first, then the plate
    seen.push('plate:' + (plateEl() ? 'shown' : 'none') + ',queue:' + (sessionStorage.getItem(PENDING_KEY) ? 'queued' : 'EMPTY'));
    await vi.advanceTimersByTimeAsync(NAV_MS + 50);
    await run;
    expect(seen).toEqual(['plate:shown,queue:queued', 'assign:queued']);
  });

  it('a same-origin frame (other page key) does not swallow the queue meant for the destination page', () => {
    savePending(pageKey('https://ekt.kz/payments/'), [{ type: 'highlight', target: 'payment_methods' }]);
    expect(takePending('about:blank')).toEqual([]); // e.g. an about:blank iframe of ekt.kz
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    expect(takePending(pageKey('https://ekt.kz/payments/'))).toEqual([{ type: 'highlight', target: 'payment_methods' }]);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('runs queued highlights on the destination page (fresh module = reloaded page)', async () => {
    savePending(pageKey(location.href), [{ type: 'highlight', target: 'price', note: 'Цена' }]);
    vi.resetModules();
    const fresh = await import('../src/actions');
    loadProductPage();
    await fresh.resumePending({ t });
    const root = document.querySelector('[data-ekt-overlay]')!.shadowRoot!;
    expect(root.querySelectorAll('.ring')).toHaveLength(1);
    expect(root.querySelector('.note')?.textContent).toBe('Цена');
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull(); // consumed once
    fresh.clearHighlights();
  });

  it('waits for content that appears after load', async () => {
    savePending(pageKey(location.href), [{ type: 'highlight', target: 'price' }]);
    const run = resumePending({ t });
    setTimeout(() => (document.body.innerHTML = '<div class="detail_info__price__site">281 ₸</div>'), 300);
    await run;
    expect(rings()).toHaveLength(1);
  });

  it('ignores a queue meant for another page, stale or tampered', () => {
    savePending('https://ekt.kz/return', [{ type: 'highlight', target: 'price' }]);
    expect(takePending(pageKey(location.href))).toEqual([]);
    savePending(pageKey(location.href), [{ type: 'highlight', target: 'price' }], Date.now() - PENDING_TTL_MS - 1);
    expect(takePending(pageKey(location.href))).toEqual([]);
    sessionStorage.setItem(PENDING_KEY, '{not json');
    expect(takePending(pageKey(location.href))).toEqual([]);
  });

  it('re-validates queued actions', async () => {
    document.body.innerHTML = '<a class="btn-cart">Купить</a>';
    savePending(pageKey(location.href), [{ type: 'navigate', url: 'javascript:alert(1)' }, { type: 'bogus' }, { type: 'highlight', target: 'buy_button' }]);
    await resumePending({ t });
    expect(rings()).toHaveLength(1);
  });
});

/* ── click ───────────────────────────────────────────────── */

describe('click', () => {
  it('«Купить»: highlights .btn-cart, waits 2 s with «Отмена», then clicks it (the site adds to basket)', async () => {
    vi.useFakeTimers();
    loadProductPage();
    const buy = document.querySelector<HTMLElement>('.detail_info__buttons .btn-cart')!;
    const onClick = vi.fn();
    buy.addEventListener('click', onClick);
    const run = runActions([{ type: 'click', target: 'buy_button', label: 'Нажимаю «Купить»' }], { t });
    await vi.advanceTimersByTimeAsync(10);
    expect(rings()).toHaveLength(1);
    expect(plateEl()?.textContent).toContain('Нажимаю «Купить»');
    expect(onClick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PLATE_MS);
    await run;
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', async () => {
    vi.useFakeTimers();
    loadProductPage();
    const onClick = vi.fn();
    document.querySelector('.detail_info .btn-cart')!.addEventListener('click', onClick);
    const run = runActions([{ type: 'click', target: 'buy_button' }], { t });
    await vi.advanceTimersByTimeAsync(100);
    plateEl()!.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(PLATE_MS);
    await run;
    expect(onClick).not.toHaveBeenCalled();
  });

  it('search_submit submits the ekt.kz search form', async () => {
    vi.useFakeTimers();
    loadProductPage();
    const form = document.querySelector<HTMLFormElement>('#search form')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    const run = runActions([{ type: 'click', target: 'search_submit', label: 'Ищу' }], { t });
    await vi.advanceTimersByTimeAsync(2000 + PLATE_MS);
    await run;
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('lead_form: opens the «Оставить заявку» modal via jQuery without clicking analytics links', async () => {
    vi.useFakeTimers();
    loadProductPage();
    const modal = vi.fn(function (this: any, cmd: string) {
      if (cmd === 'show') this.el.classList.add('show');
    });
    w.jQuery = Object.assign((el: HTMLElement) => ({ el, modal }), { fn: { modal } });
    const tracked = vi.fn((e: Event) => e.preventDefault());
    document.querySelectorAll('[data-bs-target="#zayavka"]').forEach((a) => a.addEventListener('click', tracked));
    const run = runActions([{ type: 'click', target: 'lead_form', label: 'Открываю заявку' }], { t });
    await vi.advanceTimersByTimeAsync(PLATE_MS + 100);
    await run;
    expect(modal).toHaveBeenCalledWith('show');
    expect(document.getElementById('zayavka')!.classList.contains('show')).toBe(true);
    expect(tracked).not.toHaveBeenCalled(); // header links carry ym(...) goals
  });
});

/* ── fill ────────────────────────────────────────────────── */

/* ── fix round 1: buying only from the product card, cancel on new input ── */

describe('buying is bound to the product card', () => {
  const CATALOG = `
    <h1>Лампы</h1>
    <div class="row">
      <div class="small_card_catalog"><a class="btn btn-default btn-primary btn-cart" data-id="1">Купить</a>
        <a class="tqBuyOneClick" data-bs-target="#buyoneclick" data-id="1">Купить в 1 клик</a></div>
      <div class="small_card_catalog"><a class="btn btn-default btn-primary btn-cart" data-id="2">Купить</a></div>
    </div>
    <div class="modal" id="buyoneclick"><form class="form_buyoneclick-js"><input name="name"><input name="phone" class="phone-mask"></form></div>`;

  it('on a catalog / search page click buy_button and buy_one_click are ignored', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = CATALOG;
    const clicked = vi.fn();
    document.querySelectorAll('a').forEach((a) => a.addEventListener('click', clicked));
    const run = runActions([{ type: 'click', target: 'buy_button', label: 'Добавляю в корзину' }, { type: 'click', target: 'buy_one_click' }], { t });
    await vi.advanceTimersByTimeAsync(PLATE_MS * 3);
    await run;
    expect(clicked).not.toHaveBeenCalled();
    expect(plateEl()).toBeFalsy();
    expect(rings()).toHaveLength(0);
  });

  it('on a catalog page fill buy_one_click is ignored too', async () => {
    document.body.innerHTML = CATALOG;
    const opened = vi.fn();
    document.querySelector('.tqBuyOneClick')!.addEventListener('click', opened);
    await runActions([{ type: 'fill', form: 'buy_one_click', fields: { name: 'Айгерим' } }], { t });
    expect(opened).not.toHaveBeenCalled();
    expect((document.querySelector('[name="name"]') as HTMLInputElement).value).toBe('');
  });

  it('on a product page it clicks the card button (not a .btn-cart elsewhere) and names the product', async () => {
    vi.useFakeTimers();
    loadProductPage();
    document.body.insertAdjacentHTML('afterbegin', '<div class="small_card_catalog"><a class="btn-cart" id="other">Купить</a></div>');
    const other = vi.fn();
    const card = vi.fn();
    document.getElementById('other')!.addEventListener('click', other);
    document.querySelector('.detail_info .btn-cart')!.addEventListener('click', card);
    const run = runActions([{ type: 'click', target: 'buy_button', label: 'Добавляю в корзину' }], { t });
    await vi.advanceTimersByTimeAsync(10);
    expect(plateEl()?.textContent).toContain('Добавляю в корзину: LED ЛАМПА A60 "Standart" 10W 900Lm 230V 4000K E27 MEGALIGHT (100)');
    await vi.advanceTimersByTimeAsync(PLATE_MS);
    await run;
    expect(card).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('buy_one_click on a product page clicks the card «Купить в 1 клик» trigger', async () => {
    vi.useFakeTimers();
    loadProductPage();
    const trigger = vi.fn((e: Event) => (e.preventDefault(), document.getElementById('buyoneclick')!.classList.add('show')));
    document.querySelector('.detail_info .tqBuyOneClick')!.addEventListener('click', trigger);
    const run = runActions([{ type: 'click', target: 'buy_one_click', label: 'Открываю «Купить в 1 клик»' }], { t });
    await vi.advanceTimersByTimeAsync(PLATE_MS + 200);
    await run;
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe('act immediately: no plate for fill / highlight / search, 1 s for navigate', () => {
  it('click+fill of #zayavka: no plate, the modal opens and is filled in one pass', async () => {
    loadProductPage();
    const show = vi.fn(() => document.getElementById('zayavka')!.classList.add('show'));
    w.bootstrap = { Modal: { getOrCreateInstance: () => ({ show }) } };
    const inputs: string[] = [];
    document.querySelector('.form_zayavka-js')!.addEventListener('input', (e) => inputs.push((e.target as HTMLInputElement).name));
    const started = Date.now();
    await runActions(
      [
        { type: 'click', target: 'lead_form', label: 'Открываю форму заявки на возврат' },
        { type: 'fill', form: 'lead_form', fields: { name: 'Тест', phone: '+77010000000', question: 'Возврат: заказ №12345' }, label: 'Заполняю' },
      ],
      { t },
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(plateEl()).toBeFalsy();
    expect(show).toHaveBeenCalledTimes(1);
    const f = document.querySelector<HTMLFormElement>('.form_zayavka-js')!;
    expect((f.elements.namedItem('name') as HTMLInputElement).value).toBe('Тест');
    expect((f.elements.namedItem('question') as HTMLTextAreaElement).value).toBe('Возврат: заказ №12345');
    expect(inputs.sort()).toEqual(['name', 'phone', 'question']); // one pass: each field once
    expect(rings()).toHaveLength(1);
  });

  it('a field that already holds the value is left alone (no events)', () => {
    document.body.innerHTML = '<form><input name="name" value="Тест"><input name="phone" class="phone-mask" value="+7 (701) 000-00-00"></form>';
    const events = vi.fn();
    document.querySelector('form')!.addEventListener('input', events);
    expect(fillForm(document.querySelector('form')!, { name: 'Тест', phone: '+7 701 000 00 00' })).toBe(2);
    expect(events).not.toHaveBeenCalled();
  });

  it('fill search + search_submit: typed and submitted at once, no plate', async () => {
    loadProductPage();
    const form = document.querySelector<HTMLFormElement>('#search form')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    const started = Date.now();
    await runActions([{ type: 'fill', form: 'search', fields: { q: 'лампа E27 4000K' } }, { type: 'click', target: 'search_submit' }], { t });
    expect(Date.now() - started).toBeLessThan(500);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(plateEl()).toBeFalsy();
  });

  it('highlight: at once, no plate', async () => {
    loadProductPage();
    await runActions([{ type: 'highlight', target: 'price', note: 'Цена' }], { t });
    expect(rings()).toHaveLength(1);
    expect(plateEl()).toBeFalsy();
  });

  it('navigate waits 1 s (not 2) with «Отмена»', async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    const run = runActions([{ type: 'navigate', url: 'https://ekt.kz/payments/', label: 'Оплата' }], { t, assign });
    await vi.advanceTimersByTimeAsync(NAV_MS - 50);
    expect(assign).not.toHaveBeenCalled();
    expect(plateEl()?.querySelector('button')?.textContent).toBe('Отмена');
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(assign).toHaveBeenCalledWith('https://ekt.kz/payments/');
  });

  it('buying still waits 2 s with «Отмена»', async () => {
    vi.useFakeTimers();
    loadProductPage();
    const card = vi.fn();
    document.querySelector('.detail_info .btn-cart')!.addEventListener('click', card);
    const run = runActions([{ type: 'click', target: 'buy_button' }], { t });
    await vi.advanceTimersByTimeAsync(PLATE_MS - 100);
    expect(card).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await run;
    expect(card).toHaveBeenCalledTimes(1);
  });
});

describe('new input from the shopper cancels pending actions', () => {
  it('cancelActions() during the plate: no click', async () => {
    vi.useFakeTimers();
    loadProductPage();
    const card = vi.fn();
    document.querySelector('.detail_info .btn-cart')!.addEventListener('click', card);
    const run = runActions([{ type: 'click', target: 'buy_button' }], { t });
    await vi.advanceTimersByTimeAsync(500);
    expect(plateEl()).not.toBeNull();
    cancelActions();
    expect(plateEl()).toBeNull();
    await vi.advanceTimersByTimeAsync(PLATE_MS * 2);
    await run;
    expect(card).not.toHaveBeenCalled();
  });

  it('cancelActions() during a navigate plate: no navigation, queue dropped', async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    const run = runActions([{ type: 'navigate', url: 'https://ekt.kz/return/' }, { type: 'highlight', target: 'return_conditions' }], { t, assign });
    await vi.advanceTimersByTimeAsync(300);
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    cancelActions();
    await vi.advanceTimersByTimeAsync(PLATE_MS * 2);
    await run;
    expect(assign).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe('fill', () => {
  it('lead_form: opens #zayavka (Bootstrap API), fills name/email/phone/question, never submits', async () => {
    loadProductPage();
    const show = vi.fn(() => document.getElementById('zayavka')!.classList.add('show'));
    w.bootstrap = { Modal: { getOrCreateInstance: vi.fn(() => ({ show })) } };
    const form = document.querySelector<HTMLFormElement>('.form_zayavka-js')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    const events: string[] = [];
    form.addEventListener('submit', submitted);
    for (const type of ['input', 'change', 'keyup']) form.addEventListener(type, (e) => events.push(`${type}:${(e.target as HTMLInputElement).name}`));
    await runActions(
      [
        {
          type: 'fill',
          form: 'lead_form',
          label: 'Заполняю заявку на возврат',
          fields: { name: 'Айгерим', email: 'a@example.kz', phone: '+7 701 123-45-67', question: 'Возврат: заказ № 102938', form_id: 'hack', file: 'x' },
        },
      ],
      { t },
    );
    expect(show).toHaveBeenCalled();
    const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
    expect(v('name')).toBe('Айгерим');
    expect(v('email')).toBe('a@example.kz');
    expect(v('phone')).toBe('77011234567'); // digits for IMask «+{7} (000) 000-00-00»
    expect(v('question')).toBe('Возврат: заказ № 102938');
    expect(v('form_id')).toBe('zayavka'); // hidden fields are never touched
    expect(events).toEqual(expect.arrayContaining(['input:name', 'change:email', 'keyup:phone', 'input:question']));
    expect(submitted).not.toHaveBeenCalled();
    expect(rings()).toHaveLength(1);
    expect(layer()?.querySelector('.note')?.textContent).toBe('Заполняю заявку на возврат');
  });

  it('buy_one_click: clicks the product trigger (the site fills its hidden product field) and fills the form', async () => {
    loadProductPage();
    const trigger = document.querySelector<HTMLElement>('.tqBuyOneClick')!;
    const opened = vi.fn(() => document.getElementById('buyoneclick')!.classList.add('show'));
    trigger.addEventListener('click', (e) => (e.preventDefault(), opened()));
    await runActions([{ type: 'fill', form: 'buy_one_click', fields: { name: 'Айгерим', phone: '87011234567', email: 'a@example.kz' } }], { t });
    expect(opened).toHaveBeenCalledTimes(1);
    const form = document.querySelector<HTMLFormElement>('.form_buyoneclick-js')!;
    expect((form.elements.namedItem('phone') as HTMLInputElement).value).toBe('77011234567');
    expect((form.elements.namedItem('email') as HTMLInputElement).value).toBe('a@example.kz');
  });

  it('search: types the query into the ekt.kz search box', async () => {
    loadProductPage();
    await runActions([{ type: 'fill', form: 'search', fields: { q: 'лампа E27 4000K' } }], { t });
    expect((document.querySelector('#search input[name="q"]') as HTMLInputElement).value).toBe('лампа E27 4000K');
    expect(rings()).toHaveLength(1);
  });

  it('uses an instance-level value setter when an input mask installed one', () => {
    document.body.innerHTML = '<form><input name="phone" class="phone-mask"></form>';
    const input = document.querySelector('input')!;
    let stored = '';
    Object.defineProperty(input, 'value', { configurable: true, get: () => stored, set: (v) => (stored = `mask(${v})`) });
    expect(setFieldValue(input, '+7 (701) 123-45-67')).toBe(true);
    expect(input.value).toBe('mask(77011234567)');
  });
});

/* ── the widget does not trust the server blindly ────────── */

describe('security: client-side validation of actions', () => {
  it('search_submit submits only the ekt.kz catalog search form', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<form action="/personal/profile/" id="f"><input name="q"></form>';
    const submitted = vi.fn((e: Event) => e.preventDefault());
    document.getElementById('f')!.addEventListener('submit', submitted);
    const run = runActions([{ type: 'click', target: 'search_submit' }], { t });
    await vi.advanceTimersByTimeAsync(2000 + PLATE_MS * 2);
    await run;
    expect(submitted).not.toHaveBeenCalled();
  });

  it('fill skips disabled and read-only fields', () => {
    document.body.innerHTML = '<form><input name="name" disabled><input name="email" readonly><input name="phone"></form>';
    const form = document.querySelector('form')!;
    expect(fillForm(form, { name: 'a', email: 'e@x.kz', phone: '87011234567' })).toBe(1);
    expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe('');
    expect((form.elements.namedItem('email') as HTMLInputElement).value).toBe('');
  });

  it('never clicks modal triggers that carry analytics (onclick) — no API, no modal', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<a href="#" data-bs-target="#zayavka" onclick="return false" id="ym">Оставить заявку</a>
      <div class="modal" id="zayavka"><form class="form_zayavka-js"><input name="name"></form></div>`;
    const tracked = vi.fn();
    document.getElementById('ym')!.addEventListener('click', tracked);
    const run = runActions([{ type: 'click', target: 'lead_form' }], { t });
    await vi.advanceTimersByTimeAsync(PLATE_MS + 2000);
    await run;
    expect(tracked).not.toHaveBeenCalled();
    expect(document.getElementById('zayavka')!.classList.contains('show')).toBe(false);
  });

  it('navigate: only https://ekt.kz or www.ekt.kz, no query/fragment/port/credentials/other schemes', () => {
    for (const ok of ['https://ekt.kz/return/', 'https://www.ekt.kz/about/contacts/', 'https://EKT.kz/']) expect(safeNavUrl(ok), ok).not.toBeNull();
    for (const bad of [
      'http://ekt.kz/return/',
      'https://ekt.kz/catalog/?q=1',
      'https://ekt.kz/return/#form',
      'https://ekt.kz:8443/',
      'https://user:pw@ekt.kz/',
      'https://ekt.kz.evil.example/',
      'https://evil.example/https://ekt.kz/',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//ekt.kz/return/',
      '/return/',
      'https://shop.ekt.kz/',
      42,
    ]) {
      expect(safeNavUrl(bad), String(bad)).toBeNull();
      expect(parseAction({ type: 'navigate', url: bad })).toBeNull();
    }
  });

  it('navigate: the page own origin is allowed only on a local dev host', () => {
    setUrl('http://localhost:5173/index.html');
    expect(safeNavUrl('http://localhost:5173/embed.html')).toBe('http://localhost:5173/embed.html');
    expect(safeNavUrl('http://localhost:9999/')).toBeNull();
    setUrl('https://ekt-consultant.example/');
    expect(safeNavUrl('https://ekt-consultant.example/embed.html')).toBeNull();
  });

  it('fill: only whitelisted field names of the form, values cut to 200 characters', () => {
    const a = parseAction({
      type: 'fill',
      form: 'lead_form',
      fields: { name: 'Айгерим', sessid: 'x', form_id: 'x', utm_source: 'x', password: 'x', file: 'x', url: 'x', question: 'в'.repeat(300) },
    }) as any;
    expect(Object.keys(a.fields).sort()).toEqual(['name', 'question']);
    expect(a.fields.question).toHaveLength(200);
    expect(parseAction({ type: 'fill', form: 'search', fields: { name: 'x' } })).toBeNull();
    expect(parseAction({ type: 'fill', form: 'buy_one_click', fields: { question: 'x' } })).toBeNull();
  });

  it('fill never touches hidden, password, file or service fields and assigns text only', () => {
    document.body.innerHTML = `<form>
      <input type="hidden" name="name"><input type="password" name="phone"><input type="file" name="email">
      <input name="sessid"><input name="utm_source"><textarea name="question"></textarea></form>`;
    const form = document.querySelector('form')!;
    expect(fillForm(form, { name: 'a', phone: '1', email: 'e', sessid: 's', utm_source: 'u', question: '<img src=x onerror=alert(1)>' })).toBe(1);
    const q = form.querySelector('textarea')!;
    expect(q.value).toBe('<img src=x onerror=alert(1)>');
    expect(q.children).toHaveLength(0); // text, not markup
    expect((form.querySelector('[name="sessid"]') as HTMLInputElement).value).toBe('');
  });

  it('click never presses a submit button (only the search form may be submitted)', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<form><button type="submit" class="btn-cart">Отправить</button></form>';
    const submitted = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', submitted);
    const run = runActions([{ type: 'click', target: 'buy_button' }], { t });
    await vi.advanceTimersByTimeAsync(PLATE_MS * 2);
    await run;
    expect(submitted).not.toHaveBeenCalled();
    expect(plateEl()).toBeFalsy();
  });
});
