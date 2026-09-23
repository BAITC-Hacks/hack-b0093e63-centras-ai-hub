# E2E real-site results (ekt.kz)

Date: 2026-09-23T11:48:20.336Z
CHAT_URL: https://gqdwplbvxopanapxzlaw.supabase.co/functions/v1/chat

Backend c688e61 + widget c4b3675 (rebuilt via `npm run build:web` before this run).

`npm run e2e:api` (same run window): **64/64 checks passed** — S1/S3.1/S3.2/S5 all matched the
contract (canonical URLs, known targets/forms/fields, per-turn limits, event order).

`npm run e2e` (browser, driven through `window.EKTConsultant.ask()` on the live site) was run
twice back to back, per the final instruction; the table below is the second (last) run —
12/13 PASS. The first run scored 10/13: S4's payment_methods highlight and S1's product
card/link were flaky between the two runs (see "Known flakiness" below); every other check
(navigate for S1/S3.1/S4, add-to-cart, all three S3.2 field checks, S5 search) passed both times.

| Scenario | Result | Notes |
| --- | --- | --- |
| S1: assistant reply includes a product card (products event) or an ekt.kz link | FAIL | no product card, no ekt.kz link in rendered links [], text: "Самая" |
| S1 navigate to product (E27 cheapest) | PASS | now at https://ekt.kz/catalog/svetilniki_lampy/lampy/gazorazryadnye_lampy/termoizluchatel_t_230_40_vt_e27_100/ |
| S1: price highlight ring visible after navigation | PASS |  |
| S2: action plate (label · Отмена) appeared and ran | PASS |  |
| S2 click buy_button (add to cart) | PASS | cart before="Сравнить Избранное Корзина 0" after="Сравнить Избранное Корзина 1" |
| S3.1 navigate to /return/ + highlight | PASS | now at https://ekt.kz/return/ |
| S3.2 fill lead_form (#zayavka) with return details: modal #zayavka visible | PASS |  |
| S3.2 fill lead_form (#zayavka) with return details: name field filled | PASS | name="Тест" |
| S3.2 fill lead_form (#zayavka) with return details: phone field has real digits (not just the IMask placeholder) | PASS | phone="+7 (701) 000-00-00" (11 digits) |
| S3.2 fill lead_form (#zayavka) with return details: question field filled | PASS | question="Возврат: заказ №12345, дата покупки 01.09, товар лампа LED A60, не работает" |
| S4 navigate to /payments/ + highlight | PASS | now at https://ekt.kz/payments/ |
| S4: payment_methods highlight ring visible | PASS |  |
| S5 fill search + click search_submit → /catalog/?q= | PASS | now at https://ekt.kz/catalog/?q=%D0%BB%D0%B0%D0%BC%D0%BF%D0%B0+GX53 |

Screenshots: docs/screenshots/e2e-s1-product.png, e2e-s2-cart.png, e2e-s3a-return-page.png, e2e-s3-return-form.png, e2e-s4-payments.png, e2e-s5-search.png

Overall: FAIL (12/13 passed)

## Known flakiness (across 2 browser runs + a handful of direct API calls today)

- **S1 product card/link**: the backend does not reliably send a `products` SSE event (or an inline
  markdown link) alongside the `navigate` action for "открой самую дешёвую" — seen present in some
  direct API calls but absent in both of today's browser runs. The user gets auto-navigated to the
  product with no clickable reference in the chat itself if they cancel the navigation. The
  `navigate` action, its URL, and the `highlight target=price` on landing were otherwise reliable
  (highlight passed run 2, failed run 1 — see below).
- **S4 payment_methods highlight**: failed run 1, passed run 2, for the *identical* question. Debugged
  by hand outside this suite: on the failing run, the widget's own `sessionStorage` deferred-action
  queue (`ekt-consultant:pending`) was empty right after `navigate` fired, and a direct API call for
  the same message sometimes returns `navigate` only (no `highlight`) and sometimes both — i.e. this
  is upstream LLM/backend non-determinism, not a bug in the e2e script's timing or in `findTarget()`
  (the `.checkout-and-delivery` target element is present and outside header/footer/nav on every
  check).
- Everything else (S1 navigate, S2 add-to-cart end to end, S3.1 navigate+highlight, all three S3.2
  field values, S4 navigate, S5 search fill+submit+URL) was PASS in **both** browser runs.
