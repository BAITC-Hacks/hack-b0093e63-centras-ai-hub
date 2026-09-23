import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { CompletionAccumulator, consumeStream, OpenAIError, streamChat } from "./openai.ts";

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

Deno.test("CompletionAccumulator: склейка tool_call дельт по index, параллельные вызовы", () => {
  const acc = new CompletionAccumulator();
  acc.apply({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "search_products", arguments: "" } }],
      },
    }],
  });
  acc.apply({
    choices: [{
      delta: {
        tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_branches", arguments: '{"ci' } }],
      },
    }],
  });
  acc.apply({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] });
  acc.apply({
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, function: { arguments: '"лампа"}' } },
          { index: 1, function: { arguments: 'ty":"Астана"}' } },
        ],
      },
    }],
  });
  acc.apply({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  acc.apply({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  const r = acc.result();
  assertEquals(r.finishReason, "tool_calls");
  assertEquals(r.usage, { prompt_tokens: 100, completion_tokens: 20 });
  assertEquals(r.toolCalls, [
    { id: "call_a", type: "function", function: { name: "search_products", arguments: '{"query":"лампа"}' } },
    { id: "call_b", type: "function", function: { name: "get_branches", arguments: '{"city":"Астана"}' } },
  ]);
  assertEquals(JSON.parse(r.toolCalls[1].function.arguments), { city: "Астана" });
});

Deno.test("consumeStream: текст, разрезанный посреди событий и UTF-8, + [DONE]", async () => {
  const body = [
    sse({ choices: [{ delta: { role: "assistant", content: "" } }] }),
    sse({ choices: [{ delta: { content: "Привет" } }] }),
    sse({ choices: [{ delta: { content: ", мир" } }] }),
    sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    "data: [DONE]\n\n",
  ].join("");
  // Режем по байтам в произвольных местах (включая середину кириллических символов).
  const bytes = new TextEncoder().encode(body);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const deltas: string[] = [];
  const r = await consumeStream(stream, (t) => deltas.push(t));
  assertEquals(deltas.join(""), "Привет, мир");
  assertEquals(r.content, "Привет, мир");
  assertEquals(r.finishReason, "stop");
  assertEquals(r.toolCalls, []);
  assertEquals(r.usage, { prompt_tokens: 5, completion_tokens: 2 });
});

Deno.test("consumeStream: CRLF, комментарии, текст + tool_calls в одном раунде", async () => {
  const parts = [
    ": keep-alive\r\n\r\n",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Сейчас поищу." } }] })}\r\n\r\n`,
    `data: ${
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search_products", arguments: "{}" } }] } }],
      })
    }\r\n\r\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\r\n\r\n`,
    "data: [DONE]\r\n\r\n",
  ];
  const r = await consumeStream(streamOf(parts), () => {});
  assertEquals(r.content, "Сейчас поищу.");
  assertEquals(r.toolCalls.map((c) => c.function.name), ["search_products"]);
});

Deno.test("consumeStream: tool_call без id получает сгенерированный id", async () => {
  const r = await consumeStream(
    streamOf([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get_branches", arguments: "{}" } }] } }] }),
      "data: [DONE]\n\n",
    ]),
    () => {},
  );
  assertEquals(r.toolCalls[0].id, "call_0");
});

Deno.test("consumeStream: ошибка внутри потока", async () => {
  await assertRejects(
    () => consumeStream(streamOf([sse({ error: { message: "boom" } })]), () => {}),
    OpenAIError,
    "boom",
  );
});

Deno.test("streamChat: тело запроса без temperature, с max_completion_tokens и include_usage", async () => {
  let sent: Record<string, unknown> = {};
  const fakeFetch = ((_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return Promise.resolve(
      new Response(streamOf([sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"])),
    );
  }) as unknown as typeof fetch;
  const r = await streamChat({
    apiKey: "k",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }],
    toolChoice: "none",
    maxCompletionTokens: 100,
    fetchImpl: fakeFetch,
  });
  assertEquals(r.content, "ok");
  assertEquals(sent.temperature, undefined);
  assertEquals(sent.max_completion_tokens, 100);
  assertEquals(sent.stream, true);
  assertEquals(sent.stream_options, { include_usage: true });
  assertEquals(sent.tool_choice, "none");
});

Deno.test("streamChat: HTTP-ошибка → OpenAIError со статусом", async () => {
  const fakeFetch = (() => Promise.resolve(new Response("rate limited", { status: 429 }))) as unknown as typeof fetch;
  const err = await assertRejects(
    () => streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: fakeFetch }),
    OpenAIError,
  );
  assertEquals((err as OpenAIError).status, 429);
});
