/**
 * "Hands" of the consultant on the real ekt.kz: UI actions streamed by the backend as SSE `action` events.
 *
 *   navigate  → plate «Перехожу: … · Отмена» for 2 s, then location.assign() in the same tab;
 *               the other actions of the reply are queued in sessionStorage and run on the new page.
 *               Off ekt.kz (landing page, other hosts) the plate offers a link to open ekt.kz instead.
 *   highlight → scroll to the element, pulsing ring + note (overlay outside the widget, pointer-events:none).
 *   click     → plate «<label> · Отмена» for 2 s, ring, then the click (.btn-cart → add2basket of the site,
 *               search_submit → form.requestSubmit(), lead_form / buy_one_click → open the site's modal).
 *   fill      → open the modal form if needed, set fields by name (input/change/keyup), ring. Never submits.
 *   suggest   → quick replies (rendered by the widget, not here).
 *
 * Targets are ekt.kz classes (see SELECTORS); a page may pin an element with data-ekt-target="<target>".
 *
 * The server is not trusted blindly: every action is re-validated here (parseAction) against the
 * contract whitelists — ekt.kz URLs only, known targets, known forms and field names, short values.
 */
import type { Strings } from './i18n';
import { clearPending, savePending, takePending } from './storage';

export type UIAction =
  | { type: 'navigate'; url: string; label?: string }
  | { type: 'highlight'; target: string; note?: string }
  | { type: 'click'; target: string; label?: string }
  | { type: 'fill'; form: string; fields: Record<string, string>; label?: string }
  | { type: 'suggest'; options: string[] };

const SEARCH = '#search form[action="/catalog/"] input[name="q"], input[name="q"]';

/**
 * Selectors of the real ekt.kz markup, in priority order (", "-separated, tried one by one).
 * `[data-ekt-target=…]` is always tried first.
 */
export const SELECTORS: Record<string, string> = {
  price: '.detail_info__price__site',
  buy_button: '.btn-cart',
  characteristics: '.tab_item_chars',
  description: '.detail_tabs__body__item__value:not(.tab_item_chars)',
  return_conditions: '.project-grid .col-md-10, .project-grid',
  payment_methods: '.checkout-and-delivery, .white-bg',
  contacts_phone: 'a[href^="tel:"]',
  catalog_list: '.catalog_section, .catalog-list, .small_card_catalog',
  search: SEARCH,
  search_submit: SEARCH,
  cart: '.bx-basket',
  lead_form: '#zayavka form',
  buy_one_click: '#buyoneclick form',
};
/** Bootstrap modals of ekt.kz that hold a form: the consultant opens them itself. */
const MODALS: Record<string, string> = { lead_form: '#zayavka', buy_one_click: '#buyoneclick' };
const CLICKABLE = ['buy_button', 'search_submit', 'buy_one_click', 'lead_form'];
/** Forms the consultant may fill and the only field names it may touch in each. */
const FORMS: Record<string, string[]> = {
  lead_form: ['name', 'email', 'phone', 'question'],
  buy_one_click: ['name', 'phone', 'email'],
  search: ['q'],
};
const own = (o: object, key: unknown): key is string => typeof key == 'string' && Object.prototype.hasOwnProperty.call(o, key);
const known = (key: unknown): key is string => own(SELECTORS, key);
const LOCAL = /^(localhost|127\.0\.0\.1)$/;

export const PLATE_MS = 2000;
export const HIGHLIGHT_MS = 6000;

/* ── parsing ─────────────────────────────────────────────── */

const str = (v: unknown, max: number): string | undefined =>
  typeof v == 'number' && isFinite(v) ? String(v) : typeof v == 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** Validate one `action` event payload; anything unknown or malformed → null (ignored). */
