// Тексты бота и уведомлений клиентам на трёх языках. Админ-панель и сообщения сотрудникам — на русском.
import type { PrizeText, PrizeTranslations } from '../contract/api.ts';
import { guessLocale } from '../contract/constants.ts';
import type { Locale } from '../contract/constants.ts';

/** Язык клиента: выбранный им самим, а если ещё не выбирал — по настройкам Telegram. */
export function localeOf(user: { locale: Locale | null; languageCode: string | null }): Locale {
  return user.locale ?? guessLocale(user.languageCode);
}

const DATE_TAG: Record<Locale, string> = { ru: 'ru-RU', en: 'en-GB', uk: 'uk-UA' };
export function formatDate(value: unknown, locale: Locale): string {
  return new Date(String(value))
    .toLocaleDateString(DATE_TAG[locale], { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\s*[гр]\.$/, '');
}

/** Название, описание и условия приза или бонуса на нужном языке; без перевода — русский текст. */
export function localizePrize(
  item: { name: string; description: string; rules: { terms: string }; translations: PrizeTranslations },
  locale: Locale,
): PrizeText {
  const tr = locale === 'ru' ? undefined : item.translations?.[locale];
  return {
    name: tr?.name || item.name,
    description: tr?.description || item.description,
    terms: tr?.terms || item.rules.terms,
  };
}

interface BotTexts {
  /** Приветствие после выбора языка */
  welcome: (name: string, brand: string) => string[];
  appReady: string;
  appNotReady: string;
  openApp: string;
  menuButton: string;
  commandStart: string;
  commandLang: string;
  languageSaved: string;
}

export const BOT: Record<Locale, BotTexts> = {
  ru: {
    welcome: (name, brand) => [
      `Привет${name}! Это бонусная программа <b>${brand}</b>.`,
      '',
      '🎡 Крутите рулетку и выигрывайте бонусы',
      '🎁 Бонус действует на ваш следующий заказ',
      '💬 Нажмите «Применить бонус» — и менеджер всё оформит',
    ],
    appReady: 'Нажмите кнопку ниже, чтобы открыть приложение.',
    appNotReady: 'Приложение ещё настраивается — мы сообщим, когда оно будет доступно.',
    openApp: 'Открыть приложение',
    menuButton: 'Открыть',
    commandStart: 'Открыть бонусную программу',
    commandLang: 'Сменить язык',
    languageSaved: 'Язык: русский',
  },
  en: {
    welcome: (name, brand) => [
      `Hi${name}! This is the <b>${brand}</b> bonus program.`,
      '',
      '🎡 Spin the wheel and win bonuses',
      '🎁 Your bonus applies to your next order',
      '💬 Tap “Apply bonus” and our manager will take care of the rest',
    ],
    appReady: 'Tap the button below to open the app.',
    appNotReady: 'The app is still being set up — we will let you know when it is ready.',
    openApp: 'Open app',
    menuButton: 'Open',
    commandStart: 'Open the bonus program',
    commandLang: 'Change language',
    languageSaved: 'Language: English',
  },
  uk: {
    welcome: (name, brand) => [
      `Привіт${name}! Це бонусна програма <b>${brand}</b>.`,
      '',
      '🎡 Крутіть рулетку та вигравайте бонуси',
      '🎁 Бонус діє на ваше наступне замовлення',
      '💬 Натисніть «Застосувати бонус» — і менеджер усе оформить',
    ],
    appReady: 'Натисніть кнопку нижче, щоб відкрити застосунок.',
    appNotReady: 'Застосунок ще налаштовується — ми повідомимо, коли він буде доступний.',
    openApp: 'Відкрити застосунок',
    menuButton: 'Відкрити',
    commandStart: 'Відкрити бонусну програму',
    commandLang: 'Змінити мову',
    languageSaved: 'Мова: українська',
  },
};

/** Просьба выбрать язык показывается до выбора, поэтому сразу на трёх языках. */
export const LANGUAGE_PROMPT = '🌐 Выберите язык · Choose your language · Оберіть мову';
export const LANGUAGE_BUTTONS: { locale: Locale; text: string }[] = [
  { locale: 'ru', text: '🇷🇺 Русский' },
  { locale: 'en', text: '🇬🇧 English' },
  { locale: 'uk', text: '🇺🇦 Українська' },
];

type P = Record<string, unknown>;
type UserTemplates = Record<string, (p: P, e: (v: unknown) => string, until: string, code: string) => string>;

/** Уведомления клиенту. e — экранирование HTML; until и code — готовые строки про срок и номер бонуса. */
export const USER_TEMPLATES: Record<Locale, UserTemplates> = {
  ru: {
    SPIN_WON: (p, e, until, code) =>
      `🎉 <b>Вы выиграли: ${e(p.bonusName)}</b>\n\n${p.firstOrder ? 'Бонус действует на ваш <b>первый заказ</b>' : 'Бонус действует на ваш <b>следующий заказ</b>'}. Чтобы применить его, нажмите «Применить бонус» в приложении — откроется чат с менеджером.${code}${until}`,
    BONUS_GRANTED: (p, e, until, code) =>
      `🎁 <b>Вам начислен бонус: ${e(p.bonusName)}</b>\n\nОн действует на ваш следующий заказ и уже ждёт в разделе «Мои бонусы».${code}${until}`,
    SPIN_GRANTED: (_p, _e, until) =>
      `🎡 <b>Вам доступно вращение рулетки</b>\n\nОткройте приложение и испытайте удачу.${until}`,
    BONUS_ACTIVATED: (p, e, _until, code) =>
      `✅ Бонус «${e(p.bonusName)}» активирован и применён к вашему заказу.${code}${p.spinGranted ? '\n\n🎡 Вам доступно новое вращение рулетки.' : ''}`,
    BONUS_RETURNED: (p, e, until) =>
      `↩️ Бонус «${e(p.bonusName)}» снова активен — используйте его в следующем заказе.${until}`,
    BONUS_EXPIRING: (p, e, until) =>
      `⏳ Скоро истекает срок бонуса «${e(p.bonusName)}». Успейте применить его к заказу.${until}`,
  },
  en: {
    SPIN_WON: (p, e, until, code) =>
      `🎉 <b>You won: ${e(p.bonusName)}</b>\n\n${p.firstOrder ? 'The bonus applies to your <b>first order</b>' : 'The bonus applies to your <b>next order</b>'}. To use it, tap “Apply bonus” in the app — a chat with our manager will open.${code}${until}`,
    BONUS_GRANTED: (p, e, until, code) =>
      `🎁 <b>You received a bonus: ${e(p.bonusName)}</b>\n\nIt applies to your next order and is waiting in “My bonuses”.${code}${until}`,
    SPIN_GRANTED: (_p, _e, until) =>
      `🎡 <b>You have a spin available</b>\n\nOpen the app and try your luck.${until}`,
    BONUS_ACTIVATED: (p, e, _until, code) =>
      `✅ Your bonus “${e(p.bonusName)}” has been activated and applied to your order.${code}${p.spinGranted ? '\n\n🎡 A new spin is available.' : ''}`,
    BONUS_RETURNED: (p, e, until) =>
      `↩️ Your bonus “${e(p.bonusName)}” is active again — use it on your next order.${until}`,
    BONUS_EXPIRING: (p, e, until) =>
      `⏳ Your bonus “${e(p.bonusName)}” expires soon. Don't forget to apply it to an order.${until}`,
  },
  uk: {
    SPIN_WON: (p, e, until, code) =>
      `🎉 <b>Ви виграли: ${e(p.bonusName)}</b>\n\n${p.firstOrder ? 'Бонус діє на ваше <b>перше замовлення</b>' : 'Бонус діє на ваше <b>наступне замовлення</b>'}. Щоб застосувати його, натисніть «Застосувати бонус» у застосунку — відкриється чат із менеджером.${code}${until}`,
    BONUS_GRANTED: (p, e, until, code) =>
      `🎁 <b>Вам нараховано бонус: ${e(p.bonusName)}</b>\n\nВін діє на ваше наступне замовлення і вже чекає в розділі «Мої бонуси».${code}${until}`,
    SPIN_GRANTED: (_p, _e, until) =>
      `🎡 <b>Вам доступне обертання рулетки</b>\n\nВідкрийте застосунок і спробуйте удачу.${until}`,
    BONUS_ACTIVATED: (p, e, _until, code) =>
      `✅ Бонус «${e(p.bonusName)}» активовано й застосовано до вашого замовлення.${code}${p.spinGranted ? '\n\n🎡 Вам доступне нове обертання рулетки.' : ''}`,
    BONUS_RETURNED: (p, e, until) =>
      `↩️ Бонус «${e(p.bonusName)}» знову активний — використайте його в наступному замовленні.${until}`,
    BONUS_EXPIRING: (p, e, until) =>
      `⏳ Скоро спливає термін бонусу «${e(p.bonusName)}». Встигніть застосувати його до замовлення.${until}`,
  },
};

export const NOTIFY_LABELS: Record<Locale, { validUntil: string; bonusNumber: string }> = {
  ru: { validUntil: 'Действует до', bonusNumber: 'Номер бонуса' },
  en: { validUntil: 'Valid until', bonusNumber: 'Bonus number' },
  uk: { validUntil: 'Діє до', bonusNumber: 'Номер бонусу' },
};
