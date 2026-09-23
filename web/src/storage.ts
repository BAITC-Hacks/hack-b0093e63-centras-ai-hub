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
