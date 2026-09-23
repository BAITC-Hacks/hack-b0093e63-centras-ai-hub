# Факты для технической оценки

## Область и источник
Рабочая копия D:\hack-b0093e63-centras-ai-hub; базовый commit e28ffc01b4ade37366c15f840c57e74e4b91c856. Наблюдения от 23.09.2026.
README и E2E-файлы менялись после commit. Полный README: README.md, скопирован в evidence/README.snapshot.md.
Официальное задание кейса/список обязательных условий допуска не приложены. В docs/superpowers есть внутренние design/plan. Материалы выступления не оцениваются по указанию пользователя.

## Структура
package.json/package-lock.json — Node/npm и зависимости.
scraper/src — scrape.ts, ingest.ts, parse/, chunk.ts, rows.ts.
seed — products.jsonl, categories.jsonl, pages.jsonl, branches.json, scrape-report.json.
supabase/migrations — схема ekt, поисковые SQL-функции, история цен.
supabase/functions/chat — index.ts, chat.ts, tools.ts, ui_actions.ts, openai.ts, http.ts, config.ts, db.ts, validate.ts, тесты.
web/src — widget.ts, actions.ts, storage.ts, sse.ts, markdown.ts, i18n.ts, styles.ts.
web/public — index.html, embed.html, bookmarklet.html, генерируемый widget.js.
extension — manifest.json (MV3), content.js, widget.js, icons/.
scripts — setup-local.mjs, smoke.mjs, check-search.mjs, seed-update.mjs.
eval — questions.json, run.ts, RESULTS.md, report.json.
e2e — real-site.mjs, api-contract.mjs, lib/inject.mjs, RESULTS.md.
.github/workflows — ci.yml, refresh-data.yml. vercel.json — сборка и output статического сайта.

## Данные
В seed пересчитаны 89 товаров, 24 категории, 123 информационные страницы, 9 филиалов. Снимок датирован 23.09.2026.
Товары: лампы; поля name/sku/brand/price_site/price_store/attrs/url и другие. Данных складских остатков в записи нет.
Модели по умолчанию gpt-4.1-mini и text-embedding-3-small, SQL вектор размерности 1536.

## Выполненные команды
Среда рабочей копии: Node v24.14.0, npm 11.9.0. Зависимости уже установлены; npm ci в новом клоне в этом проходе НЕ выполнялся.
`npm test` — exit 0, 8 файлов, 176 tests passed, Duration 6.95s.
`npm run typecheck` — exit 0, tsc --noEmit.
`npm run build:web` — exit 0, widget.js 49.4 KB, gzip 18.9 KB, лимит 50 KB; extension/widget.js не появился в git diff после сборки.
`docker info --format '{{.ServerVersion}}'` — permission denied при подключении к docker API в sandbox. Это ограничение доступа проверяющего, не наблюдаемый дефект проекта. setup:local/db reset не запускались.
Deno не найден в PATH; deno check/test не выполнялись.

## Живой основной сценарий и неверный ввод
`CHAT_URL=https://gqdwplbvxopanapxzlaw.supabase.co/functions/v1/chat npm run smoke` — повторный запуск с разрешённым сетевым доступом exit 0, 5/5 PASS.
1. GET /health → PASS.
2. POST: «Нужна светодиодная лампа E27 на 10 Вт, 4000K», page_url=https://ekt.kz/, city=Алматы → ответ содержит ссылку ekt.kz и products из 1 товара, без события error. Smoke не проверяет точное совпадение каждой характеристики товара.
3. POST пустое сообщение → HTTP 400.
4. POST сообщение из 2001 символа → HTTP 400.
5. POST не-JSON тело → HTTP 400.
Первая попытка из sandbox: 0/5, fetch failed. После разрешения сети все пять запросов прошли; первую попытку нельзя считать отказом сервиса.

## Сохранённые отчёты
Текущий e2e/RESULTS.md: 2026-09-23T12:01:11.199Z, Overall PASS 14/14. Это файл другого прогона, не новый E2E-запуск проверяющим.
Таблица: карточка/ссылка; navigate к тому же товару; подсветка цены; plate/отмена; добавление в корзину 0→1; переход к возврату; модальное окно заявки; имя/телефон/question заполнены; переход к оплате и подсветка; поиск GX53 меняет URL.
E2E inject.mjs использует inline script со сборкой виджета, работающей в main world страницы. Не загружает расширение через chrome://extensions.
eval/RESULTS.md: 41/42 = 97.6%, 2026-09-23T10:43:57.915Z; сценарий подбора E27 10W 4000K не прошёл. Это исторический отчёт; позднее есть миграции search_recall/search_rank. Текущая исправность этого точного подбора не подтверждена повторным eval.
docs/README-VERIFICATION.md относится к более раннему коммиту; Docker не запускался.

## Путь выполнения
extension/content.js вставляет widget.js с data-api. web/src/widget.ts отправляет POST и читает SSE. supabase/functions/chat/index.ts валидирует вход и вызывает runChat. chat.ts собирает историю/промпт и вызывает openai.ts, который обращается к OpenAI; tools.ts читает БД/RPC или создаёт запись leads. Результаты включаются в следующий раунд модели. SSE несёт текст, карточки и разрешённые UI-действия; web/src/actions.ts выполняет их по спискам targets/forms.
web/dev/mock-server.mjs имеет заранее заданные ответы; README выделяет его в отдельный режим без AI. Стандартный extension/content.js использует облачный API, не mock.

## Зафиксированные ограничения кода
scripts/setup-local.mjs выполняет supabase db reset --local, затем ingest seed, пишет .env.local.generated.
ingest.ts:207 считает fullRun через !report.limit; canDeactivate зависит от fetched/total_urls. ingest.ts:337 выбирает все активные existing, которых нет в текущем наборе, без ограничения категорией. Проверить при оценке риск использования category refresh после расширения базы.
create_lead проверяет телефон из userTexts; отдельного поля/проверки согласия в исполнителе нет. Промпт требует согласия.
validateAnswer выполняется после потоковой выдачи текста и сохраняет flags. Текст автоматически не исправляется.
Лимиты: 2000 символов, 12 сообщений истории, 5 раундов инструментов, 20 запросов/мин на сессию, 60 на IP, 3 заявки на сессию.
