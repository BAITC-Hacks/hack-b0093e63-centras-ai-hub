export const USER_AGENT = 'EKT-Consultant-Bot/1.0 (+https://ekt.kz)';
// сайт отвечает медленно (TTFB 7–30 с), таймаут 60 с, настраивается SCRAPER_TIMEOUT_MS
const timeoutMs = () => (Number(process.env.SCRAPER_TIMEOUT_MS) > 0 ? Number(process.env.SCRAPER_TIMEOUT_MS) : 60_000);
const RETRIES = 3;

export interface FetchResult {
  url: string; // итоговый URL после редиректов
  status: number;
  body: string;
  error?: string;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** GET с таймаутом и повторами (5xx/429/сетевые ошибки, экспоненциальная пауза). Не бросает исключений. */
export async function fetchText(
  url: string,
  opts: { headers?: Record<string, string>; retries?: number } = {},
): Promise<FetchResult> {
  const retries = opts.retries ?? RETRIES;
  let last: FetchResult = { url, status: 0, body: '', error: 'not started' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          ...opts.headers,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs()),
      });
      const body = await res.text();
      last = { url: res.url || url, status: res.status, body };
      if (!isRetryable(res.status)) return last;
      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt < retries) {
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : backoff(attempt));
      }
    } catch (e) {
      last = { url, status: 0, body: '', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      if (attempt < retries) await sleep(backoff(attempt));
    }
  }
  return last;
}

function backoff(attempt: number): number {
  return 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
}

/**
 * Пул воркеров: concurrency параллельных обработчиков, пауза delayMs после каждого запроса
 * в каждом воркере.
 */
export async function runPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: { concurrency: number; delayMs: number },
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
      if (opts.delayMs > 0) await sleep(opts.delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, run));
}

export function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
