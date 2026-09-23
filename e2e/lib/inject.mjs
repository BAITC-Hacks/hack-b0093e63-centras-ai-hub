// Injects the widget bundle into a real ekt.kz page exactly the way extension/content.js does
// (a plain <script data-api=… data-lang=…> appended to document.body, main world, survives every
// same-tab navigation because the widget itself persists its chat in localStorage).
//
// extension/content.js sets `.src = chrome.runtime.getURL('widget.js')`. A `chrome-extension://`
// URL isn't available outside a loaded extension, so the natural e2e substitute is an http(s) URL —
// but Chrome's Private Network Access blocks a public https://ekt.kz page from loading a script
// from a loopback address (http://127.0.0.1), even headless, with no way to grant the permission
// non-interactively. So instead we read web/public/widget.js from disk once and inject it as an
// INLINE classic script (`script.text = source`) with the same data-* attributes: functionally
// identical (widget.ts reads config from `document.currentScript.dataset`, which is set correctly
// for an inline script appended via appendChild, exactly as for an external one).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cachedSource;
export function widgetSource(repoRoot) {
  if (!cachedSource) cachedSource = readFileSync(resolve(repoRoot, 'web/public/widget.js'), 'utf8');
  return cachedSource;
}

/** Registers an addInitScript that injects the widget on every document load in this context. */
export async function installWidget(context, { source, api, lang = 'ru' }) {
  await context.addInitScript(
    ({ source, api, lang }) => {
      function attach() {
        if (document.querySelector('script[data-api][src*="widget"]')) return;
        if (window.EKTConsultant) return;
        const s = document.createElement('script');
        s.setAttribute('data-api', api);
        s.setAttribute('data-lang', lang);
        s.text = source;
        (document.body || document.documentElement).appendChild(s);
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach, { once: true });
      else attach();
    },
    { source, api, lang },
  );
}

/** Waits until window.EKTConsultant is mounted (the widget's boot() ran). */
export async function waitWidgetMounted(page, timeoutMs = 15_000) {
  await page.waitForFunction(() => typeof window.EKTConsultant?.ask === 'function', { timeout: timeoutMs });
}

/** Sends a question through the widget's public JS API (same call the real page could make). */
export async function ask(page, text) {
  await page.evaluate((t) => window.EKTConsultant.ask(t), text);
}

/**
 * Waits for the last assistant reply to leave "streaming" (done / error / stopped): the widget
 * removes the `.status` "thinking…" node from the row once the SSE stream settles.
 */
export async function waitAssistantSettled(page, timeoutMs = 60_000) {
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-ekt-consultant]');
      const root = host && host.shadowRoot;
      const rows = root ? root.querySelectorAll('.row.assistant') : [];
      const last = rows[rows.length - 1];
      // The widget marks the reply row aria-busy="true" until the stream ends (the «thinking» dots
      // vanish with the first text chunk, long before products/actions arrive).
      return !!last && !last.querySelector('.status') && last.getAttribute('aria-busy') !== 'true';
    },
    { timeout: timeoutMs },
  );
}

/** Text of the last assistant bubble (markdown-rendered), or '' if none. */
export async function lastAssistantText(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-ekt-consultant]');
    const root = host && host.shadowRoot;
    const rows = root ? root.querySelectorAll('.row.assistant') : [];
    const last = rows[rows.length - 1];
    return last?.querySelector('.bubble')?.textContent || '';
  });
}

/**
 * href of every <a> rendered for the last assistant reply: markdown links inside `.bubble` AND
 * the product-card links in the sibling `.products` list (widget.ts productCard()) — a reply that
 * names a product via the `products` SSE event, not inline markdown, still counts as "has a link".
 */
export async function lastAssistantLinks(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-ekt-consultant]');
    const root = host && host.shadowRoot;
    const rows = root ? root.querySelectorAll('.row.assistant') : [];
    const last = rows[rows.length - 1];
    return Array.from(last?.querySelectorAll('.bubble a[href], .products a[href]') || []).map((a) => a.getAttribute('href') || '');
  });
}

/** True if the SSE `action` overlay (rings/notes/plate) currently shows a highlight ring. */
export async function overlayHasVisibleRing(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-ekt-overlay]');
    const root = host && host.shadowRoot;
    if (!root) return false;
    const ring = root.querySelector('.ring');
    if (!ring) return false;
    const s = getComputedStyle(ring);
    return s.display !== 'none' && ring.getBoundingClientRect().width > 0;
  });
}

/** Waits (briefly) for the overlay plate («label · Отмена») to appear, then disappear — a `click`/`fill`/`navigate` action ran. */
export async function waitPlateCycle(page, { appearMs = 6000, vanishMs = 6000 } = {}) {
  const appeared = await page
    .waitForFunction(
      () => {
        const host = document.querySelector('[data-ekt-overlay]');
        const root = host && host.shadowRoot;
        return !!root?.querySelector('.plate');
      },
      { timeout: appearMs },
    )
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;
  await page
    .waitForFunction(
      () => {
        const host = document.querySelector('[data-ekt-overlay]');
        const root = host && host.shadowRoot;
        return !root?.querySelector('.plate');
      },
      { timeout: vanishMs },
    )
    .catch(() => {});
  return true;
}