export function parseAction(d: any): UIAction | null {
  const type = d && d.type;
  const label = type && str(d.label, 120);
  const target = type && d.target;
  if (type == 'navigate') {
    const url = safeNavUrl(d.url);
    return url ? { type, url, label } : null;
  }
  if (type == 'highlight') return known(target) ? { type, target, note: str(d.note, 200) } : null;
  if (type == 'click') return CLICKABLE.includes(target) ? { type, target, label } : null;
  if (type == 'fill' && own(FORMS, d.form) && d.fields && typeof d.fields == 'object') {
    const fields: Record<string, string> = {};
    let n = 0;
    for (const k of FORMS[d.form]) {
      const v = str(d.fields[k], 200);
      if (v) (fields[k] = v), n++;
    }
    return n ? { type, form: d.form, fields, label } : null;
  }
  if (type == 'suggest' && Array.isArray(d.options)) {
    const options = Array.from(new Set(d.options.map((o: unknown) => str(o, 80)).filter(Boolean) as string[])).slice(0, 4);
    return options.length ? { type, options } : null;
  }
  return null;
}

/* ── URLs ────────────────────────────────────────────────── */

const onEkt = () => /(^|\.)ekt\.kz$/i.test(location.hostname);

/**
 * Only https://ekt.kz/… or https://www.ekt.kz/… without query, fragment, port or credentials;
 * on a local dev host also its own origin. Everything else (javascript:, data:, other hosts) → null.
 */
export function safeNavUrl(raw: unknown): string | null {
  if (typeof raw != 'string' || raw.length > 1000 || /[?#\s]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return null;
    if (u.protocol == 'https:' && !u.port && /^(www\.)?ekt\.kz$/i.test(u.hostname)) return u.href;
    if (LOCAL.test(location.hostname) && u.origin == location.origin) return u.href;
  } catch {
    /* not a URL */
  }
  return null;
}

/** Page identity for the deferred queue: origin without www + path without trailing slash + query. */
export function pageKey(href: string): string {
  try {
    const u = new URL(href, location.href);
    const p = u.pathname.replace(/\/+$/, '');
    return u.origin.replace('//www.', '//') + (p || '/') + u.search;
  } catch {
    return href;
  }
}

/* ── targets ─────────────────────────────────────────────── */

/**
 * `[data-ekt-target]` wins; then the ekt.kz selectors in priority order, preferring page content
 * over header/footer (phones, search) and skipping closed modals (ekt.kz keeps a hidden «Оплата»
 * modal on every page). `strict` refuses the header/footer fallback while a page may still render.
 */
export function findTarget(key: string, doc: Document = document, strict = false): HTMLElement | null {
  const pinned = doc.querySelector<HTMLElement>(`[data-ekt-target="${key}"]`);
  if (pinned || !known(key)) return pinned;
  let loose: HTMLElement | null = null;
  for (const sel of SELECTORS[key].split(', ')) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(sel))) {
      if (!MODALS[key] && el.closest('.modal:not(.show)')) continue;
      if (!el.closest('header, footer, nav')) return key == 'catalog_list' && sel == '.small_card_catalog' ? el.parentElement : el;
      loose = loose || el;
    }
  }
  return strict ? null : loose;
}

/**
 * Wait for a proper target; accept a header/footer match only when nothing better showed up
 * (search and cart live in the ekt.kz header, so they are taken from there right away).
 */
async function locate(key: string, ms: number): Promise<HTMLElement | null> {
  const strict = !/^(search|search_submit|cart)$/.test(key);
  return (await waitFor(() => findTarget(key, document, strict), ms)) || findTarget(key);
}

function waitFor<T>(fn: () => T | null, ms: number): Promise<T | null> {
  return new Promise((done) => {
    const end = Date.now() + ms;
    const tick = () => {
      const v = fn();
      if (v || Date.now() >= end) done(v);
      else setTimeout(tick, 120);
    };
    tick();
  });
}

/** Make a target in a closed ekt.kz product tab visible by clicking that tab. */
function reveal(el: HTMLElement): void {
  const body = el.closest<HTMLElement>('.detail_tabs__body__item[tab]');
  if (body && !body.classList.contains('active'))
    document.querySelector<HTMLElement>(`.detail_tabs__head__item[tab="${body.getAttribute('tab')!.replace(/["\\]/g, '')}"]`)?.click();
}

