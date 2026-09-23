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

Deno.test("buildSystemPrompt: триггеры первого хода — действие обязательно в этом же ответе", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "Триггеры — действие ОБЯЗАТЕЛЬНО в этом же ответе");
  assertStringIncludes(p, "найди на сайте / покажи на сайте / открой / перейди / где на сайте");
  assertStringIncludes(p, "уже в ПЕРВОМ ответе");
});

Deno.test("buildSystemPrompt: few-shot примеры реплика → инструменты", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "Хочу оформить возврат");
  assertStringIncludes(p, "Найди на сайте лампу GX53");
  assertStringIncludes(p, 'fill_form(form="search"');
  assertStringIncludes(p, 'click_element(target="search_submit"');
});

Deno.test("buildSystemPrompt: триггер оплаты требует navigate И highlight, не только переход", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "ОБЯЗАТЕЛЬНО");
  assertStringIncludes(p, "переход без подсветки не считается выполненным триггером");
});

Deno.test("buildSystemPrompt: fill_form открывает модалку сама — отдельный click_element не нужен, если данные уже есть", () => {
  const p = buildSystemPrompt();
  assertStringIncludes(p, "click_element для открытия модалки НЕ нужен");
  assertStringIncludes(p, "fill_form открывает её сам");
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
