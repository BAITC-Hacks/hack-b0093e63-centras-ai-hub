export type Lang = 'ru' | 'kk' | 'en';

export interface Strings {
  title: string;
  online: string;
  launcher: string;
  launcherAria: string;
  close: string;
  newChat: string;
  dialogLabel: string;
  welcome: string;
  chips: string[];
  placeholder: string;
  inputLabel: string;
  send: string;
  stop: string;
  thinking: string;
  helpful: string;
  notHelpful: string;
  thanks: string;
  whatWrong: string;
  whatWrongPlaceholder: string;
  submit: string;
  skip: string;
  feedbackFailed: string;
  errorGeneric: string;
  errorOffline: string;
  errorInterrupted: string;
  retry: string;
  stopped: string;
  sku: string;
  priceSite: string;
  priceStore: string;
  priceOnRequest: string;
  openOnSite: string;
  disclaimer: string;
  you: string;
  assistant: string;
  newReply: string;
}

const PHONE = '+7 727 346-88-88';

const ru: Strings = {
  title: 'Консультант EKT',
  online: 'онлайн',
  launcher: 'Задать вопрос',
  launcherAria: 'Открыть чат с консультантом',
  close: 'Закрыть чат',
  newChat: 'Новый диалог',
  dialogLabel: 'Чат с консультантом',
  welcome:
    'Здравствуйте! Я ИИ-консультант ГК «Электрокомплект». Помогу подобрать товар, сравнить цены, найти ближайший филиал и разобраться с оплатой, доставкой и возвратом.',
  chips: ['Подобрать лампу для дома', 'Автомат на 25А', 'Адреса и график филиалов', 'Условия возврата'],
  placeholder: 'Спросите о товаре или условиях…',
  inputLabel: 'Ваш вопрос',
  send: 'Отправить',
  stop: 'Остановить ответ',
  thinking: 'Думаю…',
  helpful: 'Ответ помог',
  notHelpful: 'Ответ не помог',
  thanks: 'Спасибо за оценку!',
  whatWrong: 'Что было не так?',
  whatWrongPlaceholder: 'Необязательно',
  submit: 'Отправить',
  skip: 'Пропустить',
  feedbackFailed: 'Не удалось отправить оценку',
  errorGeneric: `Не удалось получить ответ. Попробуйте ещё раз или позвоните нам: ${PHONE}.`,
  errorOffline: `Нет подключения к интернету. Проверьте связь или позвоните нам: ${PHONE}.`,
  errorInterrupted: 'Связь прервалась до окончания ответа.',
  retry: 'Повторить',
  stopped: 'Ответ остановлен',
  sku: 'Арт.',
  priceSite: 'на сайте',
  priceStore: 'в магазине',
  priceOnRequest: 'Цена по запросу',
  openOnSite: 'Открыть на сайте',
  disclaimer: 'Цены для Алматы. Консультант — ИИ, может ошибаться; уточняйте у менеджера.',
  you: 'Вы',
  assistant: 'Консультант',
  newReply: 'Новый ответ консультанта',
};

