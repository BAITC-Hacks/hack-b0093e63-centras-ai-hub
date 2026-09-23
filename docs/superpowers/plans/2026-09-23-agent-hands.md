# План: «руки» консультанта — действия на сайте + демо-витрина

Цель: консультант не только отвечает, но и **действует на странице**: переводит покупателя на нужную
страницу в том же окне (товар, возврат, оплата, контакты), подсвечивает элементы (цена, кнопка
«Купить», характеристики, условия/форма возврата, телефон) и ведёт по сценарию. Демонстрация — на
демо-витрине `web/public/index.html`, повторяющей структуру ekt.kz, с виджетом поверх.

## Global Constraints

- **Контракт SSE** (новое событие, остальные без изменений): `event: action`, `data`:
  - `{"type":"navigate","url":"https://ekt.kz/…","label":"Открываю карточку товара"}`
  - `{"type":"highlight","target":"<TARGET>","note":"Вот цена на сайте"}`
  где `TARGET` ∈ `price`, `buy_button`, `characteristics`, `description`, `return_conditions`,
  `return_form`, `payment_methods`, `contacts_phone`, `catalog_list`, `search`.
- Порядок событий в ответе: `session` → `status`* → `delta`* → `products`? → `action`* → `done`.
  Все `action` отправляются **после** текста ответа (перед `done`). Максимум 1 `navigate` на ответ
  (последний выигрывает), `highlight` — до 3.
- Разрешённые URL для `navigate`: только `https://ekt.kz/…` без query, и только если URL (a) есть в
  результатах инструментов этого диалога (товар, страница базы знаний) или (b) входит в список
  служебных: `/return/`, `/payments/`, `/about/howto/`, `/about/contacts/`, `/about/faq/`,
  `/catalog/svetilniki_lampy/lampy/`, `/`. Иначе инструмент возвращает ошибку модели, событие не шлётся.
- Селекторы целей на странице — **классы реального ekt.kz**, демо-витрина использует те же классы:
  `price` → `.detail_info__price__site`, `buy_button` → `.btn-cart`, `characteristics` → `.tab_item_chars`,
  `description` → `.detail_tabs__body__item__value:not(.tab_item_chars)`, `return_conditions` →
  `[data-ekt-target="return_conditions"], .project-grid .col-md-10`, `return_form` → `[data-ekt-target="return_form"], form`,
  `payment_methods` → `[data-ekt-target="payment_methods"], .checkout-and-delivery`, `contacts_phone` →
  `[data-ekt-target="contacts_phone"], a[href^="tel:"]`, `catalog_list` → `[data-ekt-target="catalog_list"], .catalog_section, .catalog-list`,
  `search` → `[data-ekt-target="search"], input[name="q"]`. Сначала `[data-ekt-target=…]`, затем классы ekt.kz.
- Виджет: `navigate` → показывает плашку «Перехожу: <label> · Отмена» 2 с, затем `location.assign(resolveUrl(url))`
  в том же окне; диалог уже сохраняется в localStorage и восстанавливается после перехода, окно
  остаётся открытым. Отложенные `highlight` (пришедшие вместе с `navigate`) сохраняются и
  выполняются после загрузки новой страницы. `highlight` → прокрутка к элементу, пульсирующая рамка
  поверх (оверлей вне Shadow DOM, `pointer-events:none`, уважает `prefers-reduced-motion`) и подсказка
  `note`; снимается через 6 с или по клику. Элемент не найден — тихо игнорировать.
- `resolveUrl`: `window.EKTConsultantResolveUrl(url)` если определена страницей, иначе identity.
  Демо-витрина определяет её: карточка товара ekt.kz → `/product.html?id=<bitrix id>` (по seed),
  `/return/` → `/return.html`, `/payments/` → `/payments.html`, `/about/contacts/` → `/contacts.html`,
  `/catalog/svetilniki_lampy/lampy/` и `/` → `/index.html`; прочее — открыть ekt.kz в новой вкладке.
- Демо-витрина — явно помечена баннером «Демо-стенд ИИ-консультанта. Данные — снимок ekt.kz от
  23.09.2026; оформить заказ можно на ekt.kz» со ссылкой на настоящий сайт. Никаких форм оплаты/ввода карт.
- Бэкенд — схема `ekt`, Deno, существующие паттерны `tools.ts`/`chat.ts`/`sse.ts`. Не деплоить.
- Не трогать `README.md`, `eval/` (с ними работают другие агенты). Коммиты — conventional, без ИИ-соавторов;
  `git add` только своих путей, при `index.lock` — повторить.
- Тесты зелёные: `npm test`, `npx -y deno@2 test supabase/functions/chat/`, `npx tsc --noEmit -p .`, `npm run build:web` (лимит бандла можно поднять до 48 KB, если нужно).

