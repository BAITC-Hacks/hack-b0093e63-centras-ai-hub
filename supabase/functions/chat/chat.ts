// POST /chat: сессия → rate-limit → история → цикл инструментов со стримингом → проверка → сохранение.

import { type Config, FALLBACK_PHONE, LIMITS } from "./config.ts";
import {
  type Db,
  getDb,
  type HistoryRow,
  insertMessage,
  loadHistory,
  loadOrCreateSession,
  sha256Hex,
  touchSession,
} from "./db.ts";
import { type ChatMessage, embed, streamChat, type Usage } from "./openai.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { checkRateLimit, RATE_LIMIT_MESSAGE } from "./ratelimit.ts";
import type { SSEWriter } from "./sse.ts";
import { compactOutcome, executeTool, type ProductCard, TOOL_DEFS, TOOL_LABELS, type ToolOutcome } from "./tools.ts";
import { collectKnownUrls, collectTurnActions, type UiAction } from "./ui_actions.ts";
import { pickMentionedProducts, validateAnswer } from "./validate.ts";

export interface ChatRequest {
  session_id?: string;
  message: string;
  page_url?: string;
  city?: string;
}

export interface RequestMeta {
  ip: string;
  userAgent: string | null;
}

export const ERROR_MESSAGE = `Извините, сейчас не получается ответить — произошла техническая ошибка. ` +
  `Попробуйте повторить вопрос чуть позже или позвоните нам: ${FALLBACK_PHONE} (Алматы).`;

const EMPTY_ANSWER = `Извините, не удалось сформировать ответ. Попробуйте переформулировать вопрос ` +
  `или позвоните нам: ${FALLBACK_PHONE}.`;

function historyToMessages(rows: HistoryRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    const content = (r.content ?? "").trim();
    if (!content) continue;
    out.push(r.role === "user" ? { role: "user", content } : { role: "assistant", content });
  }
  return out;
}

/** Товары и прочие результаты инструментов из прошлых ответов (для проверки и карточек). */
function historyToolData(rows: HistoryRow[]): { data: unknown[]; cards: ProductCard[] } {
  const data: unknown[] = [];
  const cards: ProductCard[] = [];
  for (const r of rows) {
    if (r.role !== "assistant" || !Array.isArray(r.tool_results)) continue;
    for (const t of r.tool_results as Record<string, unknown>[]) {
      data.push(t);
      if (Array.isArray(t.products)) cards.push(...(t.products as ProductCard[]));
    }
  }
  return { data, cards };
}

