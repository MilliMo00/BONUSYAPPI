// Денежные суммы хранятся в NUMERIC(12,2) и приходят из БД строками.
// Вся арифметика — в целых минорных единицах (копейках), без чисел с плавающей точкой.
import type { PrizeType, RoundingRule } from '../contract/constants.ts';

const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

export function isMoney(value: string): boolean {
  return MONEY_RE.test(value);
}

export function toMinor(value: string): number {
  if (!MONEY_RE.test(value)) throw new Error(`Некорректная сумма: ${value}`);
  const [whole = '0', frac = ''] = value.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function fromMinor(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) throw new Error(`Некорректная сумма в копейках: ${minor}`);
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export interface DiscountTerms {
  type: PrizeType;
  value: string | null;
  minimumOrderAmount: string | null;
  maximumDiscountAmount: string | null;
  rules: { rounding: RoundingRule; allowedServices: string[] };
}

export interface DiscountResult {
  /** Скидка в минорных единицах */
  discount: number;
  applicable: boolean;
  /** Почему бонус нельзя применить к этому заказу */
  reason: string | null;
}

/** Рассчитывает скидку по условиям бонуса для заказа с известной стоимостью. */
export function computeDiscount(terms: DiscountTerms, subtotal: string, serviceType: string): DiscountResult {
  const allowed = terms.rules.allowedServices;
  if (allowed.length > 0 && !allowed.includes(serviceType)) {
    return {
      discount: 0,
      applicable: false,
      reason: `Бонус действует только на услуги: ${allowed.join(', ')}`,
    };
  }
  if (terms.type === 'PRIVILEGE') return { discount: 0, applicable: true, reason: null };

  const subtotalMinor = toMinor(subtotal);
  if (terms.minimumOrderAmount && subtotalMinor < toMinor(terms.minimumOrderAmount)) {
    return {
      discount: 0,
      applicable: false,
      reason: `Минимальная сумма заказа для этого бонуса — ${terms.minimumOrderAmount}`,
    };
  }
  if (!terms.value) return { discount: 0, applicable: false, reason: 'У бонуса не задан размер скидки' };

  let discount: number;
  if (terms.type === 'PERCENT_DISCOUNT') {
    // value — проценты с точностью до сотых; считаем в целых числах: копейки × сотые доли процента.
    const exact = BigInt(subtotalMinor) * BigInt(toMinor(terms.value)); // в десятитысячных долях копейки
    discount = round(exact, terms.rules.rounding);
  } else {
    discount = toMinor(terms.value);
  }
  if (terms.maximumDiscountAmount) discount = Math.min(discount, toMinor(terms.maximumDiscountAmount));
  discount = Math.min(discount, subtotalMinor);
  return { discount, applicable: true, reason: null };
}

/** exact — сумма в десятитысячных долях копейки; результат — в копейках. */
function round(exact: bigint, rule: RoundingRule): number {
  const unit = rule === 'CENT' ? 10_000n : 1_000_000n;
  const whole = exact / unit;
  const remainder = exact % unit;
  const up = rule !== 'FLOOR_UNIT' && remainder * 2n >= unit;
  const rounded = (whole + (up ? 1n : 0n)) * (rule === 'CENT' ? 1n : 100n);
  return Number(rounded);
}
