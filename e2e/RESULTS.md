# E2E real-site results (ekt.kz)

Date: 2026-09-23T11:26:16.043Z
CHAT_URL: https://gqdwplbvxopanapxzlaw.supabase.co/functions/v1/chat

| Scenario | Result | Notes |
| --- | --- | --- |
| S1: assistant answer contains an ekt.kz link/reference | FAIL | no ekt.kz link in rendered links [] or text: "Самая" |
| S1 navigate to product (E27 cheapest) | PASS | now at https://ekt.kz/catalog/svetilniki_lampy/lampy/gazorazryadnye_lampy/termoizluchatel_t_230_40_vt_e27_100/ |
| S1: price highlight ring visible after navigation | FAIL | no .ring found in the overlay 9s after landing on the product page |
| S2: action plate (label · Отмена) appeared and ran | PASS |  |
| S2 click buy_button (add to cart) | PASS | cart before="Сравнить Избранное Корзина 0" after="Сравнить Избранное Корзина 1" |
| S3.1 navigate to /return/ + highlight | PASS | now at https://ekt.kz/return/ |
| S3.2 fill lead_form (#zayavka) with return details: modal #zayavka visible | PASS |  |
| S3.2 fill lead_form (#zayavka) with return details: name field filled | FAIL | name="" |
| S3.2 fill lead_form (#zayavka) with return details: phone field has real digits (not just the IMask placeholder) | FAIL | phone="+7 (___) ___-__-__" (1 digits) |
| S3.2 fill lead_form (#zayavka) with return details: question field filled | FAIL | question="" |
| S4 navigate to /payments/ + highlight | PASS | now at https://ekt.kz/payments/ |
| S4: payment_methods highlight ring visible | FAIL | no .ring found in the overlay after landing on /payments/ |
| S5 fill search + click search_submit → /catalog/?q= | FAIL | URL stayed at https://ekt.kz/ after 30s (answer: "Нашёл 6") |

Screenshots: docs/screenshots/e2e-s1-product.png, e2e-s2-cart.png, e2e-s3a-return-page.png, e2e-s3-return-form.png, e2e-s4-payments.png, e2e-s5-search.png

Overall: FAIL (6/13 passed)