/**
 * Buying controls act only on a product page and only inside its own card (.detail_info):
 * on a catalog or search page the first .btn-cart would put a different product in the basket.
 */
const PRODUCT_CONTROLS: Record<string, string> = { buy_button: '.detail_info .btn-cart', buy_one_click: '.detail_info .tqBuyOneClick' };
function productControl(key: string): HTMLElement | null {
  return document.querySelector('.detail_info__price__site') ? document.querySelector<HTMLElement>(PRODUCT_CONTROLS[key]) : null;
}

/** The trigger that opens a modal form: the product card's own one, or a link without analytics (ym goals). */
function modalTrigger(key: string): HTMLElement | null {
  if (PRODUCT_CONTROLS[key]) return productControl(key);
  const sel = MODALS[key];
  return (
    Array.from(document.querySelectorAll<HTMLElement>(`[data-bs-target="${sel}"],[data-target="${sel}"]`)).find(
      (e) => !e.hasAttribute('onclick') && !e.matches('[type="submit"]'),
    ) || null
  );
}

/** Open an ekt.kz Bootstrap modal: click its trigger (the site fills hidden fields) or use the Bootstrap / jQuery API. */
async function openModal(sel: string, trigger: HTMLElement | null): Promise<HTMLElement | null> {
  const m = document.querySelector<HTMLElement>(sel);
  if (!m) return null;
  const shown = () => (m.classList.contains('show') || m.style.display == 'block' ? m : null);
  if (!shown()) {
    const w = window as any;
    if (trigger) trigger.click();
    else if (w.bootstrap?.Modal?.getOrCreateInstance) w.bootstrap.Modal.getOrCreateInstance(m).show();
    else if (w.jQuery?.fn?.modal) w.jQuery(m).modal('show');
    else return null;
    await waitFor(shown, 1500);
  }
  return m;
}

export const reducedMotion = (): boolean => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ── overlay (rings, notes, plate) ───────────────────────── */

const OVERLAY_CSS =
  ':host{all:initial;font:15px/1.35 "PT Sans",Arial,sans-serif;color:#1c2830}' +
  '.ring,.note,.plate{position:fixed;transition:opacity .3s}' +
  '.ring,.note{z-index:2147482990;pointer-events:none}' +
  '.ring{border:3px solid #f4b301;border-radius:10px;box-shadow:0 0 0 1px #0b436659,0 6px 20px #0b43662e}' +
  '.pulse:after{content:"";position:absolute;inset:-3px;border:3px solid #f4b301;border-radius:12px;animation:p 1.4s cubic-bezier(.2,.8,.3,1) 3}' +
  '@keyframes p{to{inset:-17px;opacity:0}}' +
  '.note{max-width:280px;padding:8px 12px;border-radius:8px;background:#0b4366;color:#fff;font-weight:700;font-size:14px;box-shadow:0 8px 24px #0b436647}' +
  '.out{opacity:0}' +
  '.plate{z-index:2147483005;top:16px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 32px);display:flex;align-items:center;gap:12px;' +
  'padding:10px 10px 10px 16px;border-radius:10px;overflow:hidden;background:#fff;border:1px solid #c3d0d9;box-shadow:0 12px 32px #0b436638}' +
  '.plate b{color:#0b4366}' +
  '.plate button,.plate a{flex:none;padding:8px 14px;border-radius:8px;border:1px solid #2c7294;background:#fff;color:#235c78;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}' +
  ':focus-visible{outline:2px solid #2c7294;outline-offset:2px}' +
  '.bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:#f4b301;transform-origin:0;animation:b var(--ms) linear forwards}' +
  '@keyframes b{to{transform:scaleX(0)}}' +
  '@media (prefers-reduced-motion:reduce){*,:after{animation:none!important;transition:none!important}}';

