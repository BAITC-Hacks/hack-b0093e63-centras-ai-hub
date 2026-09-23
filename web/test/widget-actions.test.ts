// @vitest-environment happy-dom
/**
 * The widget end to end with a stubbed chat API: `action` events from the stream are
 * executed after the reply, quick replies render under the last answer and disappear
 * after the next question, unknown actions are ignored, page_url is the page the shopper is on.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PENDING_KEY } from '../src/storage';

const API = 'https://api.example/functions/v1/chat';
const calls: any[] = [];
let nextStream = '';

function sse(events: [string, unknown][]): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

function response(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      // Split mid-event like a proxy would.
      c.enqueue(bytes.slice(0, 40));
      c.enqueue(bytes.slice(40));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const shadow = () => document.getElementById('ekt-consultant')!.shadowRoot!;
const overlay = () => document.querySelector('[data-ekt-overlay]')?.shadowRoot ?? null;

beforeAll(async () => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as any;
  window.fetch = vi.fn(async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return response(nextStream);
  }) as any;
  (window as any).happyDOM.setURL('https://ekt.kz/catalog/svetilniki_lampy/lampy/x/');
  document.body.innerHTML = `
    <h1>LED ЛАМПА A60 10W E27</h1>
    <div class="detail_info">
      <div class="detail_info__price__site" id="price">391 ₸</div>
      <a class="btn btn-primary btn-cart" id="buy">Купить</a>
    </div>`;
  const s = document.createElement('script');
  s.type = 'text/x-inert'; // happy-dom must not try to load it; readConfig only reads the attributes
  s.setAttribute('src', 'widget.js');
  s.dataset.api = API;
  document.body.append(s);
  await import('../src/widget');
});

async function ask(text: string) {
  window.EKTConsultant!.ask(text);
  await vi.waitFor(() => expect(shadow().querySelector('.fb')).not.toBeNull(), { timeout: 3000 });
}

describe('widget × actions', () => {
  it('runs highlight actions after the reply and renders quick replies', async () => {
    nextStream = sse([
      ['session', { session_id: 's1' }],
      ['delta', { text: 'Вот цена на сайте.' }],
      ['action', { type: 'highlight', target: 'price', note: 'Цена на сайте' }],
      ['action', { type: 'teleport', to: 'mars' }],
      ['action', { type: 'suggest', options: ['Добавить в корзину', 'Показать характеристики'] }],
      ['done', { message_id: 1 }],
    ]);
    await ask('Сколько стоит?');
    expect(calls[0].page_url).toBe('https://ekt.kz/catalog/svetilniki_lampy/lampy/x/');
    await vi.waitFor(() => expect(overlay()?.querySelectorAll('.ring').length).toBe(1));
    expect(overlay()!.querySelector('.note')!.textContent).toBe('Цена на сайте');
    const chips = Array.from(shadow().querySelectorAll('.suggest .chip')).map((c) => c.textContent);
    expect(chips).toEqual(['Добавить в корзину', 'Показать характеристики']);
  });

  it('a quick reply sends its text and the chips disappear', async () => {
    nextStream = sse([
      ['delta', { text: 'Готово.' }],
      ['done', { message_id: 2 }],
    ]);
    const chip = shadow().querySelector<HTMLButtonElement>('.suggest .chip')!;
    chip.click();
    expect(shadow().querySelector('.suggest')).toBeNull();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].message).toBe('Добавить в корзину');
    await vi.waitFor(() => expect(shadow().querySelectorAll('.fb').length).toBe(2));
    expect(shadow().querySelector('.suggest')).toBeNull();
  });

  it('keeps suggestions in the saved conversation (restored after navigation)', async () => {
    nextStream = sse([
      ['delta', { text: 'Открываю.' }],
      ['action', { type: 'suggest', options: ['Да'] }],
      ['done', { message_id: 3 }],
    ]);
    await ask('Ещё');
    await vi.waitFor(() => expect(shadow().querySelectorAll('.fb').length).toBe(3));
    const key = Object.keys(localStorage).find((k) => k.startsWith('ekt-consultant:v1:'))!;
    const saved = JSON.parse(localStorage.getItem(key)!);
    expect(saved.messages[saved.messages.length - 1].suggest).toEqual(['Да']);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('a new question during the «Купить» plate cancels the click', async () => {
    nextStream = sse([
      ['delta', { text: 'Добавляю в корзину.' }],
      ['action', { type: 'click', target: 'buy_button', label: 'Добавляю в корзину' }],
      ['done', { message_id: 5 }],
    ]);
    const buy = vi.fn();
    document.getElementById('buy')!.addEventListener('click', buy);
    const before = shadow().querySelectorAll('.fb').length;
    window.EKTConsultant!.ask('Добавь в корзину');
    await vi.waitFor(() => expect(overlay()?.querySelector('.plate')?.textContent).toContain('Добавляю в корзину: LED ЛАМПА A60 10W E27'), { timeout: 3000 });
    nextStream = sse([
      ['delta', { text: 'Хорошо, не добавляю.' }],
      ['done', { message_id: 6 }],
    ]);
    window.EKTConsultant!.ask('Нет, не надо');
    expect(overlay()?.querySelector('.plate')).toBeNull();
    await vi.waitFor(() => expect(shadow().querySelectorAll('.fb').length).toBe(before + 2), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 2300));
    expect(buy).not.toHaveBeenCalled();
  });

  it('navigate from the stream: plate with «Отмена», the rest queued for the next page; cancel keeps the page', async () => {
    nextStream = sse([
      ['delta', { text: 'Открываю условия возврата.' }],
      ['action', { type: 'navigate', url: 'https://ekt.kz/return/', label: 'Открываю условия возврата' }],
      ['action', { type: 'navigate', url: 'https://evil.example/phish/', label: 'x' }],
      ['action', { type: 'highlight', target: 'return_conditions', note: 'Условия' }],
      ['action', { type: 'fill', form: 'lead_form', fields: { question: 'Возврат', sessid: 'x' } }],
      ['done', { message_id: 4 }],
    ]);
    const href = location.href;
    await ask('Хочу оформить возврат');
    await vi.waitFor(() => expect(overlay()?.querySelector('.plate')?.textContent).toContain('Открываю условия возврата'));
    const queued = JSON.parse(sessionStorage.getItem(PENDING_KEY)!);
    expect(queued.actions).toEqual([
      { type: 'highlight', target: 'return_conditions', note: 'Условия' },
      { type: 'fill', form: 'lead_form', fields: { question: 'Возврат' }, label: undefined },
    ]);
    overlay()!.querySelector<HTMLButtonElement>('.plate button')!.click();
    await vi.waitFor(() => expect(sessionStorage.getItem(PENDING_KEY)).toBeNull());
    await new Promise((r) => setTimeout(r, 2300));
    expect(location.href).toBe(href);
  });
});
