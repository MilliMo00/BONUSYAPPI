// Переводы клиентского приложения. Админ-панель остаётся на русском.
import type { Locale } from '@contract/constants.ts';

type Forms = readonly string[];
type Entry = Record<Locale, string>;
type PluralEntry = Record<Locale, Forms>;

const STRINGS = {
  'nav.home': { ru: 'Главная', en: 'Home', uk: 'Головна' },
  'nav.roulette': { ru: 'Рулетка', en: 'Wheel', uk: 'Рулетка' },
  'nav.bonuses': { ru: 'Бонусы', en: 'Bonuses', uk: 'Бонуси' },
  'nav.profile': { ru: 'Профиль', en: 'Profile', uk: 'Профіль' },

  'home.hello': { ru: 'Привет, {name}', en: 'Hi, {name}', uk: 'Привіт, {name}' },
  'home.spinAvailable': { ru: 'Доступно вращение', en: 'Spin available', uk: 'Доступне обертання' },
  'home.tryLuck': { ru: 'Испытайте удачу', en: 'Try your luck', uk: 'Спробуйте удачу' },
  'home.promoText': {
    ru: 'Скидки и привилегии на ваш следующий заказ.',
    en: 'Discounts and perks for your next order.',
    uk: 'Знижки та привілеї на ваше наступне замовлення.',
  },
  'home.how': { ru: 'Как это работает', en: 'How it works', uk: 'Як це працює' },
  'home.step1.title': { ru: 'Крутите рулетку', en: 'Spin the wheel', uk: 'Крутіть рулетку' },
  'home.step1.text': {
    ru: 'Выигрыш сохраняется за вами и действует на следующий заказ.',
    en: 'Your prize is saved and applies to your next order.',
    uk: 'Виграш зберігається за вами й діє на наступне замовлення.',
  },
  'home.step2.title': {
    ru: 'Нажмите «Применить бонус»',
    en: 'Tap “Apply bonus”',
    uk: 'Натисніть «Застосувати бонус»',
  },
  'home.step2.text': {
    ru: 'Откроется чат с менеджером — сообщение с номером бонуса уже готово.',
    en: 'A chat with our manager opens — the message with your bonus number is ready to send.',
    uk: 'Відкриється чат із менеджером — повідомлення з номером бонусу вже готове.',
  },
  'home.step3.title': {
    ru: 'Менеджер активирует бонус',
    en: 'The manager activates it',
    uk: 'Менеджер активує бонус',
  },
  'home.step3.text': {
    ru: 'После этого вам откроется новое вращение.',
    en: 'After that you get a new spin.',
    uk: 'Після цього вам відкриється нове обертання.',
  },

  'bonus.nextOrder': {
    ru: 'Бонус действует на ваш следующий заказ.',
    en: 'This bonus applies to your next order.',
    uk: 'Бонус діє на ваше наступне замовлення.',
  },
  'bonus.firstOrder': {
    ru: 'Бонус действует на ваш первый заказ.',
    en: 'This bonus applies to your first order.',
    uk: 'Бонус діє на ваше перше замовлення.',
  },
  'bonus.apply': { ru: 'Применить бонус', en: 'Apply bonus', uk: 'Застосувати бонус' },
  'bonus.pendingHint': {
    ru: 'Вы отправили бонус менеджеру. Он активирует его при оформлении вашего следующего заказа.',
    en: 'You sent this bonus to our manager. It will be activated when you place your next order.',
    uk: 'Ви надіслали бонус менеджеру. Він активує його під час оформлення вашого наступного замовлення.',
  },
  'bonus.sent': {
    ru: 'Бонус отправлен менеджеру — он свяжется с вами в Telegram',
    en: 'Bonus sent to our manager — they will contact you in Telegram',
    uk: 'Бонус надіслано менеджеру — він зв’яжеться з вами в Telegram',
  },
  'bonus.message': {
    ru: 'Привет! Хочу сделать заказ и применить бонус «{name}».\nНомер бонуса: {code}',
    en: 'Hi! I’d like to place an order and apply my bonus “{name}”.\nBonus number: {code}',
    uk: 'Привіт! Хочу зробити замовлення і застосувати бонус «{name}».\nНомер бонусу: {code}',
  },
  'bonus.copied': {
    ru: 'Номер бонуса скопирован',
    en: 'Bonus number copied',
    uk: 'Номер бонусу скопійовано',
  },
  'bonus.copy': { ru: 'Скопировать номер бонуса', en: 'Copy bonus number', uk: 'Скопіювати номер бонусу' },
  'bonus.number': { ru: 'Номер бонуса', en: 'Bonus number', uk: 'Номер бонусу' },

  'status.ACTIVE': { ru: 'Активен', en: 'Active', uk: 'Активний' },
  'status.RESERVED': { ru: 'Ожидает активации', en: 'Awaiting activation', uk: 'Очікує активації' },
  'status.REDEEMED': { ru: 'Использован', en: 'Used', uk: 'Використано' },
  'status.EXPIRED': { ru: 'Истёк', en: 'Expired', uk: 'Термін сплив' },
  'status.CANCELLED': { ru: 'Аннулирован', en: 'Cancelled', uk: 'Анульовано' },

  'exp.none': { ru: 'Без срока действия', en: 'No expiry date', uk: 'Без терміну дії' },
  'exp.was': { ru: 'Действовал до {date}', en: 'Was valid until {date}', uk: 'Діяв до {date}' },
  'exp.pendingExpired': {
    ru: 'Срок истёк, но бонус уже у менеджера',
    en: 'Expired, but already with our manager',
    uk: 'Термін сплив, але бонус уже в менеджера',
  },
  'exp.expired': { ru: 'Срок действия истёк', en: 'Expired', uk: 'Термін дії сплив' },
  'exp.left': {
    ru: 'Осталось {n} {days} · до {date}',
    en: '{n} {days} left · until {date}',
    uk: 'Залишилось {n} {days} · до {date}',
  },
  'exp.until': { ru: 'Действует до {date}', en: 'Valid until {date}', uk: 'Діє до {date}' },

  'common.writeManager': { ru: 'Написать менеджеру', en: 'Message the manager', uk: 'Написати менеджеру' },
  'common.notFoundTitle': { ru: 'Страница не найдена', en: 'Page not found', uk: 'Сторінку не знайдено' },
  'common.notFoundText': {
    ru: 'Вернитесь на главную через меню внизу.',
    en: 'Use the menu below to go back.',
    uk: 'Поверніться на головну через меню внизу.',
  },

  'roulette.title': { ru: 'Рулетка', en: 'Wheel of bonuses', uk: 'Рулетка' },
  'roulette.spin': { ru: 'Крутить рулетку', en: 'Spin the wheel', uk: 'Крутити рулетку' },
  'roulette.spinning': { ru: 'Крутим…', en: 'Spinning…', uk: 'Крутимо…' },
  'roulette.available': { ru: 'Доступно:', en: 'Available:', uk: 'Доступно:' },
  'roulette.spinUntil': {
    ru: 'Вращение действует до {date} — потом сгорит',
    en: 'Your spin is valid until {date}, then it expires',
    uk: 'Обертання діє до {date} — потім згорить',
  },
  'roulette.myBonus': { ru: 'Мой бонус', en: 'My bonus', uk: 'Мій бонус' },
  'roulette.prizes': { ru: 'Что можно выиграть', en: 'What you can win', uk: 'Що можна виграти' },
  'roulette.oneBonus': {
    ru: 'Одновременно может быть один активный бонус. Он действует на ваш следующий заказ.',
    en: 'You can hold one active bonus at a time. It applies to your next order.',
    uk: 'Одночасно може бути один активний бонус. Він діє на ваше наступне замовлення.',
  },
  'roulette.soonTitle': {
    ru: 'Рулетка скоро заработает',
    en: 'The wheel is coming soon',
    uk: 'Рулетка скоро запрацює',
  },
  'roulette.soonText': {
    ru: 'Мы обновляем призы. Загляните чуть позже.',
    en: 'We are updating the prizes. Please check back later.',
    uk: 'Ми оновлюємо призи. Завітайте трохи пізніше.',
  },
  'roulette.wheelAria': { ru: 'Колесо с призами', en: 'Prize wheel', uk: 'Колесо з призами' },

  'win.kicker': { ru: 'Ваш выигрыш', en: 'You won', uk: 'Ваш виграш' },
  'win.toBonuses': { ru: 'Перейти к бонусам', en: 'Go to my bonuses', uk: 'Перейти до бонусів' },

  'avail.ACTIVE_BONUS': {
    ru: 'У тебя уже есть активный бонус! Используй его в следующем заказе, чтобы получить новый шанс на выигрыш.',
    en: 'You already have an active bonus! Use it on your next order to get another spin.',
    uk: 'У тебе вже є активний бонус! Використай його в наступному замовленні, щоб отримати новий шанс на виграш.',
  },
  'avail.NO_ATTEMPTS.BONUS_ACTIVATED': {
    ru: 'Сейчас попыток нет. Новая попытка появится после того, как вы используете бонус в заказе.',
    en: 'No spins right now. You will get a new one after you use your bonus on an order.',
    uk: 'Зараз спроб немає. Нова спроба з’явиться після того, як ви використаєте бонус у замовленні.',
  },
  'avail.NO_ATTEMPTS.NONE': {
    ru: 'Сейчас вращений нет. Новое вращение менеджер начислит после вашего следующего заказа.',
    en: 'No spins right now. Our manager will grant a new spin after your next order.',
    uk: 'Зараз обертань немає. Нове обертання менеджер нарахує після вашого наступного замовлення.',
  },

  'avail.NO_ATTEMPTS.ORDER': {
    ru: 'Сейчас попыток нет. Новая попытка появится после вашего следующего заказа.',
    en: 'No spins right now. You will get a new one after your next order.',
    uk: 'Зараз спроб немає. Нова спроба з’явиться після вашого наступного замовлення.',
  },
  'avail.COOLDOWN': {
    ru: 'Между вращениями должен пройти небольшой перерыв. Попробуйте позже.',
    en: 'Please wait a little between spins and try again later.',
    uk: 'Між обертаннями має минути невелика перерва. Спробуйте пізніше.',
  },
  'avail.NOT_CONFIGURED': {
    ru: 'Рулетка временно недоступна — мы обновляем призы. Загляните чуть позже.',
    en: 'The wheel is temporarily unavailable while we update the prizes. Please check back later.',
    uk: 'Рулетка тимчасово недоступна — ми оновлюємо призи. Завітайте трохи пізніше.',
  },
  'avail.BLOCKED': {
    ru: 'Участие в программе лояльности приостановлено. Напишите менеджеру, чтобы уточнить детали.',
    en: 'Your participation in the bonus program is paused. Please contact our manager for details.',
    uk: 'Участь у програмі лояльності призупинено. Напишіть менеджеру, щоб уточнити деталі.',
  },

  'bonuses.title': { ru: 'Мои бонусы', en: 'My bonuses', uk: 'Мої бонуси' },
  'bonuses.emptyTitle': { ru: 'Бонусов пока нет', en: 'No bonuses yet', uk: 'Бонусів поки немає' },
  'bonuses.emptyText': {
    ru: 'Выиграйте бонус в рулетке и примените его к следующему заказу.',
    en: 'Win a bonus on the wheel and apply it to your next order.',
    uk: 'Виграйте бонус у рулетці та застосуйте його до наступного замовлення.',
  },
  'bonuses.toRoulette': { ru: 'К рулетке', en: 'To the wheel', uk: 'До рулетки' },
  'bonuses.terms': { ru: 'Условия', en: 'Terms', uk: 'Умови' },
  'bonuses.history': { ru: 'История', en: 'History', uk: 'Історія' },
  'bonuses.received': { ru: 'Получен', en: 'Received', uk: 'Отримано' },
  'bonuses.srcSpin': { ru: 'рулетка', en: 'wheel', uk: 'рулетка' },
  'bonuses.srcManual': { ru: 'начислен менеджером', en: 'granted by manager', uk: 'нараховано менеджером' },
  'bonuses.validity': { ru: 'Срок действия', en: 'Valid', uk: 'Термін дії' },
  'bonuses.until': { ru: 'до {date}', en: 'until {date}', uk: 'до {date}' },
  'bonuses.noExpiry': { ru: 'бессрочно', en: 'no expiry', uk: 'безстроково' },
  'bonuses.sentToManager': { ru: 'Отправлен менеджеру', en: 'Sent to manager', uk: 'Надіслано менеджеру' },
  'bonuses.used': { ru: 'Использован', en: 'Used', uk: 'Використано' },
  'bonuses.termsTitle': { ru: 'Условия использования', en: 'Terms of use', uk: 'Умови використання' },
  'bonuses.ok': { ru: 'Понятно', en: 'Got it', uk: 'Зрозуміло' },
  'term.oneOrder': {
    ru: 'Бонус действует на один ваш следующий заказ.',
    en: 'The bonus applies to one order — your next one.',
    uk: 'Бонус діє на одне ваше наступне замовлення.',
  },
  'term.firstOrder': {
    ru: 'Приветственный бонус действует на ваш первый заказ.',
    en: 'This welcome bonus applies to your first order.',
    uk: 'Вітальний бонус діє на ваше перше замовлення.',
  },
  'term.min': {
    ru: 'Минимальная сумма заказа — {amount}.',
    en: 'Minimum order amount: {amount}.',
    uk: 'Мінімальна сума замовлення — {amount}.',
  },
  'term.max': {
    ru: 'Максимальная скидка — {amount}.',
    en: 'Maximum discount: {amount}.',
    uk: 'Максимальна знижка — {amount}.',
  },
  'term.services': {
    ru: 'Действует на услуги: {list}.',
    en: 'Valid for: {list}.',
    uk: 'Діє на послуги: {list}.',
  },
  'term.noStack': {
    ru: 'Не суммируется с другими скидками и акциями.',
    en: 'Cannot be combined with other discounts or offers.',
    uk: 'Не сумується з іншими знижками та акціями.',
  },
  'term.howApply': {
    ru: 'Чтобы применить бонус, нажмите «Применить бонус» и напишите менеджеру — номер бонуса уже будет в сообщении.',
    en: 'To use the bonus, tap “Apply bonus” and message our manager — the bonus number is already in the message.',
    uk: 'Щоб застосувати бонус, натисніть «Застосувати бонус» і напишіть менеджеру — номер бонусу вже буде в повідомленні.',
  },
  'term.usedAfter': {
    ru: 'Бонус считается использованным после того, как менеджер его активирует.',
    en: 'The bonus counts as used once our manager activates it.',
    uk: 'Бонус вважається використаним після того, як менеджер його активує.',
  },

  'profile.title': { ru: 'Профиль', en: 'Profile', uk: 'Профіль' },
  'profile.noUsername': { ru: 'username не указан', en: 'no username', uk: 'username не вказано' },
  'profile.since': { ru: 'В программе с', en: 'Member since', uk: 'У програмі з' },
  'profile.used': { ru: 'Использовано бонусов', en: 'Bonuses used', uk: 'Використано бонусів' },
  'profile.tgNote': {
    ru: 'Имя и username берутся из вашего аккаунта Telegram и обновляются автоматически.',
    en: 'Your name and username come from your Telegram account and update automatically.',
    uk: 'Ім’я та username беруться з вашого акаунта Telegram і оновлюються автоматично.',
  },
  'lang.title': { ru: 'Выберите язык', en: 'Choose your language', uk: 'Оберіть мову' },
  'profile.language': { ru: 'Язык', en: 'Language', uk: 'Мова' },
  'profile.admin': { ru: 'Админ-панель', en: 'Admin panel', uk: 'Адмін-панель' },
  'profile.activity': { ru: 'История активности', en: 'Activity', uk: 'Історія активності' },
  'profile.emptyTitle': { ru: 'Пока пусто', en: 'Nothing here yet', uk: 'Поки порожньо' },
  'profile.emptyText': {
    ru: 'Здесь появятся ваши вращения и бонусы.',
    en: 'Your spins and bonuses will appear here.',
    uk: 'Тут з’являться ваші обертання та бонуси.',
  },
  'profile.aria': { ru: 'Профиль', en: 'Profile', uk: 'Профіль' },

  'act.REGISTERED': {
    ru: 'Регистрация в программе лояльности',
    en: 'Joined the bonus program',
    uk: 'Реєстрація в програмі лояльності',
  },
  'act.SPIN_WON': { ru: 'Выигрыш в рулетке', en: 'Won a prize on the wheel', uk: 'Виграш у рулетці' },
  'act.BONUS_APPLIED': {
    ru: 'Бонус отправлен менеджеру',
    en: 'Bonus sent to manager',
    uk: 'Бонус надіслано менеджеру',
  },
  'act.BONUS_REDEEMED': { ru: 'Бонус активирован', en: 'Bonus activated', uk: 'Бонус активовано' },
  'act.BONUS_RETURNED': {
    ru: 'Бонус снова активен',
    en: 'Bonus is active again',
    uk: 'Бонус знову активний',
  },
  'act.BONUS_GRANTED': { ru: 'Начислен бонус', en: 'Bonus granted', uk: 'Нараховано бонус' },
  'act.SPIN_GRANTED': {
    ru: 'Начислено вращение рулетки',
    en: 'Spin granted',
    uk: 'Нараховано обертання рулетки',
  },

  'gate.title': { ru: 'Бонусная программа', en: 'Bonus program', uk: 'Бонусна програма' },
  'gate.text': {
    ru: 'Это приложение работает внутри Telegram. Откройте бота и нажмите «Открыть приложение».',
    en: 'This app works inside Telegram. Open the bot and tap “Open app”.',
    uk: 'Цей застосунок працює всередині Telegram. Відкрийте бота й натисніть «Відкрити застосунок».',
  },
  'gate.open': { ru: 'Открыть @{bot}', en: 'Open @{bot}', uk: 'Відкрити @{bot}' },
  'gate.staff': { ru: 'Вход для сотрудников', en: 'Staff sign-in', uk: 'Вхід для співробітників' },

  'err.title': { ru: 'Не удалось загрузить', en: 'Could not load', uk: 'Не вдалося завантажити' },
  'err.retry': { ru: 'Повторить', en: 'Try again', uk: 'Повторити' },
  'err.generic': {
    ru: 'Что-то пошло не так. Попробуйте ещё раз.',
    en: 'Something went wrong. Please try again.',
    uk: 'Щось пішло не так. Спробуйте ще раз.',
  },
  'err.network': {
    ru: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
    en: 'No connection to the server. Check your internet and try again.',
    uk: 'Немає зв’язку із сервером. Перевірте інтернет і спробуйте ще раз.',
  },
  'err.server': {
    ru: 'Сервер временно недоступен. Попробуйте ещё раз чуть позже.',
    en: 'The server is temporarily unavailable. Please try again later.',
    uk: 'Сервер тимчасово недоступний. Спробуйте ще раз трохи пізніше.',
  },
  'err.RATE_LIMITED': {
    ru: 'Слишком много запросов. Подождите немного и попробуйте снова.',
    en: 'Too many requests. Please wait a moment and try again.',
    uk: 'Забагато запитів. Зачекайте трохи й спробуйте знову.',
  },
  'err.UNAUTHORIZED': {
    ru: 'Откройте приложение через Telegram — данные входа не подтверждены.',
    en: 'Please open the app from Telegram — your sign-in could not be verified.',
    uk: 'Відкрийте застосунок через Telegram — дані входу не підтверджено.',
  },
  'err.BONUS_NOT_ACTIVE': {
    ru: 'Этот бонус уже использован или недействителен.',
    en: 'This bonus has already been used or is no longer valid.',
    uk: 'Цей бонус уже використано або він недійсний.',
  },
  'err.BONUS_EXPIRED': {
    ru: 'Срок действия бонуса истёк.',
    en: 'This bonus has expired.',
    uk: 'Термін дії бонусу сплив.',
  },
  'err.NOT_FOUND': { ru: 'Не найдено.', en: 'Not found.', uk: 'Не знайдено.' },
} as const satisfies Record<string, Entry>;

