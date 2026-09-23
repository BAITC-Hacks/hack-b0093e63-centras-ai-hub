/**
 * EKT AI consultant — embeddable chat widget.
 *
 *   <script src="https://<host>/widget.js" data-api="https://<ref>.supabase.co/functions/v1/chat" defer></script>
 *
 * Optional attributes: data-title, data-color, data-position="left|right",
 * data-open="true", data-lang="ru|kk|en", data-city.
 * Public API: window.EKTConsultant.open() / .close() / .ask(text)
 */
import { icons } from './icons';
import { detectLang, strings, type Strings } from './i18n';
import { renderMarkdown } from './markdown';
import { readSSE } from './sse';
import { clear, load, save, storageKey, type Msg, type Product } from './storage';
import { css } from './styles';

export interface EKTConsultantAPI {
  open(): void;
  close(): void;
  ask(text: string): void;
}

declare global {
  interface Window {
    EKTConsultant?: EKTConsultantAPI;
  }
}

const MAX_LEN = 2000;
const MOBILE = '(max-width: 479px)';

interface Config {
  api: string;
  title: string;
  color?: string;
  position: 'left' | 'right';
  open: boolean;
  city?: string;
  t: Strings;
}

/* ── helpers ─────────────────────────────────────────────── */

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  html?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v !== undefined) el.setAttribute(k, v);
  }
  if (html !== undefined) el.innerHTML = html;
  return el;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Only http(s) URLs may reach href/src. */
function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u, 'https://ekt.kz/');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const EKT_HOST = /(^|\.)ekt\.kz$/i;
const onEkt = () => EKT_HOST.test(location.hostname);

/** On ekt.kz itself, links to ekt.kz open in the same tab (chat survives via storage). */
function setLinkTarget(a: HTMLAnchorElement): void {
  let host = '';
  try {
    host = new URL(a.href).hostname;
  } catch {
    /* keep new tab */
  }
  if (onEkt() && EKT_HOST.test(host)) a.removeAttribute('target');
  else {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}

let priceFmt: Intl.NumberFormat | null = null;
function money(n: unknown): string | null {
  const v = typeof n === 'string' ? Number(n) : n;
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return null;
  priceFmt = priceFmt || new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  return `${priceFmt.format(v)} ₸`;
}

function hexInk(color: string): { strong: string; ink: string } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const strong = '#' + rgb.map((c) => Math.round(c * 0.8).toString(16).padStart(2, '0')).join('');
  // White text needs ≥ 4.5:1; otherwise switch to dark ink.
  return { strong, ink: 1.05 / (L + 0.05) >= 4.5 ? '#ffffff' : '#111a20' };
}

function readConfig(): Config | null {
  const script =
    (document.currentScript as HTMLScriptElement | null) ||
    document.querySelector<HTMLScriptElement>('script[data-api][src*="widget"]');
  const d = script ? script.dataset : ({} as DOMStringMap);
  const api = safeUrl(d.api || '');
  if (!api || !d.api) {
    console.warn('[EKT consultant] data-api is missing or invalid; widget not started.');
    return null;
  }
  const t = strings(detectLang(d.lang));
  return {
    api: d.api.replace(/\/+$/, ''),
    title: (d.title || '').trim() || t.title,
    color: d.color,
    position: d.position === 'left' ? 'left' : 'right',
    open: d.open === 'true',
    city: d.city || undefined,
    t,
  };
}

/* ── widget ──────────────────────────────────────────────── */