const kk: Strings = {
  title: 'EKT кеңесшісі',
  online: 'желіде',
  launcher: 'Сұрақ қою',
  launcherAria: 'Кеңесшімен чатты ашу',
  close: 'Чатты жабу',
  newChat: 'Жаңа диалог',
  dialogLabel: 'Кеңесшімен чат',
  welcome:
    'Сәлеметсіз бе! Мен «Электрокомплект» ТК-ның ЖИ-кеңесшісімін. Тауар таңдауға, бағаларды салыстыруға, жақын филиалды табуға және төлем, жеткізу, қайтару шарттарын түсіндіруге көмектесемін.',
  chips: ['Үйге шам таңдау', '25А автоматы', 'Филиалдардың мекенжайы мен кестесі', 'Қайтару шарттары'],
  placeholder: 'Тауар немесе шарттар туралы сұраңыз…',
  inputLabel: 'Сұрағыңыз',
  send: 'Жіберу',
  stop: 'Жауапты тоқтату',
  thinking: 'Ойланып жатырмын…',
  helpful: 'Жауап көмектесті',
  notHelpful: 'Жауап көмектеспеді',
  thanks: 'Бағаңызға рахмет!',
  whatWrong: 'Не дұрыс болмады?',
  whatWrongPlaceholder: 'Міндетті емес',
  submit: 'Жіберу',
  skip: 'Өткізу',
  feedbackFailed: 'Бағаны жіберу мүмкін болмады',
  errorGeneric: `Жауап алу мүмкін болмады. Қайталап көріңіз немесе қоңырау шалыңыз: ${PHONE}.`,
  errorOffline: `Интернет байланысы жоқ. Байланысты тексеріңіз немесе қоңырау шалыңыз: ${PHONE}.`,
  errorInterrupted: 'Жауап аяқталмай тұрып байланыс үзілді.',
  retry: 'Қайталау',
  stopped: 'Жауап тоқтатылды',
  sku: 'Арт.',
  priceSite: 'сайтта',
  priceStore: 'дүкенде',
  priceOnRequest: 'Бағасы сұраныс бойынша',
  openOnSite: 'Сайтта ашу',
  disclaimer: 'Бағалар Алматы үшін. Кеңесші — ЖИ, қателесуі мүмкін; менеджерден нақтылаңыз.',
  you: 'Сіз',
  assistant: 'Кеңесші',
  newReply: 'Кеңесшіден жаңа жауап',
};

const en: Strings = {
  title: 'EKT Assistant',
  online: 'online',
  launcher: 'Ask a question',
  launcherAria: 'Open chat with the assistant',
  close: 'Close chat',
  newChat: 'New conversation',
  dialogLabel: 'Chat with the assistant',
  welcome:
    'Hello! I am the AI assistant of Elektrokomplekt. I can help you choose a product, compare prices, find the nearest branch and explain payment, delivery and returns.',
  chips: ['Pick a bulb for home', '25A circuit breaker', 'Branch addresses and hours', 'Return policy'],
  placeholder: 'Ask about a product or terms…',
  inputLabel: 'Your question',
  send: 'Send',
  stop: 'Stop answer',
  thinking: 'Thinking…',
  helpful: 'Helpful answer',
  notHelpful: 'Not helpful',
  thanks: 'Thanks for the feedback!',
  whatWrong: 'What went wrong?',
  whatWrongPlaceholder: 'Optional',
  submit: 'Send',
  skip: 'Skip',
  feedbackFailed: 'Could not send feedback',
  errorGeneric: `Could not get an answer. Please try again or call us: ${PHONE}.`,
  errorOffline: `You are offline. Check your connection or call us: ${PHONE}.`,
  errorInterrupted: 'The connection dropped before the answer finished.',
  retry: 'Retry',
  stopped: 'Answer stopped',
  sku: 'SKU',
  priceSite: 'online',
  priceStore: 'in store',
  priceOnRequest: 'Price on request',
  openOnSite: 'Open on site',
  disclaimer: 'Prices for Almaty. The assistant is an AI and can make mistakes; please confirm with a manager.',
  you: 'You',
  assistant: 'Assistant',
  newReply: 'New reply from the assistant',
};

const TABLE: Record<Lang, Strings> = { ru, kk, en };

export function detectLang(explicit?: string | null): Lang {
  const candidates = [explicit, document.documentElement.lang, ...(navigator.languages || []), navigator.language];
  for (const c of candidates) {
    const code = (c || '').toLowerCase().slice(0, 2);
    if (code === 'ru' || code === 'kk' || code === 'en') return code;
    if (code === 'kz') return 'kk';
  }
  return 'ru';
}

export function strings(lang: Lang): Strings {
  return TABLE[lang];
}
