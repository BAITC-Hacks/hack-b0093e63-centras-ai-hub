# План: 100 товаров категории «Лампы», ежедневная сверка цен, воспроизводимость, README по критериям

Спецификация: `docs/superpowers/specs/2026-09-23-ekt-ai-consultant-design.md`.

## Global Constraints

- Все объекты БД — в схеме `ekt` (supabase-js: `db: { schema: 'ekt' }`; REST: заголовки `Accept-Profile: ekt` / `Content-Profile: ekt`).
- Категория по умолчанию: `SCRAPER_CATEGORY=/catalog/svetilniki_lampy/lampy/`, лимит `SCRAPER_MAX_PRODUCTS=100`.
- Миграция истории цен уже написана: `supabase/migrations/20260923150000_price_history.sql`
  (колонки `products.price_site_prev`, `products.price_store_prev`, `products.price_changed_at`;
  таблица `ekt.price_history(product_id, run_id, price_site_old, price_site_new, price_store_old, price_store_new, changed_at)`).
- Не коммитить `.env*`, `data/`. Коммиты — conventional commits, без упоминания ИИ/Claude/OpenAI как соавторов.
- Не применять миграции к удалённой БД и не деплоить — это делает контроллер.
- Тесты: `npm test` (vitest, 105+ тестов) и `npx -y deno@2 test supabase/functions/chat/` должны оставаться зелёными; `npx tsc --noEmit -p .` без ошибок.

## Task 1: Ingest — обнаружение изменения цен и загрузка из seed

Файлы: `scraper/src/ingest.ts`, `scraper/src/rows.ts` (+ тест в `scraper/test/`).

1. Флаг `--dir <path>` (по умолчанию `data`): откуда читать `products.jsonl`, `categories.jsonl`, `pages.jsonl`, `branches.json`, `scrape-report.json`. Если `scrape-report.json` в каталоге нет — ingest работает (считает прогон неполным: деактивации нет).
2. Перед upsert товаров ingest уже читает существующие строки (`id, content_hash, embedded_hash, is_active`). Добавить к выборке `price_site, price_store, price_site_prev, price_store_prev, price_changed_at`.
3. Чистая функция в `rows.ts`: `detectPriceChanges(existing: Map<id, {price_site, price_store}>, rows: ProductRow[]): PriceChange[]` где `PriceChange = { product_id, name, url, price_site_old, price_site_new, price_store_old, price_store_new }`. Изменение = у существующего товара отличается `price_site` или `price_store` (null ≠ число считается изменением; новые товары — не изменение). Сравнение численное (299 и "299.00" равны).
4. Для каждой строки товара перед upsert выставить `price_site_prev`, `price_store_prev`, `price_changed_at`: для изменившихся — старые цены и `now()`; для остальных — перенести текущие значения из БД (иначе bulk-upsert обнулит их). У новых товаров — null.
5. После upsert вставить изменения в `ekt.price_history` (с `run_id` текущего `scrape_runs`), в `stats.price_changes` положить `{ count, items: первые 50 }`.
6. Вывод в консоль: `[ingest] изменения цен: N` и по строке на товар `name: old → new ₸`. Если задан `GITHUB_STEP_SUMMARY` — дописать туда markdown-таблицу изменений (или строку «Изменений цен нет»).
7. Unit-тесты `detectPriceChanges` (изменилась цена сайта, изменилась цена магазина, null→число, без изменений, новый товар, "299.00" vs 299).

## Task 2: Чат — знание об изменении цен

Файлы: `supabase/functions/chat/tools.ts`, `supabase/functions/chat/prompt.ts`, тесты рядом.

1. `get_product`: добавить в выборку `PRODUCT_COLUMNS` и в `item` поля `price_site_prev`, `price_store_prev`, `price_changed_at` (только если `price_changed_at` не null — иначе не включать, чтобы не шуметь).
2. `search_products`: RPC не возвращает эти поля — после RPC одним запросом `products.select("id, price_site_prev, price_changed_at").in("id", ids)` (можно объединить с уже существующим запросом `scrapedDates`) и добавить к item `price_changed: { from, at }` только для товаров с `price_changed_at` за последние 30 дней.
3. `prompt.ts`: правило — если у товара есть `price_changed`/`price_site_prev`, можно сказать «цена изменилась с X ₸ на Y ₸ (дата)»; не придумывать изменения.
4. `validate.ts`: цены `price_site_prev`/`price_store_prev` из результатов инструментов считаются известными (не флагать как unmatched).
5. Тесты deno зелёные; добавить тест на validate с прошлой ценой.