let layer: ShadowRoot | null = null;
function overlay(): ShadowRoot {
  if (layer && layer.host.isConnected) return layer;
  // A static, non-positioned host: its fixed children join the root stacking context,
  // so rings sit above the site (and its modals) but under the chat panel, the plate above all.
  const host = document.createElement('div');
  host.setAttribute('data-ekt-overlay', '');
  host.style.cssText = 'display:block;width:0;height:0;overflow:visible';
  layer = host.attachShadow({ mode: 'open' });
  layer.append(el('style', '', OVERLAY_CSS));
  document.body.appendChild(host);
  return layer;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface Ring {
  el: HTMLElement;
  ring: HTMLElement;
  note: HTMLElement | null;
  timer: ReturnType<typeof setTimeout>;
}
const rings: Ring[] = [];
let raf = 0;
const px = (n: number) => `${n}px`;

function place(r: Ring): void {
  const b = r.el.getBoundingClientRect();
  const hide = !r.el.isConnected || (!b.width && !b.height);
  for (const e of [r.ring, r.note]) if (e) e.style.display = hide ? 'none' : '';
  if (hide) return;
  const s = r.ring.style;
  s.left = px(b.left - 6);
  s.top = px(b.top - 6);
  s.width = px(b.width + 12);
  s.height = px(b.height + 12);
  if (r.note) {
    // Below the ring, else above it, else (tall targets) inside its visible top edge.
    const nh = r.note.offsetHeight || 36;
    const below = b.bottom + 12;
    const above = b.top - 18 - nh;
    const inside = below + nh > innerHeight && above < 8;
    r.note.style.top = px(!inside ? (below + nh <= innerHeight ? below : above) : Math.min(Math.max(b.top + 12, 12), innerHeight - nh - 12));
    r.note.style.left = px(Math.max(8, Math.min(b.left + (inside ? 12 : 0), innerWidth - (r.note.offsetWidth || 280) - 8)));
  }
}

function loop(): void {
  rings.forEach(place);
  raf = rings.length ? requestAnimationFrame(loop) : 0;
}

function dropRing(r: Ring): void {
  const i = rings.indexOf(r);
  if (i < 0) return;
  rings.splice(i, 1);
  clearTimeout(r.timer);
  for (const e of [r.ring, r.note]) e?.classList.add('out');
  setTimeout(() => (r.ring.remove(), r.note?.remove()), reducedMotion() ? 0 : 300);
}

export function clearHighlights(): void {
  rings.slice().forEach(dropRing);
}

function onPointerDown(e: Event): void {
  // Clicks inside the chat keep the highlight; anywhere else on the page dismisses it.
  if (!e.composedPath().some((n) => n instanceof Element && n.hasAttribute('data-ekt-consultant'))) clearHighlights();
}

/** Ring + optional note around `target` for HIGHLIGHT_MS; scrolls it into view first. */
export function highlightElement(target: HTMLElement, note?: string, scroll = true): void {
  reveal(target);
  const reduce = reducedMotion();
  // Tall targets (long texts, product grids) scroll to their start, small ones to the middle.
  const tall = target.getBoundingClientRect().height > innerHeight * 0.7;
  // Header controls (search, cart) are sticky on ekt.kz: scrolling to them would only jump the page.
  if (scroll && target.scrollIntoView && !target.closest('header')) target.scrollIntoView({ block: tall ? 'start' : 'center', behavior: reduce ? 'auto' : 'smooth' });
  rings.filter((r) => r.el === target).forEach(dropRing);
  const root = overlay();
  const ring = el('div', reduce ? 'ring' : 'ring pulse');
  const noteEl = note ? el('div', 'note', note) : null;
  root.append(ring);
  if (noteEl) root.append(noteEl);
  const r: Ring = { el: target, ring, note: noteEl, timer: setTimeout(() => dropRing(r), HIGHLIGHT_MS) };
  rings.push(r);
  place(r);
  if (!raf) raf = requestAnimationFrame(loop);
  document.addEventListener('pointerdown', onPointerDown, true);
}

/* ── plate ───────────────────────────────────────────────── */

let plateEl: HTMLElement | null = null;
let plateCancel: (() => void) | null = null;

function closePlate(): void {
  plateCancel?.();
  plateCancel = null;
  plateEl?.remove();
  plateEl = null;
}

function plateShell(text: string, ms: number, ...kids: HTMLElement[]): HTMLElement {
  closePlate();
  const p = (plateEl = el('div', 'plate'));
  p.setAttribute('role', 'status');
  p.append(el('b', '', text), ...kids);
  overlay().append(p);
  if (ms) {
    const timer = setTimeout(() => plateEl === p && closePlate(), ms);
    plateCancel = () => clearTimeout(timer);
  }
  return p;
}

/** «text · Отмена» for `ms`; resolves true when time is up, false when cancelled or replaced. */
export function plate(text: string, t: Pick<Strings, 'cancel'>, ms = PLATE_MS): Promise<boolean> {
  const btn = el('button', '', t.cancel);
  btn.type = 'button';
  const bar = el('div', 'bar');
  bar.style.setProperty('--ms', `${ms}ms`);
  plateShell(text, 0, btn, bar);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      plateCancel = null;
      closePlate();
      done(true);
    }, ms);
    plateCancel = () => (clearTimeout(timer), done(false));
    btn.addEventListener('click', closePlate);
  });
}

