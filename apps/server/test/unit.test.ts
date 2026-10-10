import { describe, expect, it } from 'vitest';
import {
  effectivePermissions,
  manualTransitions,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
} from '../src/contract/constants.ts';
import { computeDiscount, fromMinor, toMinor } from '../src/lib/money.ts';
import type { DiscountTerms } from '../src/lib/money.ts';
import { computeExpiresAt } from '../src/services/bonuses.ts';
import { isConfigValid, pickPrize } from '../src/services/roulette.ts';
import { signInitData, signSession, verifyInitData, verifySession } from '../src/telegram/auth.ts';
import { BOT_TOKEN } from './helpers.ts';

const percent = (value: string, extra: Partial<DiscountTerms> = {}): DiscountTerms => ({
  type: 'PERCENT_DISCOUNT',
  value,
  minimumOrderAmount: null,
  maximumDiscountAmount: null,
  rules: { rounding: 'ROUND_UNIT', allowedServices: [] },
  ...extra,
});

describe('деньги', () => {
  it('переводит суммы в копейки и обратно без потерь', () => {
    expect(toMinor('1500')).toBe(150000);
    expect(toMinor('0.1')).toBe(10);
    expect(fromMinor(toMinor('19999.99'))).toBe('19999.99');
    // Классическая ловушка float: 0.1 + 0.2
    expect(fromMinor(toMinor('0.10') + toMinor('0.20'))).toBe('0.30');
    expect(() => toMinor('12.345')).toThrow();
    expect(() => toMinor('-5')).toThrow();
  });

  it('считает процентную скидку с округлением', () => {
    expect(computeDiscount(percent('15'), '10000.00', 'Баннер').discount).toBe(150000);
    // 15% от 3333 = 499.95
    expect(computeDiscount(percent('15'), '3333', 'Баннер').discount).toBe(50000); // к ближайшему целому
    const floor = percent('15', { rules: { rounding: 'FLOOR_UNIT', allowedServices: [] } });
    expect(computeDiscount(floor, '3333', 'Баннер').discount).toBe(49900);
    const cent = percent('15', { rules: { rounding: 'CENT', allowedServices: [] } });
    expect(computeDiscount(cent, '3333', 'Баннер').discount).toBe(49995);
    expect(
      computeDiscount(percent('12.5', { rules: { rounding: 'CENT', allowedServices: [] } }), '999.99', 'x')
        .discount,
    ).toBe(12500);
  });

  it('учитывает максимальную скидку, минимальную сумму и допустимые услуги', () => {
    expect(
      computeDiscount(percent('25', { maximumDiscountAmount: '2000' }), '20000', 'Баннер').discount,
    ).toBe(200000);
    const min = computeDiscount(percent('25', { minimumOrderAmount: '5000' }), '4999.99', 'Баннер');
    expect(min).toMatchObject({ applicable: false, discount: 0 });
    const service = computeDiscount(
      percent('25', { rules: { rounding: 'ROUND_UNIT', allowedServices: ['Логотип'] } }),
      '9000',
      'Баннер',
    );
    expect(service.applicable).toBe(false);
  });

  it('фиксированная скидка не превышает стоимость, привилегия не даёт скидки', () => {
    expect(computeDiscount({ ...percent('500'), type: 'FIXED_DISCOUNT' }, '300', 'x').discount).toBe(30000);
    expect(computeDiscount({ ...percent('0'), type: 'PRIVILEGE', value: null }, '300', 'x')).toMatchObject({
      applicable: true,
      discount: 0,
    });
  });
});

