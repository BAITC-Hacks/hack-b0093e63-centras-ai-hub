import { assertEquals } from "jsr:@std/assert@1";
import {
  canonicalCity,
  compactAttrs,
  compactOutcome,
  escapeLike,
  normalizeKzPhone,
  TOOL_DEFS,
  truncate,
} from "./tools.ts";
import { evaluateLimits } from "./ratelimit.ts";

Deno.test("normalizeKzPhone", () => {
  assertEquals(normalizeKzPhone("+7 701 234 56 78"), "+77012345678");
  assertEquals(normalizeKzPhone("8 (701) 234-56-78"), "+77012345678");
  assertEquals(normalizeKzPhone("87012345678"), "+77012345678");
  assertEquals(normalizeKzPhone("7012345678"), "+77012345678");
  assertEquals(normalizeKzPhone("+7 (727) 346-88-88"), "+77273468888");
  assertEquals(normalizeKzPhone("12345"), null);
  assertEquals(normalizeKzPhone("+7 901 234 56 78"), null); // не казахстанский номер
  assertEquals(normalizeKzPhone("+1 555 123 4567"), null);
  assertEquals(normalizeKzPhone("+7701234567890"), null);
});

Deno.test("compactAttrs: пропускает служебные ключи и ограничивает число", () => {
  const attrs: Record<string, string> = {
    "Артикул": "1",
    "Артикул поставщика": "2",
    "Новинка": "Да",
    "Мощность": "10",
  };
  for (let i = 0; i < 20; i++) attrs[`k${i}`] = `v${i}`;
  const c = compactAttrs(attrs);
  assertEquals(Object.keys(c).length, 12);
  assertEquals(c["Мощность"], "10");
  assertEquals("Артикул" in c, false);
});

Deno.test("escapeLike и truncate", () => {
  assertEquals(escapeLike("150200550_%"), "150200550\\_\\%");
  assertEquals(truncate("abcdef", 3), "abc…");
  assertEquals(truncate(null, 3), "");
});

Deno.test("canonicalCity", () => {
  assertEquals(canonicalCity("Нур-Султан"), "астана");
  assertEquals(canonicalCity("almaty"), "алматы");
  assertEquals(canonicalCity("Өскемен"), "усть-каменогорск");
  assertEquals(canonicalCity("Париж"), "Париж");
});

Deno.test("compactOutcome: товары и ключевые поля", () => {
  const c = compactOutcome({
    name: "search_products",
    args: { query: "x" },
    result: { count: 1, items: [{ url: "https://ekt.kz/a/" }], data_updated_at: "2026-09-23" },
    cards: [{
      id: 1,
      name: "A",
      url: "https://ekt.kz/a/",
      sku: "S",
      brand: null,
      price_site: 10,
      price_store: null,
      image_url: null,
    }],
  });
  assertEquals(c.count, 1);
  assertEquals((c.products as unknown[]).length, 1);
  assertEquals(c.urls, undefined);
});

Deno.test("TOOL_DEFS: все 7 инструментов с уникальными именами", () => {
  const names = TOOL_DEFS.map((t) => t.function.name);
  assertEquals(new Set(names).size, 7);
});

Deno.test("evaluateLimits", () => {
  assertEquals(evaluateLimits(19, 59).ok, true);
  assertEquals(evaluateLimits(20, 0).ok, false);
  assertEquals(evaluateLimits(0, 60).ok, false);
});
