// HTTP-утилиты: CORS, JSON-ответы, валидация входных данных.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> | null {
  const base = {
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
    "access-control-max-age": "86400",
  };
  if (allowed.includes("*")) return { ...base, "access-control-allow-origin": "*" };
  // Запросы без Origin (серверные, curl, eval) CORS не касается.
  if (!origin) return {};
  if (allowed.includes(origin.replace(/\/+$/, ""))) {
    return { ...base, "access-control-allow-origin": origin, vary: "Origin" };
  }
  return null; // Origin не разрешён
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const optStr = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
};

export function parseChatBody(body: unknown, maxChars: number): Parsed<{
  session_id?: string;
  message: string;
  page_url?: string;
  city?: string;
}> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "JSON object expected" };
  const b = body as Record<string, unknown>;
  if (typeof b.message !== "string") return { ok: false, error: "message must be a string" };
  const message = b.message.trim();
  if (message.length < 1) return { ok: false, error: "message is empty" };
  if (message.length > maxChars) return { ok: false, error: `message is longer than ${maxChars} characters` };
  let session_id: string | undefined;
  if (b.session_id !== undefined && b.session_id !== null && b.session_id !== "") {
    if (typeof b.session_id !== "string" || !UUID_RE.test(b.session_id)) {
      return { ok: false, error: "session_id must be a UUID" };
    }
    session_id = b.session_id.toLowerCase();
  }
  if (b.page_url !== undefined && b.page_url !== null && typeof b.page_url !== "string") {
    return { ok: false, error: "page_url must be a string" };
  }
  if (b.city !== undefined && b.city !== null && typeof b.city !== "string") {
    return { ok: false, error: "city must be a string" };
  }
  return {
    ok: true,
    value: { session_id, message, page_url: optStr(b.page_url, 500), city: optStr(b.city, 100) },
  };
}

export function parseFeedbackBody(body: unknown): Parsed<{
  session_id: string;
  message_id: number;
  rating: 1 | -1;
  comment?: string;
}> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "JSON object expected" };
  const b = body as Record<string, unknown>;
  if (typeof b.session_id !== "string" || !UUID_RE.test(b.session_id)) {
    return { ok: false, error: "session_id must be a UUID" };
  }
  const mid = typeof b.message_id === "string" ? Number(b.message_id) : b.message_id;
  if (typeof mid !== "number" || !Number.isSafeInteger(mid) || mid <= 0) {
    return { ok: false, error: "message_id must be a positive integer" };
  }
  if (b.rating !== 1 && b.rating !== -1) return { ok: false, error: "rating must be 1 or -1" };
  if (b.comment !== undefined && b.comment !== null && typeof b.comment !== "string") {
    return { ok: false, error: "comment must be a string" };
  }
  return {
    ok: true,
    value: {
      session_id: b.session_id.toLowerCase(),
      message_id: mid,
      rating: b.rating,
      comment: optStr(b.comment, 1000),
    },
  };
}

/** Путь внутри функции: `/chat/feedback`, `/functions/v1/chat/feedback` → `/feedback`. */
export function routeOf(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  const i = path.indexOf("/chat");
  const rest = i === -1 ? path : path.slice(i + "/chat".length);
  return rest || "/";
}
