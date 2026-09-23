import fs from 'node:fs';
import { classifyAndParse } from './src/parse/index.js';
const map: Record<string,string> = {
 product: 'https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/led_lampa_a60_standart_10w_900lm_230v_4000k_e27_megalight_100/',
 product2: 'https://ekt.kz/catalog/kabel_provod/kabel_silovoy_dlya_statsionarnoy_prokladki_/mednyy_ognestoykiy_vvgng_frls_/vvgng_a_frls_5kh6/',
 category: 'https://ekt.kz/catalog/svetilniki_lampy/lampy/prochie/',
 faq: 'https://ekt.kz/about/faq/', return: 'https://ekt.kz/return/', payments: 'https://ekt.kz/payments/', howto: 'https://ekt.kz/about/howto/',
 article: 'https://ekt.kz/about/information/articles/lotok-lestnichnyy-provolochnyy-ekt/', contacts: 'https://ekt.kz/about/contacts/'};
for (const f of process.argv.slice(2)) {
  const r = classifyAndParse(map[f], fs.readFileSync(`scraper/test/fixtures/${f}.html`,'utf8'));
  console.log('=====', f, r.type);
  if (r.type === 'page') { const {content, ...rest} = r.data as any; console.log(JSON.stringify({...rest, sections: rest.sections.length}, null, 1)); console.log(content); if (r.branches) console.log(JSON.stringify(r.branches, null, 1)); }
  else console.log(JSON.stringify(r.data, null, 1));
}