function mount(cfg: Config): EKTConsultantAPI {
  const { t } = cfg;
  const key = storageKey(cfg.api);
  const saved = load(key);
  let sessionId: string | undefined = saved?.sessionId;
  let messages: Msg[] = saved?.messages || [];
  let isOpen = false;
  let unread = !!saved?.unread;
  let controller: AbortController | null = null;
  let streaming = false;
  /** Bumped by "new conversation" so late stream callbacks can't touch the fresh log. */
  let gen = 0;
  /** Question asked via API while a reply was streaming; sent once the old stream settles. */
  let queued: string | null = null;
  const mq = window.matchMedia(MOBILE);

  // Host + shadow root
  const host = h('div', { id: 'ekt-consultant', 'data-ekt-consultant': '' });
  const shadow = host.attachShadow({ mode: 'open' });
  if (cfg.color && typeof CSS !== 'undefined' && CSS.supports('color', cfg.color)) {
    host.style.setProperty('--ekt-accent', cfg.color);
    const ink = hexInk(cfg.color);
    host.style.setProperty('--ekt-accent-strong', ink ? ink.strong : cfg.color);
    if (ink) host.style.setProperty('--ekt-on-accent', ink.ink);
  }
  const style = h('style');
  style.textContent = css;
  const root = h('div', { class: `root ${cfg.position}` });
  shadow.append(style, root);

  // Launcher
  const launcher = h(
    'button',
    { type: 'button', class: 'launcher', 'aria-label': t.launcherAria, 'aria-expanded': 'false', 'aria-controls': 'ekt-panel' },
    `${icons.chat}<span class="label">${t.launcher}</span><span class="badge" aria-hidden="true"></span>`,
  );

  // Panel
  const panel = h('section', { class: 'panel', id: 'ekt-panel', role: 'dialog', 'aria-labelledby': 'ekt-title' });
  const header = h('header', { class: 'header' });
  const avatar = h('div', { class: 'avatar', 'aria-hidden': 'true' }, icons.bolt);
  const heading = h('div', { class: 'heading' });
  const title = h('h2', { class: 'title', id: 'ekt-title' });
  title.textContent = cfg.title;
  const sub = h('div', { class: 'sub' });
  sub.textContent = t.online;
  heading.append(title, sub);
  const newBtn = h('button', { type: 'button', class: 'hbtn', 'aria-label': t.newChat, title: t.newChat }, icons.newChat);
  const closeBtn = h('button', { type: 'button', class: 'hbtn', 'aria-label': t.close, title: t.close }, icons.close);
  header.append(avatar, heading, newBtn, closeBtn);

  const log = h('div', { class: 'log', role: 'log', 'aria-live': 'off', 'aria-label': t.dialogLabel, tabindex: '0' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });

  const composer = h('form', { class: 'composer', novalidate: '' });
  const field = h('div', { class: 'field' });
  const input = h('textarea', {
    class: 'input',
    rows: '1',
    maxlength: String(MAX_LEN),
    placeholder: t.placeholder,
    'aria-label': t.inputLabel,
    enterkeyhint: 'send',
    autocomplete: 'off',
  });
  const sendBtn = h('button', { type: 'submit', class: 'send', 'aria-label': t.send, title: t.send }, icons.send);
  field.append(input, sendBtn);
  const meta = h('div', { class: 'meta' });
  const disclaimer = h('p', { class: 'disclaimer' });
  disclaimer.textContent = t.disclaimer;
  const counter = h('span', { class: 'counter', 'aria-live': 'polite' });
  meta.append(disclaimer, counter);
  composer.append(field, meta);

  panel.append(header, log, composer, live);
  root.append(launcher, panel);

  /* ── persistence ── */
  const persist = () => save(key, { sessionId, messages, open: isOpen, unread });

  /* ── rendering ── */
  const nodes = new Map<string, HTMLElement>();
  let welcomeRow: HTMLElement | null = null;

  function renderWelcome() {
    welcomeRow = h('div', { class: 'row assistant' });
    const b = h('div', { class: 'bubble md' });
    b.textContent = t.welcome;
    welcomeRow.append(b);
    if (!messages.length) {
      const chips = h('div', { class: 'chips' });
      for (const c of t.chips) {
        const chip = h('button', { type: 'button', class: 'chip' });
        chip.textContent = c;
        chip.addEventListener('click', () => ask(c));
        chips.append(chip);
      }
      welcomeRow.append(chips);
    }
    log.append(welcomeRow);
  }

  function scrollToEnd(force = false) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (force || nearBottom) log.scrollTop = log.scrollHeight;
  }

  function productCard(p: Product): HTMLElement {
    const url = safeUrl(p.url);
    const card = h('article', { class: 'card' });
    const thumb = h('div', { class: 'thumb' });
    const img = safeUrl(p.image_url);
    if (img) {
      const el = h('img', { src: img, alt: '', loading: 'lazy', decoding: 'async', width: '72', height: '72' });
      el.addEventListener('error', () => {
        thumb.innerHTML = icons.box;
      });
      thumb.append(el);
    } else thumb.innerHTML = icons.box;

    const body = h('div');
    const name = url ? h('a', { class: 'pname', href: url }) : h('span', { class: 'pname' });
    name.textContent = p.name || '';
    if (url) setLinkTarget(name as HTMLAnchorElement);
    body.append(name);

    const metaBits = [p.sku ? `${t.sku} ${p.sku}` : '', p.brand || ''].filter(Boolean);
    if (metaBits.length) {
      const m = h('div', { class: 'pmeta' });
      m.textContent = metaBits.join(' · ');
      body.append(m);
    }

    const prices = h('div', { class: 'prices' });
    const site = money(p.price_site);
    const store = money(p.price_store);
    const priceEl = (cls: string, label: string, value: string) => {
      const s = h('span', { class: `price ${cls}` });
      s.append(label + ' ');
      const b = h('b');
      b.textContent = value;
      s.append(b);
      return s;
    };
    if (site) prices.append(priceEl('site', t.priceSite, site));
    if (store) prices.append(priceEl('store', t.priceStore, store));
    if (!site && !store) {
      const s = h('span', { class: 'price' });
      s.textContent = t.priceOnRequest;
      prices.append(s);
    }
    body.append(prices);

    if (url) {
      const open = h('a', { class: 'open', href: url }, `<span></span>${icons.external}`);
      (open.firstChild as HTMLElement).textContent = t.openOnSite;
      setLinkTarget(open);
      if (p.name) open.setAttribute('aria-label', `${t.openOnSite}: ${p.name}`);
      body.append(open);
    }
    card.append(thumb, body);
    return card;
  }

  function feedbackRow(m: Msg): HTMLElement {
    const row = h('div', { class: 'fb' });
    const up = h('button', { type: 'button', class: 'fbtn', 'aria-label': t.helpful, title: t.helpful }, icons.up);
    const down = h('button', { type: 'button', class: 'fbtn', 'aria-label': t.notHelpful, title: t.notHelpful }, icons.down);
    const note = h('span', { class: 'fbnote', role: 'status' });
    row.append(up, down, note);

    const setRated = (r: 1 | -1 | undefined) => {
      up.setAttribute('aria-pressed', String(r === 1));
      down.setAttribute('aria-pressed', String(r === -1));
      up.disabled = down.disabled = r !== undefined;
    };
    setRated(m.rating);
    if (m.rating) note.textContent = t.thanks;

    const submit = async (rating: 1 | -1, comment?: string) => {
      m.rating = rating;
      setRated(rating);
      note.textContent = t.thanks;
      persist();
      try {
        const res = await fetch(`${cfg.api}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, message_id: m.messageId, rating, comment: comment || undefined }),
        });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        m.rating = undefined;
        setRated(undefined);
        note.textContent = t.feedbackFailed;
        persist();
      }
    };

    up.addEventListener('click', () => submit(1));
    down.addEventListener('click', () => {
      setRated(-1);
      const form = h('form', { class: 'fbform' });
      const fid = `fb-${m.id}`;
      const label = h('label', { for: fid });
      label.textContent = t.whatWrong;
      const ta = h('textarea', { id: fid, maxlength: '500', rows: '2', placeholder: t.whatWrongPlaceholder });
      const actions = h('div', { class: 'fbactions' });
      const ok = h('button', { type: 'submit', class: 'btn' });
      ok.textContent = t.submit;
      const skip = h('button', { type: 'button', class: 'btn ghost' });
      skip.textContent = t.skip;
      actions.append(ok, skip);
      form.append(label, ta, actions);
      const done = (comment?: string) => {
        form.remove();
        down.focus();
        submit(-1, comment);
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        done(ta.value.trim());
      });
      skip.addEventListener('click', () => done());
      row.after(form);
      ta.focus();
      scrollToEnd();
    });
    return row;
  }

  function renderMsg(m: Msg, animate = false): HTMLElement {
    let row = nodes.get(m.id);
    const fresh = !row;
    if (!row) {
      row = h('div', { class: `row ${m.role}${animate ? ' enter' : ''}` });
      const who = h('span', { class: 'sr-only' });
      who.textContent = (m.role === 'user' ? t.you : t.assistant) + ':';
      row.append(who);
      nodes.set(m.id, row);
      log.append(row);
    }
    if (m.role === 'user') {
      if (fresh) {
        const b = h('div', { class: 'bubble' });
        b.textContent = m.text;
        row.append(b);
      }
      return row;
    }
    // Assistant: rebuild everything after the sr-only label (cheap, messages are short).
    while (row.childNodes.length > 1) row.removeChild(row.lastChild as Node);

    if (m.status === 'error') {
      const b = h('div', { class: 'bubble err' });
      if (m.text) {
        const partial = h('div', { class: 'md' }, renderMarkdown(m.text));
        partial.style.marginBottom = '8px';
        b.append(partial);
      }
      const head = h('div', { class: 'errhead' }, icons.alert);
      const msg = h('span');
      msg.textContent = m.error || t.errorInterrupted;
      head.append(msg);
      const retry = h('button', { type: 'button', class: 'btn retry' }, `${icons.retry}<span></span>`);
      (retry.lastChild as HTMLElement).textContent = t.retry;
      retry.addEventListener('click', () => retryFrom(m));
      b.append(head, retry);
      row.append(b);
      return row;
    }

    const bubble = h('div', { class: 'bubble md' }, renderMarkdown(m.text));
    bubble.querySelectorAll('a').forEach(setLinkTarget);
    row.append(bubble);

    if (m.status === 'streaming' && statusLabel !== null) {
      const st = h('div', { class: 'status' }, '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span></span>');
      (st.lastChild as HTMLElement).textContent = statusLabel || t.thinking;
      row.append(st);
    }
    if (m.products && m.products.length) {
      const list = h('div', { class: 'products' });
      for (const p of m.products.slice(0, 8)) if (p && p.name) list.append(productCard(p));
      row.append(list);
    }
    if (m.status === 'stopped') {
      const n = h('div', { class: 'note' });
      n.textContent = t.stopped;
      row.append(n);
    }
    if (m.status === 'done' && m.messageId !== undefined && m.messageId !== null && sessionId) row.append(feedbackRow(m));
    return row;
  }

  function renderAll() {
    log.textContent = '';
    nodes.clear();
    renderWelcome();
    for (const m of messages) renderMsg(m);
  }

  /* ── streaming ── */
  let statusLabel: string | null = null; // null → hide indicator
  let raf = 0;
  const scheduleRender = (m: Msg) => {
    if (raf || !nodes.has(m.id)) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderMsg(m);
      scrollToEnd();
    });
  };

  function setBusy(on: boolean) {
    streaming = on;
    input.readOnly = on;
    input.setAttribute('aria-busy', String(on));
    field.classList.toggle('busy', on);
    sendBtn.classList.toggle('stop', on);
    sendBtn.innerHTML = on ? icons.stop : icons.send;
    sendBtn.setAttribute('aria-label', on ? t.stop : t.send);
    sendBtn.title = on ? t.stop : t.send;
    sendBtn.type = on ? 'button' : 'submit';
    updateComposer();
  }

  function updateComposer() {
    const len = input.value.length;
    sendBtn.disabled = !streaming && !input.value.trim();
    counter.textContent = len > MAX_LEN - 200 ? `${len} / ${MAX_LEN}` : '';
    counter.classList.toggle('over', len >= MAX_LEN);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  }

  function announce(text: string) {
    live.textContent = '';
    window.setTimeout(() => {
      live.textContent = text.length > 600 ? text.slice(0, 600) + '…' : text;
    }, 50);
  }

  async function send(text: string, isRetry = false) {
    text = text.trim().slice(0, MAX_LEN);
    if (!text || streaming) return;
    if (welcomeRow) welcomeRow.querySelector('.chips')?.remove();

    if (!isRetry) {
      const um: Msg = { id: uid(), role: 'user', text };
      messages.push(um);
      renderMsg(um, true);
    }
    const am: Msg = { id: uid(), role: 'assistant', text: '', status: 'streaming' };
    messages.push(am);
    statusLabel = '';
    renderMsg(am, true);
    scrollToEnd(true);
    announce(t.thinking);
    setBusy(true);
    persist();

    const ctrl = new AbortController();
    const myGen = gen;
    controller = ctrl;
    try {
      const res = await fetch(cfg.api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          session_id: sessionId,
          message: text,
          page_url: location.href.slice(0, 1000),
          city: cfg.city,
        }),
        signal: ctrl.signal,
      });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !res.body || !/event-stream/i.test(type)) {
        let msg = '';
        try {
          const j = await res.json();
          msg = typeof j?.error === 'string' ? j.error : typeof j?.message === 'string' ? j.message : '';
        } catch {
          /* not JSON */
        }
        throw new Error(msg || t.errorGeneric);
      }
      await readSSE(res.body, (ev) => {
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (ev.event) {
          case 'session':
            if (typeof data?.session_id === 'string') sessionId = data.session_id;
            break;
          case 'status':
            statusLabel = typeof data?.label === 'string' ? data.label : '';
            scheduleRender(am);
            break;
          case 'delta':
            if (typeof data?.text === 'string') {
              am.text += data.text;
              statusLabel = null;
              scheduleRender(am);
            }
            break;
          case 'products':
            if (Array.isArray(data?.items)) {
              am.products = data.items;
              scheduleRender(am);
            }
            break;
          case 'done':
            am.messageId = data?.message_id;
            am.status = 'done';
            break;
          case 'error':
            am.status = 'error';
            am.error = typeof data?.message === 'string' && data.message ? data.message : t.errorGeneric;
            break;
        }
      });
      if (am.status === 'streaming') {
        if (am.text) am.status = 'done';
        else throw new Error(t.errorInterrupted);
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        am.status = 'stopped';
      } else {
        am.status = 'error';
        am.error = navigator.onLine === false ? t.errorOffline : (e as Error)?.message && !(e instanceof TypeError) ? (e as Error).message : t.errorGeneric;
      }
    } finally {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      statusLabel = null;
      if (controller === ctrl) controller = null;
      if (myGen !== gen) {
        setBusy(false);
        return;
      }
      if (am.status === 'stopped' && !am.text && !am.products?.length) {
        // Nothing arrived: drop the empty reply entirely.
        messages = messages.filter((x) => x !== am);
        nodes.get(am.id)?.remove();
        nodes.delete(am.id);
      } else {
        renderMsg(am);
      }
      scrollToEnd();
      setBusy(false);
      if (!isOpen && am.status !== 'stopped') unread = true;
      launcher.classList.toggle('unread', unread);
      persist();
      if (am.status === 'error') announce(am.error || t.errorGeneric);
      else if (am.status === 'done') {
        const node = nodes.get(am.id)?.querySelector('.bubble');
        announce(`${t.assistant}: ${node?.textContent || ''}`);
      }
      if (isOpen && shadow.activeElement === sendBtn) input.focus();
      if (queued) {
        const q = queued;
        queued = null;
        send(q);
      }
    }
  }

  function retryFrom(m: Msg) {
    if (streaming) return;
    const idx = messages.indexOf(m);
    let q = '';
    for (let i = idx - 1; i >= 0; i--)
      if (messages[i].role === 'user') {
        q = messages[i].text;
        break;
      }
    messages = messages.filter((x) => x !== m);
    nodes.get(m.id)?.remove();
    nodes.delete(m.id);
    if (q) send(q, true);
    input.focus();
  }

  function stop() {
    controller?.abort();
  }

  function newChat() {
    gen++;
    queued = null;
    stop();
    setBusy(false);
    messages = [];
    sessionId = undefined;
    unread = false;
    clear(key);
    renderAll();
    input.value = '';
    updateComposer();
    input.focus();
    persist();
  }

  /* ── open / close / focus ── */
  let savedOverflow: string | null = null;
  function lockScroll(on: boolean) {
    const el = document.documentElement;
    if (on && mq.matches && savedOverflow === null) {
      savedOverflow = el.style.overflow;
      el.style.overflow = 'hidden';
    } else if (!on && savedOverflow !== null) {
      el.style.overflow = savedOverflow;
      savedOverflow = null;
    }
  }

  function fitViewport() {
    const vv = window.visualViewport;
    if (isOpen && mq.matches && vv) {
      panel.style.height = `${vv.height}px`;
      panel.style.top = `${vv.offsetTop}px`;
    } else {
      panel.style.height = '';
      panel.style.top = '';
    }
  }

  function open(focus = true) {
    if (isOpen) return;
    isOpen = true;
    unread = false;
    root.classList.add('is-open');
    launcher.classList.remove('unread');
    launcher.setAttribute('aria-expanded', 'true');
    if (mq.matches) panel.setAttribute('aria-modal', 'true');
    else panel.removeAttribute('aria-modal');
    lockScroll(true);
    fitViewport();
    scrollToEnd(true);
    if (focus) window.setTimeout(() => input.focus({ preventScroll: true }), 30);
    persist();
  }

  function close() {
    if (!isOpen) return;
    const hadFocus = !!shadow.activeElement;
    isOpen = false;
    root.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');
    lockScroll(false);
    fitViewport();
    if (hadFocus) launcher.focus();
    persist();
  }

  function ask(text: string) {
    open();
    if (typeof text !== 'string' || !text.trim()) return;
    if (streaming) {
      queued = text;
      stop();
    } else send(text);
  }

  function focusables(): HTMLElement[] {
    return Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), [tabindex="0"]'),
    ).filter((el) => el.offsetParent !== null || el === input);
  }

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = shadow.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !active || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !active || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });

  /* ── events ── */
  launcher.addEventListener('click', () => open());
  closeBtn.addEventListener('click', close);
  newBtn.addEventListener('click', newChat);
  input.addEventListener('input', updateComposer);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!streaming) composer.requestSubmit ? composer.requestSubmit() : submitComposer();
    }
  });
  const submitComposer = () => {
    const text = input.value;
    if (!text.trim() || streaming) return;
    input.value = '';
    updateComposer();
    send(text);
  };
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    submitComposer();
  });
  sendBtn.addEventListener('click', (e) => {
    if (streaming) {
      e.preventDefault();
      stop();
    }
  });
  const onMq = () => {
    if (isOpen) {
      lockScroll(false);
      lockScroll(true);
      if (mq.matches) panel.setAttribute('aria-modal', 'true');
      else panel.removeAttribute('aria-modal');
    }
    fitViewport();
  };
  if (mq.addEventListener) mq.addEventListener('change', onMq);
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.addEventListener('pagehide', persist);

  /* ── boot ── */
  document.body.appendChild(host);
  renderAll();
  updateComposer();
  launcher.classList.toggle('unread', unread);
  // Re-open after navigation on desktop only: on phones the panel would cover the page the user just opened.
  if (cfg.open || (saved?.open && !mq.matches)) open(false);

  return {
    open: () => open(),
    close,
    ask,
  };
}

function boot() {
  if (window.EKTConsultant) return;
  const cfg = readConfig();
  if (!cfg) return;
  const start = () => {
    if (window.EKTConsultant) return;
    window.EKTConsultant = mount(cfg);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

boot();
