// EKT AI-консультант: вставляет виджет в страницу ekt.kz.
// Content script живёт в изолированном мире, поэтому виджет подключается обычным <script>:
// так он работает в мире страницы и может открывать модальные окна сайта (Bootstrap/jQuery ekt.kz).
// Диалог хранит и восстанавливает сам виджет; расширение ничего не читает и никуда не отправляет.
(function () {
  var API = 'https://gqdwplbvxopanapxzlaw.supabase.co/functions/v1/chat';

  // Сайт уже подключил консультанта сам (продакшен-сниппет) — второй не нужен.
  if (document.querySelector('script[data-api][src*="widget"]')) return;

  // Город, выбранный в шапке ekt.kz («Алматы», «Астана»…), помогает с ценами и филиалами.
  var cityEl = document.querySelector('.select-city__block__text-city');
  var city = cityEl ? cityEl.textContent.replace(/\s+/g, ' ').trim() : '';

  var s = document.createElement('script');
  s.src = chrome.runtime.getURL('widget.js');
  s.setAttribute('data-api', API);
  s.setAttribute('data-lang', document.documentElement.lang === 'kk' ? 'kk' : 'ru');
  if (city && city.length < 40) s.setAttribute('data-city', city);
  s.async = true;
  (document.body || document.documentElement).appendChild(s);
})();
