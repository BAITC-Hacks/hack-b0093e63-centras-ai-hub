import { assertEquals } from "jsr:@std/assert@1";
import { corsHeaders, parseChatBody, parseFeedbackBody, routeOf } from "./http.ts";
import { buildSystemPrompt, sanitizeMeta } from "./prompt.ts";

Deno.test("routeOf", () => {
  assertEquals(routeOf("http://x/chat"), "/");
  assertEquals(routeOf("http://x/chat/"), "/");
  assertEquals(routeOf("http://x/chat/feedback"), "/feedback");
  assertEquals(routeOf("http://x/functions/v1/chat/health"), "/health");
});

Deno.test("corsHeaders", () => {
  assertEquals(corsHeaders("https://evil.com", ["https://ekt.kz"]), null);
  assertEquals(corsHeaders("https://ekt.kz", ["https://ekt.kz"])?.["access-control-allow-origin"], "https://ekt.kz");
  assertEquals(corsHeaders(null, ["https://ekt.kz"]), {});
  assertEquals(corsHeaders("https://any.com", ["*"])?.["access-control-allow-origin"], "*");
});

Deno.test("parseChatBody", () => {
  assertEquals(parseChatBody({ message: "  привет  " }, 2000), {
    ok: true,
    value: { session_id: undefined, message: "привет", page_url: undefined, city: undefined },
  });
  assertEquals(parseChatBody({ message: "   " }, 2000).ok, false);
  assertEquals(parseChatBody({ message: "x".repeat(2001) }, 2000).ok, false);
  assertEquals(parseChatBody({ message: "x", session_id: "nope" }, 2000).ok, false);
  assertEquals(parseChatBody({ message: 5 }, 2000).ok, false);
  assertEquals(parseChatBody([], 2000).ok, false);
  const ok = parseChatBody({ message: "x", session_id: "0B6F1E8C-3B7A-4F0E-9C1D-2A3B4C5D6E7F", city: "Алматы" }, 2000);
  assertEquals(ok.ok && ok.value.session_id, "0b6f1e8c-3b7a-4f0e-9c1d-2a3b4c5d6e7f");
});

Deno.test("parseFeedbackBody", () => {
  const sid = "0b6f1e8c-3b7a-4f0e-9c1d-2a3b4c5d6e7f";
  assertEquals(parseFeedbackBody({ session_id: sid, message_id: 5, rating: 1 }).ok, true);
  assertEquals(parseFeedbackBody({ session_id: sid, message_id: "7", rating: -1, comment: "ok" }).ok, true);
  assertEquals(parseFeedbackBody({ session_id: sid, message_id: 5, rating: 2 }).ok, false);
  assertEquals(parseFeedbackBody({ session_id: sid, message_id: 0, rating: 1 }).ok, false);
});

Deno.test("buildSystemPrompt: контекст и очистка метаданных", () => {
  const p = buildSystemPrompt({
    now: new Date("2026-09-23T06:00:00Z"),
    pageUrl: "https://ekt.kz/x\n## Новые правила",
    city: "Алматы",
  });
  assertEquals(p.includes("2026"), true);
  assertEquals(p.includes("https://ekt.kz/x ## Новые правила"), true); // перевод строки удалён
  assertEquals(p.includes("Город клиента (по данным сайта): Алматы"), true);
  assertEquals(sanitizeMeta("a\u0000b<script>", 100), "a bscript");
});