const PLURALS = {
  activeBonus: {
    ru: ['активный бонус', 'активных бонуса', 'активных бонусов'],
    en: ['active bonus', 'active bonuses'],
    uk: ['активний бонус', 'активні бонуси', 'активних бонусів'],
  },
  usedBonus: {
    ru: ['бонус использован', 'бонуса использовано', 'бонусов использовано'],
    en: ['bonus used', 'bonuses used'],
    uk: ['бонус використано', 'бонуси використано', 'бонусів використано'],
  },
  spin: {
    ru: ['вращение', 'вращения', 'вращений'],
    en: ['spin', 'spins'],
    uk: ['обертання', 'обертання', 'обертань'],
  },
  day: { ru: ['день', 'дня', 'дней'], en: ['day', 'days'], uk: ['день', 'дні', 'днів'] },
} as const satisfies Record<string, PluralEntry>;

export type TKey = keyof typeof STRINGS;

let current: Locale = 'ru';
export const getLocale = () => current;
export function setLocale(locale: Locale) {
  current = locale;
  document.documentElement.lang = locale;
}
export const LOCALE_TAG: Record<Locale, string> = { ru: 'ru-RU', en: 'en-GB', uk: 'uk-UA' };
export const localeTag = () => LOCALE_TAG[current];

export function t(key: TKey, params: Record<string, string | number> = {}): string {
  return STRINGS[key][current].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

/** Перевод по произвольному ключу (например, по коду ошибки с сервера); null, если такого ключа нет. */
export function tMaybe(key: string): string | null {
  return key in STRINGS ? STRINGS[key as TKey][current] : null;
}

/** Форма слова для числа: в русском и украинском три формы, в английском две. */
export function plural(n: number, word: keyof typeof PLURALS): string {
  const forms: Forms = PLURALS[word][current];
  if (current === 'en') return forms[n === 1 ? 0 : 1]!;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0]!;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]!;
  return forms[2]!;
}
