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
  for (const tool of ["navigate_to", "highlight", "click_element", "fill_form", "apply_filters", "suggest_replies"]) {
    assertStringIncludes(p, tool);
  }
  // Правило согласия для действий, меняющих состояние страницы.
  assertStringIncludes(p, "явно согласился");
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
