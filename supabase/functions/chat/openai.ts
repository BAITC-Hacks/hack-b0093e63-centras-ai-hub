// Клиент OpenAI без SDK: потоковый Chat Completions с инструментами и эмбеддинги.

import { SSEDecoder } from "./sse.ts";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
}

export class OpenAIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpenAIError";
  }
}

// ---------------------------------------------------------------------------
// Накопление потоковых чанков (чистая логика — покрыта тестами)
// ---------------------------------------------------------------------------

interface ChunkToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: Array<{
    index?: number;
    delta?: { content?: string | null; tool_calls?: ChunkToolCallDelta[]; refusal?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: Usage | null;
  error?: { message?: string };
}

export class CompletionAccumulator {
  content = "";
  finishReason: string | null = null;
  usage: Usage | null = null;
  private calls = new Map<number, ToolCall>();

  /** Применяет один чанк; возвращает текстовую дельту (если есть) для стриминга клиенту. */
  apply(chunk: StreamChunk): string {
    if (chunk.error) throw new OpenAIError(chunk.error.message ?? "stream error");
    if (chunk.usage) this.usage = chunk.usage;
    let text = "";
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue;
      const d = choice.delta ?? {};
      if (typeof d.content === "string" && d.content) text += d.content;
      if (typeof d.refusal === "string" && d.refusal) text += d.refusal;
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        let acc = this.calls.get(i);
        if (!acc) {
          acc = { id: "", type: "function", function: { name: "", arguments: "" } };
          this.calls.set(i, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    this.content += text;
    return text;
  }

  get toolCalls(): ToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }))
      .filter((c) => c.function.name);
  }

  result(): CompletionResult {
    return {
      content: this.content,
      toolCalls: this.toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
    };
  }
}

/** Разбирает тело SSE-потока OpenAI в CompletionAccumulator, вызывая onDelta для текста. */
export async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<CompletionResult> {
  const acc = new CompletionAccumulator();
  const dec = new SSEDecoder();
  const td = new TextDecoder();
  let done = false;
  const handle = (data: string) => {
    if (data.trim() === "[DONE]") {
      done = true;
      return;
    }
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // мусорная строка — пропускаем
    }
    const t = acc.apply(chunk);
    if (t) onDelta(t);
  };
  const reader = body.getReader();
  try {
    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
      for (const ev of dec.push(td.decode(value, { stream: true }))) {
        handle(ev.data);
        if (done) break;
      }
    }
    if (!done) for (const ev of dec.flush()) handle(ev.data);
  } finally {
    reader.cancel().catch(() => {});
  }
  return acc.result();
}

// ---------------------------------------------------------------------------
// HTTP-вызовы
// ---------------------------------------------------------------------------

export interface StreamChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none";
  maxCompletionTokens?: number;
  timeoutMs?: number;
  onDelta?: (text: string) => void;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export async function streamChat(o: StreamChatOptions): Promise<CompletionResult> {
  if (!o.apiKey) throw new OpenAIError("OPENAI_API_KEY is not set");
  const body: Record<string, unknown> = {
    model: o.model,
    messages: o.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // temperature не передаём: reasoning-модели его отвергают.
  if (o.maxCompletionTokens) body.max_completion_tokens = o.maxCompletionTokens;
  if (o.tools?.length) {
    body.tools = o.tools;
    body.tool_choice = o.toolChoice ?? "auto";
  }
  const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new OpenAIError(`OpenAI ${res.status}: ${text.slice(0, 500)}`, res.status);
  }
  return await consumeStream(res.body, o.onDelta ?? (() => {}));
}

export async function embed(
  apiKey: string,
  model: string,
  input: string,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 20_000,
): Promise<number[]> {
  if (!apiKey) throw new OpenAIError("OPENAI_API_KEY is not set");
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: input.slice(0, 8000) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OpenAIError(`OpenAI embeddings ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  const json = await res.json();
  const vec = json?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new OpenAIError("OpenAI embeddings: empty response");
  return vec as number[];
}
