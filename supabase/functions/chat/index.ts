// Edge Function `chat` — AI-консультант ekt.kz.
// POST /chat            — диалог (SSE)
// POST /chat/feedback   — оценка ответа
// GET  /chat/health     — проверка работоспособности

import { LIMITS, loadConfig } from "./config.ts";
import { runChat } from "./chat.ts";
import { clientIp, getDb } from "./db.ts";
import { corsHeaders, json, parseChatBody, parseFeedbackBody, routeOf } from "./http.ts";
import { createSSEStream } from "./sse.ts";

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 20_000) throw new Error("body too large");
  return JSON.parse(text);
}

async function handleFeedback(req: Request, cors: Record<string, string>): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return json(400, { error: "invalid JSON" }, cors);
  }
  const p = parseFeedbackBody(body);
  if (!p.ok) return json(400, { error: p.error }, cors);
  const { session_id, message_id, rating, comment } = p.value;
  try {
    const db = getDb(loadConfig());
    const { data: msg, error } = await db
      .from("chat_messages")
      .select("id")
      .eq("id", message_id)
      .eq("session_id", session_id)
      .eq("role", "assistant")
      .maybeSingle();
    if (error) throw error;
    if (!msg) return json(404, { error: "message not found" }, cors);
    const { error: upErr } = await db
      .from("feedback")
      .upsert({ message_id, session_id, rating, comment: comment ?? null }, { onConflict: "message_id" });
    if (upErr) throw upErr;
    return json(200, { ok: true }, cors);
  } catch (e) {
    console.error("feedback failed", e);
    return json(500, { error: "internal error" }, cors);
  }
}

async function handleHealth(cors: Record<string, string>): Promise<Response> {
  const cfg = loadConfig();
  let dbOk = false;
  try {
    const { error } = await getDb(cfg).from("branches").select("city_slug", { head: true, count: "exact" });
    dbOk = !error;
  } catch { /* dbOk = false */ }
  return json(dbOk ? 200 : 503, {
    ok: dbOk,
    db: dbOk,
    openai_key: Boolean(cfg.openaiApiKey),
    model: cfg.openaiModel,
    time: new Date().toISOString(),
  }, cors);
}

Deno.serve(async (req) => {
  const cfg = loadConfig();
  const cors = corsHeaders(req.headers.get("origin"), cfg.allowedOrigins);
  if (cors === null) return json(403, { error: "origin not allowed" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const route = routeOf(req.url);

  if (req.method === "GET" && route === "/health") return await handleHealth(cors);
  if (req.method === "POST" && route === "/feedback") return await handleFeedback(req, cors);
  if (req.method === "POST" && route === "/") {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return json(400, { error: "invalid JSON" }, cors);
    }
    const p = parseChatBody(body, LIMITS.messageMaxChars);
    if (!p.ok) return json(400, { error: p.error }, cors);
    const meta = { ip: clientIp(req), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null };
    const stream = createSSEStream((w) => runChat(w, cfg, p.value, meta));
    return new Response(stream, {
      headers: {
        ...cors,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }
  return json(404, { error: "not found" }, cors);
});
