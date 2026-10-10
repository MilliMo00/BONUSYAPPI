// Шаблоны Telegram-уведомлений. Все значения из payload экранируются.
// Уведомления клиентам о бонусах — на языке клиента (см. i18n.ts), сообщения сотрудникам — на русском.
import type { Config } from '../config.ts';
import { LOCALES } from '../contract/constants.ts';
import type { Locale } from '../contract/constants.ts';
import { escapeHtml as e } from '../telegram/client.ts';
import type { InlineButton } from '../telegram/client.ts';
import { BOT, formatDate, NOTIFY_LABELS, USER_TEMPLATES } from './i18n.ts';

/** Префиксы callback_data кнопок под уведомлением о применённом бонусе. */
export const CALLBACK = { activate: 'ba:', giveBack: 'br:', grantSpin: 'sg:' } as const;

const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale);

export interface Rendered {
  html: string;
  buttons?: InlineButton[][];
}

type P = Record<string, unknown>;
const s = (v: unknown) => e(String(v ?? ''));

const templates: Record<string, (p: P) => string> = {
  // ── Клиенту: заказы. Модуль заказов в интерфейсе не используется, тексты оставлены на русском. ──
  ORDER_CREATED: (p) =>
    `✅ <b>Заявка ${s(p.orderNumber)} принята</b>\n\nУслуга: ${s(p.serviceType)}${
      p.bonusName ? `\nБонус: ${s(p.bonusName)} — зарезервирован за заявкой` : ''
    }\n\nМенеджер свяжется с вами, чтобы согласовать стоимость и сроки.`,
  ORDER_STATUS: (p) => `📋 Заказ <b>${s(p.orderNumber)}</b>\nНовый статус: <b>${s(p.statusLabel)}</b>`,
  PAYMENT_CONFIRMED: (p) =>
    `💳 Оплата заказа <b>${s(p.orderNumber)}</b> подтверждена: ${s(p.amount)} ${s(p.currency)}.`,
  BONUS_REDEEMED: (p) =>
    `✨ Бонус «${s(p.bonusName)}» применён к заказу <b>${s(p.orderNumber)}</b>.${
      p.discount ? `\nСкидка: ${s(p.discount)} ${s(p.currency)}.` : ''
    }`,
  ORDER_CANCELLED: (p) =>
    `Заказ <b>${s(p.orderNumber)}</b> отменён.${p.reason ? `\nПричина: ${s(p.reason)}` : ''}`,

  // ── Команде ──
  TEAM_NEW_ORDER: (p) =>
    [
      `<b>НОВАЯ ЗАЯВКА${p.bonusName ? ' · С БОНУСОМ' : ''}</b>`,
      '',
      `Клиент: <a href="tg://user?id=${s(p.telegramId)}">${s(p.displayName)}</a>`,
      `Telegram: ${p.username ? `@${s(p.username)}` : 'username не указан'}`,
      `ID клиента: <code>${s(p.telegramId)}</code>`,
      `Номер заявки: <b>${s(p.orderNumber)}</b>`,
      '',
      `Услуга: ${s(p.serviceType)}`,
      `Описание: ${s(String(p.description ?? '').slice(0, 700))}`,
      ...(p.contact ? [`Контакт: ${s(p.contact)}`] : []),
      `Бонус: ${p.bonusName ? s(p.bonusName) : 'нет'}`,
      ...(p.bonusName ? ['Статус бонуса: зарезервирован'] : []),
      '',
      'Необходимо связаться с клиентом, согласовать стоимость и сроки.',
    ].join('\n'),
  TEAM_AWAITING_PAYMENT: (p) =>
    `💳 Заказ <b>${s(p.orderNumber)}</b> ожидает оплаты.\nКлиент: ${s(p.displayName)}\nК оплате: ${s(p.total)} ${s(p.currency)}\n\nПосле поступления денег подтвердите оплату в админ-панели.`,
  TEAM_BONUS_APPLIED: (p) =>
    [
      '🎁 <b>Клиент применяет бонус</b>',
      '',
      `Бонус: <b>${s(p.bonusName)}</b>`,
      `Номер: <code>${s(p.bonusCode)}</code>`,
      ...(p.firstOrder ? ['Приветственный бонус — на первый заказ клиента'] : []),
      `Клиент: <a href="tg://user?id=${s(p.telegramId)}">${s(p.displayName)}</a>${p.username ? ` (@${s(p.username)})` : ''}`,
      `ID клиента: <code>${s(p.telegramId)}</code>`,
      ...(p.expiresAt ? [`Действует до ${formatDate(p.expiresAt, 'ru')}`] : []),
      '',
      'Сверьте, что вам пишет именно этот аккаунт. Когда клиент оформит заказ, нажмите «Активировать» — бонус будет списан.',
    ].join('\n'),
  TEAM_BONUS_CONFIRM: (p) =>
    `🎁 Заказ <b>${s(p.orderNumber)}</b> оплачен. Подтвердите применение бонуса «${s(p.bonusName)}» в админ-панели.`,
};

export function render(type: string, recipientType: string, payload: P, config: Config): Rendered {
  const locale = isLocale(payload._locale) ? payload._locale : 'ru';
  const localized = recipientType === 'USER' ? USER_TEMPLATES[locale][type] : undefined;
  const template = templates[type];
  if (!localized && !template) throw new Error(`Неизвестный тип уведомления: ${type}`);
  const labels = NOTIFY_LABELS[locale];
  const html = localized
    ? localized(
        payload,
        s,
        payload.expiresAt ? `\n${labels.validUntil} ${formatDate(payload.expiresAt, locale)}.` : '',
        payload.bonusCode ? `\n${labels.bonusNumber}: <code>${s(payload.bonusCode)}</code>` : '',
      )
    : template!(payload);

  const appUrl = config.APP_URL?.startsWith('https://') ? config.APP_URL : null;
  const buttons: InlineButton[][] = [];
  if (recipientType === 'USER') {
    if (appUrl) buttons.push([{ text: BOT[locale].openApp, web_app: { url: appUrl } }]);
  } else if (type === 'TEAM_BONUS_APPLIED') {
    const id = String(payload.bonusId);
    buttons.push([
      { text: '✅ Активировать', callback_data: `${CALLBACK.activate}${id}` },
      { text: '↩️ Вернуть клиенту', callback_data: `${CALLBACK.giveBack}${id}` },
    ]);
    if (payload.username)
      buttons.push([{ text: 'Написать клиенту', url: `https://t.me/${String(payload.username)}` }]);
  } else {
    const row: InlineButton[] = [];
    if (payload.username)
      row.push({ text: 'Написать клиенту', url: `https://t.me/${String(payload.username)}` });
    if (appUrl && payload.orderId)
      row.push({ text: 'Открыть заказ', url: `${appUrl}/admin/orders/${String(payload.orderId)}` });
    if (row.length) buttons.push(row);
  }
  return { html, buttons: buttons.length ? buttons : undefined };
}
