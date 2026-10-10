import type { BonusDto } from '@contract/api.ts';
import type { BonusStatus, OrderStatus, PaymentStatus } from '@contract/constants.ts';
import { localeTag } from './i18n.ts';

const trimZeros = (v: string) => v.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

/** Сумма для показа. Расчёты выполняет только сервер — здесь строка лишь форматируется. */
export function money(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(localeTag(), {
      style: 'currency',
      currency,
      minimumFractionDigits: amount.endsWith('.00') ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${trimZeros(amount)} ${currency}`;
  }
}

export const date = (iso: string | null | undefined) =>
  iso
    ? new Date(iso)
        .toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })
        .replace(/\s*[гр]\.$/, '')
    : '—';
export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short' }) : '—';
export const dateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(localeTag(), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** Крупная подпись ценности бонуса: «−15%», «−500 ₽» или звезда для привилегии. */
export function bonusValue(b: Pick<BonusDto, 'type' | 'value'>, currency: string): string {
  if (b.type === 'PERCENT_DISCOUNT' && b.value) return `−${trimZeros(b.value)}%`;
  if (b.type === 'FIXED_DISCOUNT' && b.value) return `+${money(b.value, currency)}`;
  return '★';
}

export const ORDER_TONE: Record<OrderStatus, string> = {
  NEW: 'tone-info',
  PRICING: 'tone-warn',
  AWAITING_PAYMENT: 'tone-warn',
  PAID: 'tone-ok',
  IN_PROGRESS: 'tone-violet',
  REVIEW: 'tone-violet',
  COMPLETED: 'tone-ok',
  CANCELLED: 'tone-mute',
};
export const BONUS_TONE: Record<BonusStatus, string> = {
  ACTIVE: 'tone-ok',
  RESERVED: 'tone-warn',
  REDEEMED: 'tone-violet',
  EXPIRED: 'tone-mute',
  CANCELLED: 'tone-mute',
};
export const PAYMENT_TONE: Record<PaymentStatus, string> = {
  UNPAID: 'tone-mute',
  PAID: 'tone-ok',
  REFUNDED: 'tone-danger',
};

export const ORDER_NEXT_STEP: Record<OrderStatus, string> = {
  NEW: 'Менеджер свяжется с вами в Telegram, чтобы согласовать стоимость и сроки.',
  PRICING: 'Согласовываем стоимость. Ответьте менеджеру в Telegram, если он задал вопросы.',
  AWAITING_PAYMENT: 'Оплатите заказ по реквизитам от менеджера. Оплату подтвердит сотрудник агентства.',
  PAID: 'Оплата получена. Скоро возьмём заказ в работу.',
  IN_PROGRESS: 'Дизайнер работает над заказом.',
  REVIEW: 'Результат готов к проверке — напишите менеджеру правки или подтверждение.',
  COMPLETED: 'Заказ выполнен. Спасибо, что выбрали нас!',
  CANCELLED: 'Заказ отменён. Если это ошибка, напишите менеджеру.',
};