## Task 6: Бэкенд — инструменты действий

Файлы: `supabase/functions/chat/tools.ts`, `chat.ts`, `sse.ts` (если нужно), `prompt.ts`, `ui_actions.ts` (новый, чистая логика), `ui_actions_test.ts`.

1. Инструменты `navigate_to {url, label}` и `highlight {target (enum), note}` с описаниями на русском.
2. `ui_actions.ts`: `validateNavigate(url, knownUrls)` (правила из Global Constraints; нормализация
   `http→https`, `www.` → без, хвостовой `/`), список `SERVICE_NAV_PATHS`, `TARGETS`, сборщик действий
   хода (один navigate — последний, highlight ≤ 3, дедуп).
3. `knownUrls` = URL из результатов инструментов текущего хода и истории (`tool_results`) + служебные.
4. Действия копятся за ход и отправляются событиями `action` после текста, перед `done`; сохраняются в
   `chat_messages.tool_results`/`flags.actions` для аудита.
5. Промпт: блок «Действия на сайте» — когда уместно: нашёл подходящий товар и клиент хочет посмотреть/купить →
   ответ + `navigate_to` на карточку + `highlight price/buy_button`; «хочу оформить возврат» → условия из
   `search_knowledge` + `navigate_to /return/` + `highlight return_conditions` (и `return_form`, если есть);
   оплата → `/payments/` + `payment_methods`; контакты → `/about/contacts/` + `contacts_phone`. Сначала
   говорить, что делаешь («Открываю карточку…»). Не переходить, если клиент просто спрашивает общие вещи
   или уже на этой странице (`page_url`). Никогда не выдумывать URL.
6. Контекст страницы: если `page_url` — карточка товара ekt.kz, модель может вызвать `get_product(url)` для
   вопросов «а эта лампа…».
7. Тесты: validateNavigate (разрешено/запрещено/нормализация/чужой домен/query), сборщик (последний
   navigate, лимит highlight, неизвестный target → ошибка), порядок событий в chat-потоке (если есть
   тестовая инфраструктура для chat.ts — иначе через чистую функцию сборки).

## Task 7: Виджет «руки» + демо-витрина

Файлы: `web/src/actions.ts` (новый), `web/src/widget.ts`, `web/src/storage.ts`, `web/build.mjs`,
`web/public/index.html` (витрина), `web/public/product.html`, `web/public/return.html`,
`web/public/payments.html`, `web/public/contacts.html`, `web/public/demo.css`, `web/public/demo.js`,
`web/public/about.html` (перенести сюда текущую посадочную страницу из `index.html` без сокращений),
тесты `web/test/actions.test.ts` (+ DOM-окружение `happy-dom` как devDependency, если нужно).

1. `actions.ts`: обработка `action`-событий по контракту; очередь отложенных highlight в storage;
   оверлей подсветки; плашка перехода с «Отмена»; `resolveUrl`.
2. Демо-витрина на данных `seed/`: `build.mjs` генерирует `web/public/data/products.json`
   (id, name, url, sku, brand, price_site, price_store, image_url, category_path, attrs, description) и
   `web/public/data/pages.json` (return, payments, howto, contacts — заголовок + текст/секции) из
   `seed/*.jsonl`. Страницы строятся на клиенте (`demo.js`) с классами ekt.kz и атрибутами
   `data-ekt-target`: список категории «Лампы» с фильтрами (цоколь, мощность, цветовая температура, бренд),
   карточка товара (цена на сайте/в магазине, «Купить» — ведёт на ekt.kz, характеристики, описание),
   возврат (условия + демонстрационная форма заявки на возврат без отправки данных), оплата, контакты
   (9 филиалов из `branches.json`). Вид — узнаваемо в стиле ekt.kz (цвета `#2C7294`, `#F4B301`, PT Sans),
   адаптивно. Баннер «Демо-стенд …» на всех страницах. Виджет подключён на всех страницах с `data-api`
   из `<meta name="ekt-api">` (значение: `https://gqdwplbvxopanapxzlaw.supabase.co/functions/v1/chat`).
3. `window.EKTConsultantResolveUrl` в `demo.js` по правилам Global Constraints.
4. Тесты: разбор action-событий, resolveUrl, очередь highlight переживает «перезагрузку», поиск цели
   (`data-ekt-target` приоритетнее классов), отмена перехода, reduced-motion.

## Task 8: E2E и проверка сервиса

