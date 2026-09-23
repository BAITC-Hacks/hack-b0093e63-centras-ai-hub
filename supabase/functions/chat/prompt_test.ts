import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { almatyDate, buildSystemPrompt, sanitizeMeta } from "./prompt.ts";

Deno.test("buildSystemPrompt: правило языка — отвечать на языке последнего сообщения клиента", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "ПОСЛЕДНЕГО сообщения клиента");
  assertStringIncludes(p, "казахский");
  assertStringIncludes(p, "английский");
});

Deno.test("buildSystemPrompt: блок «Действия на сайте» с плейбуком сценариев", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "## Действия на сайте");
  for (const tool of ["navigate_to", "highlight", "click_element", "fill_form", "suggest_replies"]) {
    assertStringIncludes(p, tool);
  }
  // Правило согласия для действий, меняющих состояние страницы.
  assertStringIncludes(p, "явно согласился");
});

Deno.test("buildSystemPrompt: apply_filters/filter упразднены (РАЗВОРОТ на реальный ekt.kz)", () => {
  const p = buildSystemPrompt();
  assertEquals(p.includes("apply_filters"), false);
  assertEquals(p.includes("return_form"), false);
});

Deno.test("buildSystemPrompt: никогда не заявлять о действии без вызова инструмента", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "никогда не ври о действии");
});

Deno.test("buildSystemPrompt: сценарий покупки в 1 клик и корзины не на странице товара", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "buy_one_click");
  assertStringIncludes(p, "lead_form");
});

Deno.test("buildSystemPrompt: page_url и city попадают в контекст", () => {
  const p = buildSystemPrompt({ pageUrl: "https://ekt.kz/catalog/lampy/x/", city: "Алматы" });
  assertStringIncludes(p, "https://ekt.kz/catalog/lampy/x/");
  assertStringIncludes(p, "Алматы");
});

Deno.test("sanitizeMeta: убирает управляющие символы и обрезает длину", () => {
  assertEquals(sanitizeMeta("  a\nb\tc<script>  ", 5), "a b c");
});

Deno.test("almatyDate: возвращает непустую строку с датой", () => {
  const s = almatyDate(new Date("2026-09-23T10:00:00Z"));
  assertEquals(typeof s, "string");
  assertEquals(s.length > 0, true);
});
