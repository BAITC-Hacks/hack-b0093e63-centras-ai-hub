// Доступ к Supabase (service role): сессии, сообщения, обратная связь.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Config } from "./config.ts";

export type Db = SupabaseClient;

let client: Db | null = null;

export function getDb(cfg: Config): Db {
  if (!client) {
    if (!cfg.supabaseUrl || !cfg.serviceRoleKey) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
    }
    client = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? req.headers.get("cf-connecting-ip") ?? "unknown";
}

export interface SessionRow {
  id: string;
  message_count: number;
}

export interface SessionMeta {
  ipHash: string;
  userAgent: string | null;
  pageUrl: string | null;
  city: string | null;
}

/** Загружает сессию по id или создаёт новую (неизвестный id → новая сессия с новым id). */
export async function loadOrCreateSession(
  db: Db,
  sessionId: string | undefined,
  meta: SessionMeta,
): Promise<SessionRow> {
  if (sessionId) {
    const { data, error } = await db
      .from("chat_sessions")
      .select("id, message_count")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as SessionRow;
  }
  const { data, error } = await db
    .from("chat_sessions")
    .insert({
      ip_hash: meta.ipHash,
      user_agent: meta.userAgent,
      page_url: meta.pageUrl,
      city: meta.city,
    })
    .select("id, message_count")
    .single();
  if (error) throw error;
  return data as SessionRow;
}

export async function touchSession(
  db: Db,
  sessionId: string,
  messageCount: number,
  meta: Pick<SessionMeta, "pageUrl" | "city">,
): Promise<void> {
  const patch: Record<string, unknown> = {
    last_seen_at: new Date().toISOString(),
    message_count: messageCount,
  };
  if (meta.pageUrl) patch.page_url = meta.pageUrl;
  if (meta.city) patch.city = meta.city;
  const { error } = await db.from("chat_sessions").update(patch).eq("id", sessionId);
  if (error) console.error("touchSession", error);
}

export interface HistoryRow {
  role: "user" | "assistant";
  content: string;
  tool_results: unknown;
}

/** Последние N сообщений сессии в хронологическом порядке. */
export async function loadHistory(db: Db, sessionId: string, limit: number): Promise<HistoryRow[]> {
  const { data, error } = await db
    .from("chat_messages")
    .select("role, content, tool_results, id")
    .eq("session_id", sessionId)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as HistoryRow[]).reverse();
}

export interface MessageInsert {
  session_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls?: unknown;
  tool_results?: unknown;
  model?: string;
  tokens_in?: number | null;
  tokens_out?: number | null;
  latency_ms?: number;
  flags?: Record<string, unknown>;
  ip_hash?: string;
}

export async function insertMessage(db: Db, row: MessageInsert): Promise<number> {
  const { data, error } = await db.from("chat_messages").insert(row).select("id").single();
  if (error) throw error;
  return (data as { id: number }).id;
}
