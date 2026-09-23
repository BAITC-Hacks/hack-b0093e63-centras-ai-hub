# E2E real-site results (ekt.kz)

Date: 2026-09-23T12:01:11.199Z
CHAT_URL: https://gqdwplbvxopanapxzlaw.supabase.co/functions/v1/chat

| Scenario | Result | Notes |
| --- | --- | --- |
| S1: assistant reply includes a product card (products event) or an ekt.kz link | PASS | productCard=true links=[https://ekt.kz/catalog/svetilniki_lampy/lampy/gazorazryadnye_lampy/termoizluchatel_t_230_40_vt_e27_100/, https://ekt.kz/catalog/svetilniki_lampy/lampy/gazorazryadnye_lampy/termoizluchatel_t_230_40_vt_e27_100/] |
| S1 navigate to product (E27 cheapest) | PASS | now at https://ekt.kz/catalog/svetilniki_lampy/lampy/gazorazryadnye_lampy/termoizluchatel_t_230_40_vt_e27_100/ |
| S1: navigated to the same product shown in the reply | PASS |  |
| S1: price highlight ring visible after navigation | PASS |  |
| S2: action plate (label · Отмена) appeared and ran | PASS |  |
| S2 click buy_button (add to cart) | PASS | cart before="Сравнить Избранное Корзина 0" after="Сравнить Избранное Корзина 1" |
| S3.1 navigate to /return/ + highlight | PASS | now at https://ekt.kz/return/ |
| S3.2 fill lead_form (#zayavka) with return details: modal #zayavka visible | PASS |  |
| S3.2 fill lead_form (#zayavka) with return details: name field filled | PASS | name="Тест" |
| S3.2 fill lead_form (#zayavka) with return details: phone field has real digits (not just the IMask placeholder) | PASS | phone="+7 (701) 000-00-00" (11 digits) |
| S3.2 fill lead_form (#zayavka) with return details: question field filled | PASS | question="Возврат: заказ №12345, дата покупки 01.09, товар лампа LED A60, причина: не работает" |
| S4 navigate to /payments/ + highlight | PASS | now at https://ekt.kz/payments/ |
| S4: payment_methods highlight ring visible | PASS |  |
| S5 fill search + click search_submit → /catalog/?q= | PASS | now at https://ekt.kz/catalog/?q=%D0%BB%D0%B0%D0%BC%D0%BF%D0%B0+GX53 |

Screenshots: docs/screenshots/e2e-s1-product.png, e2e-s2-cart.png, e2e-s3a-return-page.png, e2e-s3-return-form.png, e2e-s4-payments.png, e2e-s5-search.png

Overall: PASS (14/14)
