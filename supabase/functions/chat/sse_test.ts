import { assertEquals } from "jsr:@std/assert@1";
import { createSSEStream, formatEvent, SSEDecoder } from "./sse.ts";

Deno.test("formatEvent", () => {
  assertEquals(formatEvent("delta", { text: "a\nb" }), 'event: delta\ndata: {"text":"a\\nb"}\n\n');
});

Deno.test("SSEDecoder: события, многострочный data, \\r на границе кусков, flush", () => {
  const d = new SSEDecoder();
  const out = [
    ...d.push('event: status\ndata: {"a":1}\n\ndata: line1\nda'),
    ...d.push("ta: line2\r"),
    ...d.push("\n\r\n: comment\n\ndata: tail"),
    ...d.flush(),
  ];
  assertEquals(out, [
    { event: "status", data: '{"a":1}' },
    { event: "message", data: "line1\nline2" },
    { event: "message", data: "tail" },
  ]);
});

Deno.test("createSSEStream: отдаёт события и закрывается после run", async () => {
  const stream = createSSEStream(async (w) => {
    w.send("session", { session_id: "x" });
    await Promise.resolve();
    w.send("done", { message_id: 1 });
  });
  const text = await new Response(stream).text();
  const d = new SSEDecoder();
  const evs = [...d.push(text), ...d.flush()];
  assertEquals(evs.map((e) => e.event), ["session", "done"]);
  assertEquals(JSON.parse(evs[1].data), { message_id: 1 });
});