export async function runChat(w: SSEWriter, cfg: Config, req: ChatRequest, meta: RequestMeta): Promise<void> {
  const started = Date.now();
  let db: Db | null = null;
  let sessionId: string | null = null;
  let userSaved = false;
  let answer = "";
  const outcomes: ToolOutcome[] = [];
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  let sawUsage = false;
  const flags: Record<string, unknown> = {};

  try {
    db = getDb(cfg);
    const ipHash = await sha256Hex(meta.ip + cfg.supabaseUrl);
    const session = await loadOrCreateSession(db, req.session_id, {
      ipHash,
      userAgent: meta.userAgent,
      pageUrl: req.page_url ?? null,
      city: req.city ?? null,
    });
    sessionId = session.id;
    w.send("session", { session_id: sessionId });

    const rl = await checkRateLimit(db, sessionId, ipHash);
    if (!rl.ok) {
      w.send("error", { message: RATE_LIMIT_MESSAGE, code: "rate_limited" });
      return;
    }

    await insertMessage(db, { session_id: sessionId, role: "user", content: req.message, ip_hash: ipHash });
    userSaved = true;

    const history = await loadHistory(db, sessionId, LIMITS.historyMessages);
    const prior = historyToolData(history);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ pageUrl: req.page_url, city: req.city }) },
      ...historyToMessages(history),
    ];

    // Эмбеддинги кэшируются в пределах запроса; ошибка → поиск без векторной части.
    const embedCache = new Map<string, Promise<number[] | null>>();
    const embedQuery = (text: string) => {
      const key = text.trim().toLowerCase();
      let p = embedCache.get(key);
      if (!p) {
        p = embed(cfg.openaiApiKey, cfg.embeddingModel, text, cfg.openaiBaseUrl).catch((e) => {
          console.error("embedding failed", e instanceof Error ? e.message : e);
          flags.embedding_error = true;
          return null;
        });
        embedCache.set(key, p);
      }
      return p;
    };
    // url ekt.kz, известные navigate_to: из истории сразу, из этого хода — по мере выполнения раундов.
    const knownUrls = collectKnownUrls(prior.data);
    const toolCtx = { db, sessionId, embed: embedQuery, knownUrls };

    for (let round = 0; round < LIMITS.maxToolRounds; round++) {
      const lastRound = round === LIMITS.maxToolRounds - 1;
      let firstDelta = true;
      const res = await streamChat({
        apiKey: cfg.openaiApiKey,
        baseUrl: cfg.openaiBaseUrl,
        model: cfg.openaiModel,
        messages,
        tools: TOOL_DEFS,
        toolChoice: lastRound ? "none" : "auto",
        maxCompletionTokens: cfg.maxCompletionTokens,
        timeoutMs: LIMITS.openaiTimeoutMs,
        onDelta: (t) => {
          // Текст из разных раундов разделяем пустой строкой.
          if (firstDelta && answer && !answer.endsWith("\n")) {
            answer += "\n\n";
            w.send("delta", { text: "\n\n" });
          }
          firstDelta = false;
          answer += t;
          w.send("delta", { text: t });
        },
      });
      if (res.usage) {
        sawUsage = true;
        usage.prompt_tokens += res.usage.prompt_tokens ?? 0;
        usage.completion_tokens += res.usage.completion_tokens ?? 0;
      }
      if (res.finishReason === "length") flags.truncated = true;
      if (!res.toolCalls.length) break;
      if (lastRound) {
        flags.tool_rounds_exhausted = true;
        break;
      }

      messages.push({ role: "assistant", content: res.content || null, tool_calls: res.toolCalls });
      for (const name of new Set(res.toolCalls.map((c) => c.function.name))) {
        w.send("status", { tool: name, label: TOOL_LABELS[name] ?? "Проверяю данные…" });
      }
      const results = await Promise.all(
        res.toolCalls.map((c) => executeTool(c.function.name, c.function.arguments, toolCtx)),
      );
      res.toolCalls.forEach((c, i) => {
        outcomes.push(results[i]);
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(results[i].result) });
      });
      // Url из результатов этого раунда становятся известны для navigate_to в следующих раундах хода.
      for (const u of collectKnownUrls(results.map((r) => r.result))) knownUrls.add(u);
    }

    if (!answer.trim()) {
      flags.empty_answer = true;
      answer = EMPTY_ANSWER;
      w.send("delta", { text: answer });
    }

    // Детерминированная проверка ответа.
    const toolErrors = outcomes.filter((o) => o.error).map((o) => ({ tool: o.name, error: o.error }));
    if (toolErrors.length) flags.tool_errors = toolErrors;
    Object.assign(
      flags,
      validateAnswer({
        answer,
        toolData: [...outcomes.map((o) => ({ args: o.args, result: o.result })), ...prior.data],
        toolCalled: outcomes.length > 0,
        extraTexts: history.filter((h) => h.role === "user").map((h) => h.content),
      }),
    );

    const cards = pickMentionedProducts(
      answer,
      [...outcomes.flatMap((o) => o.cards), ...prior.cards],
      LIMITS.maxProductCards,
    );
    if (cards.length) {
      w.send("products", {
        items: cards.map((c) => ({
          id: c.id,
          name: c.name,
          url: c.url,
          sku: c.sku,
          brand: c.brand,
          price_site: c.price_site,
          price_store: c.price_store,
          image_url: c.image_url,
        })),
      });
    }

    // UI-действия (navigate/highlight/click/fill/filter/suggest) хода: собраны из успешных вызовов
    // инструментов, сжаты по лимитам (1 navigate/click/fill/filter/suggest, ≤3 highlight) и отправлены
    // после текста и карточек товаров, перед `done`.
    const uiActions: UiAction[] = collectTurnActions(
      outcomes.map((o) => o.uiAction).filter((a): a is UiAction => !!a),
    );
    for (const action of uiActions) w.send("action", action);
    if (uiActions.length) flags.actions = uiActions;

    const messageId = await insertMessage(db, {
      session_id: sessionId,
      role: "assistant",
      content: answer,
      tool_calls: outcomes.map((o) => ({ name: o.name, arguments: o.args })),
      tool_results: outcomes.map(compactOutcome),
      model: cfg.openaiModel,
      tokens_in: sawUsage ? usage.prompt_tokens : null,
      tokens_out: sawUsage ? usage.completion_tokens : null,
      latency_ms: Date.now() - started,
      flags,
    });
    await touchSession(db, sessionId, session.message_count + 2, {
      pageUrl: req.page_url ?? null,
      city: req.city ?? null,
    });
    w.send("done", { message_id: messageId });
  } catch (e) {
    const msg = e instanceof Error
      ? `${e.name}: ${e.message}`
      : e && typeof e === "object" && "message" in e
      ? `db: ${String((e as { message: unknown }).message)}`
      : String(e);
    console.error("chat failed", msg);
    flags.error = msg.slice(0, 500);
    w.send("error", { message: ERROR_MESSAGE });
    if (db && sessionId && userSaved) {
      try {
        await insertMessage(db, {
          session_id: sessionId,
          role: "assistant",
          content: answer,
          tool_calls: outcomes.map((o) => ({ name: o.name, arguments: o.args })),
          tool_results: outcomes.map(compactOutcome),
          model: cfg.openaiModel,
          tokens_in: sawUsage ? usage.prompt_tokens : null,
          tokens_out: sawUsage ? usage.completion_tokens : null,
          latency_ms: Date.now() - started,
          flags,
        });
      } catch (e2) {
        console.error("failed to store error message", e2);
      }
    }
  }
}