/** Off ekt.kz: a plate with a link that opens the page on ekt.kz in a new tab (no auto-popup). */
function linkPlate(text: string, href: string, t: Pick<Strings, 'openEkt'>): void {
  const a = el('a', '', t.openEkt);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  plateShell(text, 12000, a); // hides itself after 12 s or once the link is used
  a.addEventListener('click', () => setTimeout(closePlate));
}

/* ── forms ───────────────────────────────────────────────── */

/** "+7 701 123-45-67", "8 701…", "701…" → "77011234567" for ekt.kz's IMask «+{7} (000) 000-00-00». */
function phoneDigits(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length == 10 ? '7' + d : d.length == 11 && d[0] == '8' ? '7' + d.slice(1) : d;
}

/** Set a text value so the site's scripts notice it (.value + input/change/keyup). */
export function setFieldValue(field: HTMLElement, value: string): boolean {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || field.disabled || field.readOnly) return false;
  // Never touch secrets, files, hidden/service fields (sessid, form_id, utm_*) or buttons.
  if (/^(sessid|form_id|utm_)/.test(field.name) || /^(checkbox|radio|file|hidden|password|submit|button|image|reset)$/.test(field.type)) return false;
  field.value = (field.type == 'tel' || field.classList.contains('phone-mask') ? phoneDigits(value) : value).slice(0, 200);
  for (const type of ['input', 'change', 'keyup']) field.dispatchEvent(new Event(type, { bubbles: true }));
  return true;
}