## Task 3: Воспроизводимость — seed-данные и локальный запуск одной командой

Файлы: `seed/` (данные), `scripts/setup-local.mjs`, `package.json` (скрипты), `.env.example`, `.github/workflows/refresh-data.yml`.

1. `seed/` — снимок данных для запуска без скрапинга (контроллер положит туда `products.jsonl` (100 ламп), `categories.jsonl`, `pages.jsonl`, `branches.json` после скрапинга; исполнитель создаёт `seed/README.md` с описанием состава и даты и скрипт `npm run seed:update` = копирование `data/{products.jsonl,categories.jsonl,pages.jsonl,branches.json}` в `seed/`).
2. `scripts/setup-local.mjs` (`npm run setup:local`): проверка Docker (`docker info`) с понятной ошибкой; `npx supabase start`; `npx supabase db reset --local` (миграции); получить локальные URL/ключи из `npx supabase status -o env`; записать их в `.env.local.generated` (не перезаписывая `.env.local`); запустить `ingest --dir seed` с локальными SUPABASE_URL/KEY (с `--no-embed`, если `OPENAI_API_KEY` пуст — предупредить, что векторная часть поиска выключена); вывести следующий шаг: `npx supabase functions serve chat --no-verify-jwt --env-file .env.local` и `npm run dev:web` → `http://localhost:5173/?api=http://127.0.0.1:54321/functions/v1/chat`.
   Учесть: для локального стека схему `ekt` надо добавить в `supabase/config.toml` → `[api] schemas` (и `extra_search_path` при необходимости).
3. `package.json`: `setup:local`, `seed:update`, `ingest:seed` (`tsx scraper/src/ingest.ts --dir seed`), `serve:fn` (`supabase functions serve chat --no-verify-jwt --env-file .env.local`), `smoke` (см. п.4).
4. `scripts/smoke.mjs` (`npm run smoke`): основной сценарий против `CHAT_URL` (по умолчанию `${SUPABASE_URL}/functions/v1/chat`): `GET /health` → ok; вопрос «Нужна светодиодная лампа E27 на 10 Вт, 4000K» → в ответе есть ссылка https://ekt.kz/ и событие `products` не пустое; некорректные входы: пустое сообщение → 400, 2001 символ → 400, не-JSON → 400. Печатает PASS/FAIL по каждой проверке, код выхода 1 при провале.
5. `.env.example`: добавить `SCRAPER_CATEGORY=/catalog/svetilniki_lampy/lampy/`, `SCRAPER_MAX_PRODUCTS=100`.
6. `refresh-data.yml`: env `SCRAPER_CATEGORY`, `SCRAPER_MAX_PRODUCTS=100`, `SCRAPER_CONCURRENCY=4`; cron оставить ежедневным; ingest пишет изменения цен в Job Summary (через `GITHUB_STEP_SUMMARY`).

## Task 4: README по критериям п. 7.4

Файл: `README.md`. README должен однозначно отвечать на 6 вопросов критерия: (1) что реализовано в этой версии — фактически работающее; (2) как устроено; (3) технологии и данные (источник, состав: 100 товаров категории «Лампы» + FAQ/условия/контакты, дата снимка); (4) установка и запуск — два пути: A) развёрнутая версия (URL API), B) локально из чистого клона через `npm run setup:local` — пошагово, без догадок; (5) как проверить основной сценарий — `npm run smoke`, `npm run eval`, ручной сценарий с конкретными вопросами и ожидаемым результатом; (6) известные ограничения — честно (100 товаров одной категории; нет остатков; цены Алматы; медленный сайт-источник; eval-прохождение; что не задеплоено). Раздел «Ежедневное обновление и отслеживание цен». Раздел «Команда». Актуализировать журнал изменений.

## Task 5: Оценка по скиллу ailem и доработка

Прогон технического трека скилла `C:\Users\LENOVO\Downloads\ailem` (5 независимых вердиктов, `score.py tech`), отчёт в `docs/ailem/`; применить рекомендации выжимки, двигающие баллы.
