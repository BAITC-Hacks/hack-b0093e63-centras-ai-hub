// Rate-limit по числу сообщений пользователя за минуту (RPC recent_message_counts).

import { LIMITS } from "./config.ts";
import type { Db } from "./db.ts";

export interface RateLimitResult {
  ok: boolean;
  bySession: number;
  byIp: number;
}

export function evaluateLimits(bySession: number, byIp: number): RateLimitResult {
  return {
    ok: bySession < LIMITS.perSessionPerMinute && byIp < LIMITS.perIpPerMinute,
    bySession,
    byIp,
  };
}

export async function checkRateLimit(
  db: Db,
  sessionId: string,
  ipHash: string,
): Promise<RateLimitResult> {
  const { data, error } = await db.rpc("recent_message_counts", {
    p_session: sessionId,
    p_ip_hash: ipHash,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { by_session: number; by_ip: number }
    | undefined;
  return evaluateLimits(row?.by_session ?? 0, row?.by_ip ?? 0);
}

export const RATE_LIMIT_MESSAGE =
  "Вы отправляете сообщения слишком часто. Пожалуйста, подождите минуту и попробуйте снова.";
