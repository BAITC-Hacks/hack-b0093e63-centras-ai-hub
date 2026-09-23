/** Conversation persistence across page navigations (localStorage, fail-safe). */

export interface Product {
  id: string | number;
  name: string;
  url?: string | null;
  sku?: string | null;
  brand?: string | null;
  price_site?: number | null;
  price_store?: number | null;
  image_url?: string | null;
}

export type MsgStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: MsgStatus;
  products?: Product[];
  messageId?: string | number;
  rating?: 1 | -1;
  error?: string;
  /** Quick-reply options offered with this reply (shown only while it is the last message). */
  suggest?: string[];
}

export interface Saved {
  v: 1;
  sessionId?: string;
  updatedAt: number;
  open?: boolean;
  unread?: boolean;
  messages: Msg[];
}

export const TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MESSAGES = 30;

export function storageKey(api: string): string {
  // Different backends (staging/prod) must not share a session id.
  let h = 0;
  for (let i = 0; i < api.length; i++) h = (Math.imul(31, h) + api.charCodeAt(i)) | 0;
  return `ekt-consultant:v1:${(h >>> 0).toString(36)}`;
}

export function load(key: string, now = Date.now()): Saved | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as Saved;
    if (!data || data.v !== 1 || !Array.isArray(data.messages)) return null;
    if (typeof data.updatedAt !== 'number' || now - data.updatedAt > TTL_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function save(key: string, data: Omit<Saved, 'v' | 'updatedAt'>, now = Date.now()): void {
  const messages = data.messages
    .slice(-MAX_MESSAGES)
    // A reply still streaming when the page goes away is kept as "stopped".
    .map((m) => (m.status === 'streaming' ? { ...m, status: (m.text ? 'stopped' : 'error') as MsgStatus } : m))
    .filter((m) => m.role === 'user' || m.text || m.status === 'error' || m.products?.length);
  const payload: Saved = { v: 1, updatedAt: now, ...data, messages };
  try {
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage blocked: try once without product payloads, then give up.
    try {
      payload.messages = messages.map((m) => ({ ...m, products: undefined }));
      window.localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      /* storage unavailable — the chat still works for this page view */
    }
  }
}

export function clear(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ── deferred UI actions (survive a same-tab navigation) ── */

export const PENDING_KEY = 'ekt-consultant:pending';
export const PENDING_TTL_MS = 30 * 1000;

export interface Pending<T = unknown> {
  v: 1;
  at: number;
  /** Normalized path+query of the page the actions are meant for. */
  page: string;
  actions: T[];
}

/** sessionStorage is per tab — exactly the scope of a same-window navigation. */
function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function savePending<T>(page: string, actions: T[], now = Date.now()): void {
  try {
    const payload: Pending<T> = { v: 1, at: now, page, actions };
    session()?.setItem(PENDING_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable — deferred actions are simply lost */
  }
}

/** Read and remove the queue. Returns actions only if they are fresh and meant for `page`. */
export function takePending<T>(page: string, now = Date.now()): T[] {
  const s = session();
  try {
    const raw = s?.getItem(PENDING_KEY);
    if (!raw) return [];
    s!.removeItem(PENDING_KEY);
    const data = JSON.parse(raw) as Pending<T>;
    if (!data || data.v !== 1 || !Array.isArray(data.actions)) return [];
    if (now - data.at > PENDING_TTL_MS || data.page !== page) return [];
    return data.actions;
  } catch {
    return [];
  }
}

export function clearPending(): void {
  try {
    session()?.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}