/** Fill fields of a form (or of the form around `target`) by data-ekt-field, then name. */
export function fillForm(target: HTMLElement, fields: Record<string, string>): number {
  const scope = target.closest('form') || target;
  let n = 0;
  for (const key in fields) {
    const k = key.replace(/["\\]/g, '');
    const f = scope.querySelector<HTMLElement>(`[data-ekt-field="${k}"]`) || scope.querySelector<HTMLElement>(`[name="${k}"]`);
    if (f && setFieldValue(f, fields[key])) n++;
  }
  return n;
}

/* ── runner ──────────────────────────────────────────────── */

export interface ActionEnv {
  t: Pick<Strings, 'cancel' | 'going' | 'openEkt'>;
  /** Same-tab navigation (tests replace it). */
  assign?: (url: string) => void;
  /** Called before anything visual happens on the page (the widget closes its full-screen panel on phones). */
  onVisual?: () => void;
  /** Called right before navigation (the widget persists its state). */
  beforeNavigate?: () => void;
}

/** Generation of the running batch: a newer batch or new input from the shopper stops older actions. */
let running = 0;

/** The shopper typed or started a new conversation: stop pending plates, clicks and queued navigation actions. */
export function cancelActions(): void {
  running++;
  closePlate();
  clearPending();
}

async function runOne(a: UIAction, env: ActionEnv, wait: number, scroll: boolean, my: number): Promise<void> {
  if (a.type == 'highlight') {
    const target = await locate(a.target, wait);
    if (target) highlightElement(target, a.note, scroll);
  } else if (a.type == 'click') {
    const modal = MODALS[a.target];
    const product = !!PRODUCT_CONTROLS[a.target];
    const target = modal || product ? modalTrigger(a.target) : await locate(a.target, wait);
    const form = a.target == 'search_submit' ? target?.closest('form') : null;
    // Buying only from the product card; the search form only if it is the ekt.kz catalog search; never a submit button.
    if ((product && !target) || (!modal && !target) || target?.matches('[type="submit"]')) return;
    if (a.target == 'search_submit' && !form?.matches('#search form, form[action^="/catalog/"]')) return;
    if (target) highlightElement(target, undefined, scroll);
    const title = product ? (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '';
    const text = a.label || env.t.going;
    if (!(await plate(title ? `${text}: ${title}` : text, env.t)) || my != running) return;
    if (modal) await openModal(modal, target);
    else if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    else target!.click();
  } else if (a.type == 'fill') {
    const modal = MODALS[a.form];
    const target = await locate(a.form, modal ? 1500 : wait);
    if (modal) {
      const trigger = modalTrigger(a.form);
      if (PRODUCT_CONTROLS[a.form] && !trigger) return; // «Купить в 1 клик» only on a product page
      // Fill first, so the modal opens already filled; fill again after opening in case the site resets it.
      if (target) fillForm(target, a.fields);
      await openModal(modal, trigger);
    }
    if (my == running && target && fillForm(target, a.fields)) highlightElement(target.closest('form') || target, a.label, scroll && !modal);
  }
}

/**
 * Run the actions of one reply. A `navigate` (the last one wins) defers every other action
 * to the destination page; without it the actions run here, in order.
 */
export async function runActions(actions: UIAction[], env: ActionEnv, deferred = false): Promise<void> {
  const my = ++running;
  clearHighlights(); // a new reply replaces the previous rings
  let list = actions.filter((a) => a.type != 'suggest');
  const nav = deferred ? undefined : list.filter((a) => a.type == 'navigate').pop();
  list = list.filter((a) => a.type != 'navigate');
  // «Open the form» + «fill the form» in one reply: filling opens the modal itself, no extra 2-second plate.
  list = list.filter((a) => !(a.type == 'click' && MODALS[a.target] && list.some((b) => b.type == 'fill' && b.form == a.target)));
  if (nav && nav.type == 'navigate') {
    const label = nav.label || nav.url;
    if (!onEkt() && new URL(nav.url).origin != location.origin) return linkPlate(label, nav.url, env.t);
    if (pageKey(nav.url) != pageKey(location.href)) {
      env.onVisual?.();
      savePending(pageKey(nav.url), list);
      if (!(await plate(`${env.t.going}: ${label}`, env.t)) || my != running) {
        if (my == running) clearPending();
        return;
      }
      env.beforeNavigate?.();
      (env.assign || ((u: string) => location.assign(u)))(nav.url);
      return;
    }
    // Already on that page: just act here.
  }
  if (!list.length) return;
  env.onVisual?.();
  const wait = deferred ? 8000 : 1500;
  let scroll = true;
  for (const a of list) {
    if (my != running) return;
    await runOne(a, env, wait, scroll, my);
    scroll = false;
  }
}

/** On page load: run actions queued by a navigate on the previous page. */
export function resumePending(env: ActionEnv): Promise<void> {
  const list = takePending<unknown>(pageKey(location.href))
    .map(parseAction)
    .filter((a): a is UIAction => !!a);
  return list.length ? runActions(list, env, true) : Promise.resolve();
}