describe('выбор приза', () => {
  const list = [
    { name: 'A', probability: '35.00' },
    { name: 'B', probability: '25.00' },
    { name: 'C', probability: '20.00' },
    { name: 'D', probability: '15.00' },
    { name: 'E', probability: '5.00' },
  ];

  it('границы диапазонов соответствуют вероятностям', () => {
    expect(pickPrize(list, 0).name).toBe('A');
    expect(pickPrize(list, 3499).name).toBe('A');
    expect(pickPrize(list, 3500).name).toBe('B');
    expect(pickPrize(list, 5999).name).toBe('B');
    expect(pickPrize(list, 6000).name).toBe('C');
    expect(pickPrize(list, 9499).name).toBe('D');
    expect(pickPrize(list, 9500).name).toBe('E');
    expect(pickPrize(list, 9999).name).toBe('E');
  });

  it('полный перебор всех исходов даёт точное распределение', () => {
    const counts: Record<string, number> = {};
    for (let roll = 0; roll < 10_000; roll++) {
      const { name } = pickPrize(list, roll);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    expect(counts).toEqual({ A: 3500, B: 2500, C: 2000, D: 1500, E: 500 });
  });

  it('конфигурация корректна только при сумме ровно 100%', () => {
    expect(isConfigValid(list)).toBe(true);
    expect(isConfigValid([...list.slice(0, 4), { name: 'E', probability: '4.99' }])).toBe(false);
    expect(isConfigValid(list.slice(0, 1))).toBe(false);
  });
});

describe('статусы и права', () => {
  it('у каждого статуса описаны переходы, конечные статусы никуда не ведут', () => {
    for (const s of ORDER_STATUSES) expect(ORDER_TRANSITIONS[s]).toBeDefined();
    expect(ORDER_TRANSITIONS.COMPLETED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('вручную нельзя перейти в «Оплачен» и «Отменён»', () => {
    for (const s of ORDER_STATUSES) {
      expect(manualTransitions(s)).not.toContain('PAID');
      expect(manualTransitions(s)).not.toContain('CANCELLED');
    }
  });

  it('роли по умолчанию соответствуют модели доступа', () => {
    expect(effectivePermissions('MANAGER')).not.toContain('bonuses.redeem');
    expect(effectivePermissions('MANAGER')).not.toContain('payments.confirm');
    expect(effectivePermissions('TEAM_LEAD')).toContain('bonuses.redeem');
    expect(effectivePermissions('TEAM_LEAD')).not.toContain('payments.confirm');
    expect(effectivePermissions('FINANCE')).toContain('payments.confirm');
    const tech = effectivePermissions('TECH_ADMIN');
    for (const p of ['payments.confirm', 'bonuses.redeem', 'finance.view', 'orders.view'] as const)
      expect(tech).not.toContain(p);
    expect(effectivePermissions('MANAGER', { grant: ['bonuses.redeem'] })).toContain('bonuses.redeem');
    expect(effectivePermissions('OWNER', { revoke: ['staff.manage'] })).not.toContain('staff.manage');
  });
});

describe('срок действия бонуса', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  it('берёт срок приза, срок по умолчанию или делает бонус бессрочным', () => {
    expect(computeExpiresAt(7, 30, from)?.toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(computeExpiresAt(null, 30, from)?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(computeExpiresAt(0, 30, from)).toBeNull();
    expect(computeExpiresAt(null, null, from)).toBeNull();
  });
});

describe('подпись Telegram', () => {
  const user = { id: 42, first_name: 'Аня', username: 'anya' };

  it('принимает корректные данные', () => {
    expect(verifyInitData(signInitData(user, BOT_TOKEN), BOT_TOKEN, 3600)).toMatchObject({
      id: 42,
      username: 'anya',
    });
  });

  it('отклоняет подмену Telegram ID, чужой токен, устаревшие и пустые данные', () => {
    const signed = signInitData(user, BOT_TOKEN);
    const forged = new URLSearchParams(signed);
    forged.set('user', JSON.stringify({ ...user, id: 1 }));
    expect(verifyInitData(forged.toString(), BOT_TOKEN, 3600)).toBeNull();
    expect(
      verifyInitData(signInitData(user, '999:another-bot-token-aaaaaaaaaaaaaaaaaaaaaaa'), BOT_TOKEN, 3600),
    ).toBeNull();
    const old = signInitData(user, BOT_TOKEN, new Date(Date.now() - 2 * 3600_000));
    expect(verifyInitData(old, BOT_TOKEN, 3600)).toBeNull();
    expect(verifyInitData('', BOT_TOKEN, 3600)).toBeNull();
    expect(verifyInitData('user=%7B%22id%22%3A1%7D', BOT_TOKEN, 3600)).toBeNull();
    expect(verifyInitData('user=%7B%22id%22%3A1%7D&hash=zz', BOT_TOKEN, 3600)).toBeNull();
  });

  it('сессия админки: подпись и срок действия', () => {
    const secret = 's'.repeat(40);
    const token = signSession(42, secret, 60);
    expect(verifySession(token, secret)).toBe(42);
    expect(verifySession(token, 'x'.repeat(40))).toBeNull();
    expect(verifySession(token.replace(/^.{4}/, 'AAAA'), secret)).toBeNull();
    expect(verifySession(signSession(42, secret, -1), secret)).toBeNull();
    expect(verifySession(undefined, secret)).toBeNull();
  });
});