После Task 6 (задеплоено контроллером) и Task 7: браузерный e2e (Playwright/headless Chrome) по
живому API: (1) «Есть лампочки E27 тёплого света?» → ответ с товаром → переход на `product.html?id=…`
в том же окне → подсветка цены; (2) «Хочу оформить возврат» → переход на `return.html` → подсветка
условий/формы; (3) «Где вы находитесь в Астане?» → переход на контакты / подсветка телефона.
Скриншоты в `docs/screenshots/`. Скрипт `npm run e2e`. Отчёт с результатами.

## Дополнение к контракту (обязательно): консультант ДЕЛАЕТ за покупателя и ПРЕДЛАГАЕТ сценарии

Новые типы `action` (вдобавок к `navigate`/`highlight`; все — после текста, перед `done`, в порядке вызова;
отложенные после `navigate` выполняются на новой странице по порядку):

- `{"type":"click","target":"buy_button"|"search_submit","label":"Добавляю в корзину"}` — нажать элемент.
  Разрешённые цели: `buy_button` (`.btn-cart` — на реальном ekt.kz это add2basket через JS сайта), `search_submit`
  (`[data-ekt-target="search_submit"], form[action*="search"] button[type="submit"]`). Виджет показывает плашку
  «<label> · Отмена» 2 с, подсвечивает элемент, затем `element.click()`.
- `{"type":"fill","form":"return_form"|"lead_form"|"search","fields":{…},"label":"Заполняю заявление на возврат"}` —
  заполнить поля: поиск поля внутри формы-цели по `[data-ekt-field="<key>"]`, затем `[name="<key>"]`; установить
  value, отправить события `input` и `change`; подсветить форму. **Форму не отправлять** — отправляет человек.
  Ключи полей: return_form — `name, phone, order_number, purchase_date, product, reason`; lead_form — `name, phone, city, comment`;
  search — `q`. Цель формы: `lead_form` → `[data-ekt-target="lead_form"]`.
- `{"type":"filter","filters":{"Тип цоколя":"E27","Цветовая температура":"4000"},"label":"Применяю фильтры"}` —
  виджет делает `window.dispatchEvent(new CustomEvent("ekt:filter",{detail:{filters}}))`; страница каталога
  (демо) применяет фильтры и подсвечивает список. На чужой странице — игнор.
- `{"type":"suggest","options":["Открыть карточку","Добавить в корзину"]}` — 1–4 кнопки быстрых ответов под
  последним сообщением ассистента; клик = отправка этого текста как сообщения пользователя. Кнопки исчезают
  после следующего сообщения.

Инструменты бэкенда: `click_element {target, label}`, `fill_form {form, fields, label}`,
`apply_filters {filters, label}`, `suggest_replies {options}` (валидация enum/ключей/длины: option ≤ 40 символов,
значение поля ≤ 200, телефон — только если клиент сам его написал). Лимиты на ответ: navigate ≤ 1, click ≤ 1,
fill ≤ 1, filter ≤ 1, highlight ≤ 3, suggest ≤ 1.

Правила промпта (сценарии, «плейбук»):
1. **Подбор → покупка:** найти → показать 1–5 вариантов → предложить (`suggest_replies`) «Открыть карточку»/«Добавить в корзину» →
   по согласию `navigate_to` карточки + `highlight price` → по явному «да, добавь» `click_element buy_button` + пояснить, что
   оформление корзины — на сайте.
2. **Возврат/обмен:** условия из `search_knowledge` → собрать номер заказа/дату покупки, товар, причину, имя, телефон →
   `navigate_to /return/` + `fill_form return_form` + `highlight return_form` → «проверьте и нажмите “Отправить”».
3. **Каталог по характеристикам:** `navigate_to /catalog/svetilniki_lampy/lampy/` + `apply_filters` (ключи = названия характеристик из
   `category_facets`).
4. **Оплата/доставка:** `navigate_to /payments/` + `highlight payment_methods`. **Контакты:** `/about/contacts/` + `highlight contacts_phone`.
5. **Заявка менеджеру:** на странице с формой — `fill_form lead_form`; иначе `create_lead` (как раньше, с согласия).
6. Действия, меняющие состояние (click, fill), — только после явного согласия клиента в диалоге; сначала сказать, что сделаешь.
   Проактивно предлагать следующий шаг сценария через `suggest_replies`.

Демо-витрина: форма возврата `[data-ekt-target="return_form"]` с полями `data-ekt-field` (не отправляет данные —
показывает «Демо: заявление сформировано»), форма заявки `[data-ekt-target="lead_form"]` (в шапке/на контактах),
поиск `[data-ekt-target="search"]` + `search_submit` (фильтрует витрину), корзина — счётчик в шапке
(`[data-ekt-target="cart"]`, localStorage), «Купить» (`.btn-cart`) добавляет в демо-корзину, каталог слушает `ekt:filter`.
