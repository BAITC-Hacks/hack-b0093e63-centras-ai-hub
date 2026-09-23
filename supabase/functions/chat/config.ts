// Конфигурация Edge Function `chat` из переменных окружения.

export interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  openaiApiKey: string;
  /** Базовый URL OpenAI-совместимого API (по умолчанию https://api.openai.com/v1). */
  openaiBaseUrl: string;
  openaiModel: string;
  embeddingModel: string;
  /** Список разрешённых Origin; ["*"] — любой (только для разработки). */
  allowedOrigins: string[];
  /** Лимит токенов ответа на один раунд (max_completion_tokens). */
  maxCompletionTokens: number;
}

export const LIMITS = {
  messageMaxChars: 2000,
  historyMessages: 12,
  maxToolRounds: 5,
  perSessionPerMinute: 20,
  perIpPerMinute: 60,
  openaiTimeoutMs: 60_000,
  maxProductCards: 6,
  maxLeadsPerSession: 3,
} as const;

/** Телефон Алматы — используется в сообщениях об ошибках и в системном промпте. */
export const FALLBACK_PHONE = "+7 (727) 346-88-88";

function env(name: string, fallback = ""): string {
  const v = Deno.env.get(name);
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    supabaseUrl: env("SUPABASE_URL"),
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    openaiApiKey: env("OPENAI_API_KEY"),
    openaiBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    openaiModel: env("OPENAI_MODEL", "gpt-4.1-mini"),
    embeddingModel: env("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    allowedOrigins: parseOrigins(env("ALLOWED_ORIGINS", "*")),
    maxCompletionTokens: Number(env("OPENAI_MAX_COMPLETION_TOKENS", "3000")) || 3000,
  };
  return cached;
}

export function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}
