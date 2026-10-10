import { createHash, createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLogs,
  bonuses,
  bonusHistory,
  payments,
  prizes,
  spinGrants,
  staff,
  users,
} from '../src/db/schema.ts';
import { enqueueExpiryReminders, expireDueBonuses } from '../src/services/bonuses.ts';
import { processNotifications } from '../src/services/notifications.ts';
import { spin } from '../src/services/roulette.ts';
import { TelegramError } from '../src/telegram/client.ts';
import {
  addStaff,
  BOT_TOKEN,
  call,
  createTestEnv,
  orderInput,
  resetDb,
  seedPrizes,
  tma,
  uuid,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

const CLIENT = tma(1001, 'Аня', 'anya');
const OWNER = tma(1);
const LEAD = tma(2);
const MANAGER = tma(3);
const FINANCE = tma(4);
const TECH = tma(5);

beforeEach(async () => {
  await resetDb(env.db);
  await seedPrizes(env.db);
  env.telegram.sent = [];
  env.telegram.calls = [];
  env.telegram.uploads = [];
  env.telegram.failFor.clear();
  env.telegram.failWith = null;
  await addStaff(env.db, 1, 'OWNER');
  await addStaff(env.db, 2, 'TEAM_LEAD');
  await addStaff(env.db, 3, 'MANAGER');
  await addStaff(env.db, 4, 'FINANCE');
  await addStaff(env.db, 5, 'TECH_ADMIN');
});

const count = async (table: string) =>
  Number((await env.db.execute(sql.raw(`select count(*) from ${table}`))).rows[0]!.count);
/** Отправляет очередь так, как будто задержка уведомлений о выигрыше уже прошла. */
async function flushNotifications() {
  await env.db.execute(sql`update notifications set next_attempt_at = now() where status = 'PENDING'`);
  await processNotifications(env.db, env.config, env.telegram, undefined, 50);
}
const post = (url: string, headers: Record<string, string>, body: unknown = {}) =>
  call(env.app, 'POST', url, headers, body);

/** Клиент выигрывает «Скидку 15%» (roll 6000) и оформляет заявку с бонусом. */
async function orderWithBonus(roll = 6000) {
  await call(env.app, 'GET', '/api/home', CLIENT);
  const [user] = await env.db.select().from(users).where(eq(users.telegramId, 1001));
  const won = await spin(env.ctx, user!, uuid(), () => roll);
  const order = await post('/api/orders', CLIENT, orderInput({ useBonus: true }));
  expect(order.status).toBe(201);
  return { orderId: order.body.id as string, bonusId: won.bonus.id, userId: user!.id };
}

/** Доводит заказ до статуса «Ожидает оплаты» со стоимостью subtotal. */
async function toAwaitingPayment(orderId: string, subtotal = '10000') {
  const priced = await post(`/api/admin/orders/${orderId}/price`, MANAGER, { subtotal });
  expect(priced.status).toBe(200);
  const res = await post(`/api/admin/orders/${orderId}/status`, MANAGER, { status: 'AWAITING_PAYMENT' });
  expect(res.status).toBe(200);
  return res.body;
}

describe('оплата и списание бонуса', () => {
  it('полный путь: цена → оплата → списание; скидка считается на сервере', async () => {
    const { orderId, bonusId } = await orderWithBonus();
    const awaiting = await toAwaitingPayment(orderId, '10000');
    expect(awaiting).toMatchObject({
      subtotal: '10000.00',
      discountAmount: '1500.00',
      totalAmount: '8500.00',
    });
    // Бонус всё ещё в резерве: создание заявки и согласование цены его не списывают.
    expect(awaiting.bonus.status).toBe('RESERVED');

    const paid = await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, {
      amount: '8500',
      paymentReference: 'перевод 123',
    });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'PAID', paymentStatus: 'PAID' });
    expect(paid.body.bonus.status).toBe('RESERVED');
    expect(paid.body.payments).toHaveLength(1);

    const redeemed = await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.bonusDetails).toMatchObject({
      status: 'REDEEMED',
      discountAmount: '1500.00',
      redeemedBy: 'TEAM_LEAD 2',
    });
    expect(redeemed.body.bonusDetails.redeemedOrder.id).toBe(orderId);

    const clientView = await call(env.app, 'GET', `/api/bonuses/${bonusId}`, CLIENT);
    expect(clientView.body).toMatchObject({ status: 'REDEEMED', discountAmount: '1500.00' });
    // Использованный бонус нельзя применить повторно.
    const again = await post('/api/orders', CLIENT, orderInput({ useBonus: true }));
    expect(again.body.error.code).toBe('NO_ACTIVE_BONUS');
    for (const type of [
      'PAYMENT_CONFIRMED',
      'BONUS_REDEEMED',
      'TEAM_BONUS_CONFIRM',
      'TEAM_AWAITING_PAYMENT',
    ]) {
      expect(await count(`notifications where notification_type = '${type}'`), type).toBeGreaterThan(0);
    }
  });

  it('без права подтвердить оплату нельзя; заявление клиента оплатой не считается', async () => {
    const { orderId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    for (const who of [MANAGER, LEAD, TECH, CLIENT]) {
      expect(
        (await post(`/api/admin/orders/${orderId}/confirm-payment`, who, { amount: '8500' })).status,
      ).toBe(403);
    }
    expect((await post(`/api/admin/orders/${orderId}/status`, MANAGER, { status: 'PAID' })).status).toBe(400);
    expect(await count('payments')).toBe(0);
    // Право можно выдать точечно.
    await env.db
      .update(staff)
      .set({ permissions: { grant: ['payments.confirm'], revoke: [] } })
      .where(eq(staff.telegramId, 2));
    expect(
      (await post(`/api/admin/orders/${orderId}/confirm-payment`, LEAD, { amount: '8500' })).status,
    ).toBe(200);
  });

  it('менеджер без права не может подтвердить использование бонуса', async () => {
    const { orderId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '8500' });
    expect((await post(`/api/admin/orders/${orderId}/redeem-bonus`, MANAGER)).status).toBe(403);
    expect((await post(`/api/admin/orders/${orderId}/redeem-bonus`, FINANCE)).status).toBe(403);
    expect(await count("bonuses where status = 'REDEEMED'")).toBe(0);
  });

  it('бонус нельзя списать до подтверждения оплаты', async () => {
    const { orderId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    const res = await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('повторные и параллельные подтверждения не списывают бонус и не проводят оплату дважды', async () => {
    const { orderId, bonusId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    const pays = await Promise.all(
      Array.from({ length: 8 }, () =>
        post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '8500.00' }),
      ),
    );
    expect(pays.every((r) => r.status === 200)).toBe(true);
    expect(await count('payments')).toBe(1);

    const redeems = await Promise.all(
      Array.from({ length: 8 }, () => post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD)),
    );
    expect(redeems.every((r) => r.status === 200)).toBe(true);
    const history = await env.db.select().from(bonusHistory).where(eq(bonusHistory.bonusId, bonusId));
    expect(history.filter((h) => h.newStatus === 'REDEEMED')).toHaveLength(1);
    expect(await count("audit_logs where action = 'bonus.redeem'")).toBe(1);
    expect(await count("audit_logs where action = 'payment.confirm'")).toBe(1);
    expect(await count("notifications where notification_type = 'BONUS_REDEEMED'")).toBe(1);
  });

  it('сумма оплаты должна совпадать с итогом; после оплаты цену изменить нельзя', async () => {
    const { orderId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    const wrong = await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '10000' });
    expect(wrong.body.error.code).toBe('AMOUNT_MISMATCH');
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '8500' });
    expect(
      (await post(`/api/admin/orders/${orderId}/price`, MANAGER, { subtotal: '1' })).body.error.code,
    ).toBe('ALREADY_PAID');
  });

  it('минимальная сумма заказа: скидка не применяется, списать бонус нельзя, резерв можно вернуть', async () => {
    await env.db.update(prizes).set({ minimumOrderAmount: '20000' });
    const { orderId, bonusId } = await orderWithBonus();
    const awaiting = await toAwaitingPayment(orderId, '10000');
    expect(awaiting).toMatchObject({ discountAmount: '0.00', totalAmount: '10000.00' });
    expect(awaiting.discountNote).toMatch(/Минимальная сумма/);
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '10000' });
    expect((await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD)).body.error.code).toBe(
      'BONUS_NOT_APPLICABLE',
    );
    const released = await post(`/api/admin/orders/${orderId}/release-bonus`, LEAD, {
      reason: 'Сумма меньше минимальной',
    });
    expect(released.status).toBe(200);
    const [bonus] = await env.db.select().from(bonuses).where(eq(bonuses.id, bonusId));
    expect(bonus).toMatchObject({ status: 'ACTIVE', reservedOrderId: null });
  });

  it('привилегия (не скидка) списывается без изменения суммы', async () => {
    const { orderId } = await orderWithBonus(3500); // «Бесплатная правка»
    const awaiting = await toAwaitingPayment(orderId, '7000');
    expect(awaiting).toMatchObject({ discountAmount: '0.00', totalAmount: '7000.00' });
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '7000' });
    const redeemed = await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD);
    expect(redeemed.body.bonusDetails).toMatchObject({ status: 'REDEEMED', discountAmount: '0.00' });
  });
});

describe('отмена заказа', () => {
  it('отмена неоплаченной заявки возвращает бонус в ACTIVE', async () => {
    const { orderId, bonusId } = await orderWithBonus();
    expect(
      (await post(`/api/admin/orders/${orderId}/cancel`, MANAGER, { reason: 'Клиент передумал' })).status,
    ).toBe(403);
    expect((await post(`/api/admin/orders/${orderId}/cancel`, LEAD, { reason: '' })).status).toBe(400);
    const res = await post(`/api/admin/orders/${orderId}/cancel`, LEAD, { reason: 'Клиент передумал' });
    expect(res.body).toMatchObject({ status: 'CANCELLED', bonus: null });
    const bonus = await call(env.app, 'GET', `/api/bonuses/${bonusId}`, CLIENT);
    expect(bonus.body).toMatchObject({ status: 'ACTIVE', reservedOrder: null });
    // Бонус снова можно применить.
    expect((await post('/api/orders', CLIENT, orderInput({ useBonus: true }))).status).toBe(201);
    expect(await count("notifications where notification_type = 'BONUS_RETURNED'")).toBe(1);
  });

  it('если срок истёк за время резерва — после отмены бонус получает EXPIRED', async () => {
    const { orderId, bonusId } = await orderWithBonus();
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    // Пока бонус в резерве, фоновая задача его не трогает.
    expect(await expireDueBonuses(env.db)).toBe(0);
    await post(`/api/admin/orders/${orderId}/cancel`, LEAD, { reason: 'Не договорились' });
    const [bonus] = await env.db.select().from(bonuses).where(eq(bonuses.id, bonusId));
    expect(bonus!.status).toBe('EXPIRED');
  });

  it('отмена оплаченного заказа не возвращает бонус автоматически', async () => {
    const { orderId, bonusId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '8500' });
    await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD);
    const cancelled = await post(`/api/admin/orders/${orderId}/cancel`, LEAD, {
      reason: 'Отмена после оплаты',
    });
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID' });
    let [bonus] = await env.db.select().from(bonuses).where(eq(bonuses.id, bonusId));
    expect(bonus!.status).toBe('REDEEMED');

    // Возврат — отдельное решение сотрудника с правом корректировки и обязательной причиной.
    expect(
      (await post(`/api/admin/bonuses/${bonusId}/correct`, LEAD, { reason: 'Вернуть бонус' })).status,
    ).toBe(403);
    expect((await post(`/api/admin/bonuses/${bonusId}/correct`, OWNER, {})).status).toBe(400);
    const corrected = await post(`/api/admin/bonuses/${bonusId}/correct`, OWNER, {
      reason: 'Заказ отменён по нашей вине',
    });
    expect(corrected.status).toBe(200);
    [bonus] = await env.db.select().from(bonuses).where(eq(bonuses.id, bonusId));
    expect(bonus).toMatchObject({ status: 'ACTIVE', redeemedOrderId: null });
    const [log] = await env.db.select().from(auditLogs).where(eq(auditLogs.action, 'bonus.correct'));
    expect(log!.details).toMatchObject({
      from: 'REDEEMED',
      reason: 'Заказ отменён по нашей вине',
      previousDiscountAmount: '1500.00',
    });
    expect(corrected.body.history.at(-1)).toMatchObject({
      previousStatus: 'REDEEMED',
      newStatus: 'ACTIVE',
      reason: 'Заказ отменён по нашей вине',
    });
  });

  it('использованный бонус нельзя вернуть, пока заказ не отменён', async () => {
    const { orderId, bonusId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '8500' });
    await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD);
    const res = await post(`/api/admin/bonuses/${bonusId}/correct`, OWNER, { reason: 'Просто так' });
    expect(res.body.error.code).toBe('ORDER_NOT_CANCELLED');
  });
});

describe('статусы заказа', () => {
  it('недопустимые переходы отклоняются', async () => {
    const { orderId } = await orderWithBonus();
    const bad = await post(`/api/admin/orders/${orderId}/status`, LEAD, { status: 'COMPLETED' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('TRANSITION_NOT_ALLOWED');
    // Нельзя выставить «Ожидает оплаты» без стоимости.
    expect(
      (await post(`/api/admin/orders/${orderId}/status`, LEAD, { status: 'AWAITING_PAYMENT' })).body.error
        .code,
    ).toBe('PRICE_REQUIRED');
    expect((await post(`/api/admin/orders/${orderId}/status`, LEAD, { status: 'CANCELLED' })).status).toBe(
      400,
    );
    expect((await post(`/api/admin/orders/${orderId}/status`, LEAD, { status: 'WHATEVER' })).status).toBe(
      400,
    );
    expect((await post(`/api/admin/orders/${orderId}/status`, FINANCE, { status: 'PRICING' })).status).toBe(
      403,
    );
  });

  it('выполнение заказа начисляет одно вращение — и только одно', async () => {
    await env.db.execute(
      sql`insert into settings (key, value) values ('app', '{"spinGrantTrigger":"ORDER_COMPLETED"}')`,
    );
    const { orderId, userId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '8500' });
    await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD);
    await post(`/api/admin/orders/${orderId}/status`, LEAD, { status: 'IN_PROGRESS' });
    const done = await post(`/api/admin/orders/${orderId}/status`, LEAD, { status: 'COMPLETED' });
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.statusHistory.map((h: { newStatus: string }) => h.newStatus)).toEqual([
      'NEW',
      'AWAITING_PAYMENT',
      'PAID',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
    await post(`/api/admin/orders/${orderId}/status`, LEAD, { status: 'COMPLETED' });
    const grants = await env.db.select().from(spinGrants).where(eq(spinGrants.sourceOrderId, orderId));
    expect(grants).toHaveLength(1);

    // Клиент крутит снова; новый бонус помнит заказ-источник и не применяется к нему же.
    const next = await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    expect(next.status).toBe(200);
    expect(next.body.bonus.sourceOrder).toBeNull(); // номер подтягивается в списке
    const [fresh] = await env.db.select().from(bonuses).where(eq(bonuses.id, next.body.bonus.id));
    expect(fresh!.sourceOrderId).toBe(orderId);
    expect((await call(env.app, 'GET', '/api/home', CLIENT)).body.me).toMatchObject({
      ordersCount: 1,
      redeemedBonusesCount: 1,
    });
    void userId;
  });

  it('бонус нельзя привязать к заказу, за который он получен', async () => {
    await env.db.execute(
      sql`insert into settings (key, value) values ('app', '{"spinGrantTrigger":"ORDER_PAID","welcomeSpins":0}')`,
    );
    await call(env.app, 'GET', '/api/home', CLIENT);
    const order = await post('/api/orders', CLIENT, orderInput());
    await toAwaitingPayment(order.body.id, '5000');
    await post(`/api/admin/orders/${order.body.id}/confirm-payment`, FINANCE, { amount: '5000' });
    expect((await post('/api/roulette/spin', CLIENT, { requestId: uuid() })).status).toBe(200);
    // Заказ уже оплачен — привязка запрещена; а до оплаты сработала бы проверка источника.
    const attach = await post(`/api/admin/orders/${order.body.id}/attach-bonus`, LEAD);
    expect(attach.status).toBe(409);
  });
});

describe('доступ сотрудников', () => {
  it('разделы доступны согласно ролям', async () => {
    await orderWithBonus();
    expect((await call(env.app, 'GET', '/api/admin/clients', OWNER)).body.total).toBe(1);
    expect((await call(env.app, 'GET', '/api/admin/orders', OWNER)).body.total).toBe(1);
    expect((await call(env.app, 'GET', '/api/admin/orders', MANAGER)).status).toBe(200);
    // Тех. администратор не видит клиентов, заказы и финансы.
    for (const url of [
      '/api/admin/clients',
      '/api/admin/orders',
      '/api/admin/bonuses',
      '/api/admin/stats',
      '/api/admin/export/orders.csv',
    ]) {
      expect((await call(env.app, 'GET', url, TECH)).status, url).toBe(403);
    }
    expect((await call(env.app, 'GET', '/api/admin/audit', TECH)).status).toBe(200);
    expect((await call(env.app, 'GET', '/api/admin/audit', MANAGER)).status).toBe(403);
    expect((await call(env.app, 'GET', '/api/admin/staff', FINANCE)).status).toBe(200);
    expect(
      (await post('/api/admin/staff', LEAD, { telegramId: 99, displayName: 'X', role: 'OWNER' })).status,
    ).toBe(403);
    // Финансовые показатели скрыты от ролей без finance.view.
    expect((await call(env.app, 'GET', '/api/admin/dashboard', MANAGER)).body.finance).toBeNull();
    expect((await call(env.app, 'GET', '/api/admin/dashboard', FINANCE)).body.finance).not.toBeNull();
    expect((await call(env.app, 'GET', '/api/admin/clients', MANAGER)).body.items[0].ordersTotal).toBeNull();
  });

  it('отзыв доступа действует сразу', async () => {
    expect((await call(env.app, 'GET', '/api/admin/me', MANAGER)).status).toBe(200);
    const [m] = await env.db.select().from(staff).where(eq(staff.telegramId, 3));
    const res = await call(env.app, 'PATCH', `/api/admin/staff/${m!.id}`, OWNER, { isActive: false });
    expect(res.body.isActive).toBe(false);
    expect((await call(env.app, 'GET', '/api/admin/me', MANAGER)).status).toBe(403);
    expect(await count("audit_logs where action = 'staff.update'")).toBe(1);
  });

  it('единственного владельца нельзя отключить или понизить', async () => {
    const [owner] = await env.db.select().from(staff).where(eq(staff.telegramId, 1));
    expect(
      (await call(env.app, 'PATCH', `/api/admin/staff/${owner!.id}`, OWNER, { isActive: false })).body.error
        .code,
    ).toBe('LAST_OWNER');
    expect(
      (await call(env.app, 'PATCH', `/api/admin/staff/${owner!.id}`, OWNER, { role: 'MANAGER' })).body.error
        .code,
    ).toBe('LAST_OWNER');
  });

  it('вход в админку из браузера: виджет Telegram и cookie-сессия', async () => {
    const sign = (data: Record<string, string | number>) => {
      const check = Object.keys(data)
        .sort()
        .map((k) => `${k}=${data[k]}`)
        .join('\n');
      return {
        ...data,
        hash: createHmac('sha256', createHash('sha256').update(BOT_TOKEN).digest())
          .update(check)
          .digest('hex'),
      };
    };
    const now = Math.floor(Date.now() / 1000);
    const forged = { ...sign({ id: 3, first_name: 'M', auth_date: now }), id: 1 };
    expect((await post('/api/admin/auth/widget', {}, forged)).status).toBe(401);
    // Подпись верна, но человек не сотрудник.
    expect(
      (await post('/api/admin/auth/widget', {}, sign({ id: 777, first_name: 'N', auth_date: now }))).status,
    ).toBe(403);

    const res = await env.app.inject({
      method: 'POST',
      url: '/api/admin/auth/widget',
      payload: sign({ id: 1, first_name: 'O', auth_date: now }),
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'yappi_admin')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/admin' });
    const me = await call(env.app, 'GET', '/api/admin/me', { cookie: `yappi_admin=${cookie.value}` });
    expect(me.body.staff.role).toBe('OWNER');
    expect(
      (await call(env.app, 'GET', '/api/admin/me', { cookie: `yappi_admin=${cookie.value}x` })).status,
    ).toBe(401);
    // Знание адреса админки ничего не даёт.
    expect((await call(env.app, 'GET', '/api/admin/dashboard')).status).toBe(401);
  });
});

describe('настройки рулетки', () => {
  const load = async () =>
    (await call(env.app, 'GET', '/api/admin/prizes', OWNER)).body.items as Record<string, unknown>[];

  it('некорректная сумма вероятностей не сохраняется', async () => {
    const list = await load();
    list[0]!.probability = '40';
    const res = await call(env.app, 'PUT', '/api/admin/prizes', OWNER, { prizes: list });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PROBABILITY_SUM');
    expect((await load())[0]!.probability).toBe('35.00');
    expect((await call(env.app, 'PUT', '/api/admin/prizes', LEAD, { prizes: await load() })).status).toBe(
      403,
    );
  });

  it('изменения влияют на новые вращения и не меняют уже выданные бонусы', async () => {
    const { bonusId } = await orderWithBonus(); // «Скидка 15%»
    const list = await load();
    for (const p of list) {
      if (p.name === 'Скидка 15%')
        Object.assign(p, { name: 'Скидка 50%', value: '50', probability: '0', isActive: false });
      if (p.name === 'Скидка 25%') Object.assign(p, { probability: '25' });
    }
    list.push({
      name: 'Новый приз',
      description: '',
      type: 'FIXED_DISCOUNT',
      value: '500',
      probability: '0',
      isActive: false,
      validityDays: 7,
      minOrderAmount: '3000',
      maxDiscountAmount: null,
      sortOrder: 9,
      rules: { rounding: 'CENT', allowedServices: ['Логотип'], stackable: false, terms: 'Только логотипы' },
    });
    const saved = await call(env.app, 'PUT', '/api/admin/prizes', OWNER, { prizes: list });
    expect(saved.status).toBe(200);
    expect(saved.body.items).toHaveLength(6);
    expect(await count("audit_logs where action = 'roulette.update'")).toBe(1);

    // Уже выданный бонус остался «Скидкой 15%».
    const [bonus] = await env.db.select().from(bonuses).where(eq(bonuses.id, bonusId));
    expect(bonus).toMatchObject({ name: 'Скидка 15%', value: '15.00' });

    // Новые вращения идут по новой конфигурации: 10000 исходов → отключённый приз не выпадает ни разу.
    const { activePrizes, pickPrize } = await import('../src/services/roulette.ts');
    const active = await activePrizes(env.db);
    const names = new Set<string>();
    let wins25 = 0;
    for (let roll = 0; roll < 10_000; roll++) {
      const p = pickPrize(active, roll);
      names.add(p.name);
      if (p.name === 'Скидка 25%') wins25++;
    }
    expect(names.has('Скидка 50%')).toBe(false);
    expect(wins25).toBe(2500);
  });

  it('удалённый из настроек приз архивируется, история выигрышей сохраняется', async () => {
    const { bonusId } = await orderWithBonus(0); // «Скидка 10%»
    const list = (await load()).filter((p) => p.name !== 'Скидка 10%');
    list.find((p) => p.name === 'Скидка 25%')!.probability = '40';
    expect((await call(env.app, 'PUT', '/api/admin/prizes', OWNER, { prizes: list })).status).toBe(200);
    expect(await load()).toHaveLength(4);
    expect(await count('prizes')).toBe(5);
    const [bonus] = await env.db.select().from(bonuses).where(eq(bonuses.id, bonusId));
    expect(bonus!.name).toBe('Скидка 10%');
  });
});

describe('ручные операции с бонусами', () => {
  it('ручная выдача требует права и причины и попадает в журнал', async () => {
    await call(env.app, 'GET', '/api/home', CLIENT);
    const [user] = await env.db.select().from(users);
    const [prize] = await env.db.select().from(prizes).where(eq(prizes.name, 'Скидка 25%'));
    const body = { userId: user!.id, prizeId: prize!.id, reason: 'Компенсация за задержку' };
    expect((await post('/api/admin/bonuses/grant', LEAD, body)).status).toBe(403);
    expect((await post('/api/admin/bonuses/grant', OWNER, { ...body, reason: '' })).status).toBe(400);
    const granted = await post('/api/admin/bonuses/grant', OWNER, body);
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({ status: 'ACTIVE', source: 'MANUAL', name: 'Скидка 25%' });
    expect(granted.body.history[0]).toMatchObject({
      newStatus: 'ACTIVE',
      reason: 'Компенсация за задержку',
      actor: 'OWNER 1',
    });
    const [log] = await env.db.select().from(auditLogs).where(eq(auditLogs.action, 'bonus.grant_manual'));
    expect(log).toMatchObject({ actorRole: 'OWNER', entityId: granted.body.id });
    expect(log!.details).toMatchObject({ reason: 'Компенсация за задержку' });
    // Второй бонус тому же клиенту выдать нельзя.
    expect((await post('/api/admin/bonuses/grant', OWNER, body)).body.error.code).toBe('ACTIVE_BONUS_EXISTS');
    // Аннулирование — тоже с причиной и записью в журнал.
    const cancelled = await post(`/api/admin/bonuses/${granted.body.id}/cancel`, OWNER, {
      reason: 'Выдан по ошибке',
    });
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await count("audit_logs where action = 'bonus.cancel'")).toBe(1);
    expect(await count('bonuses')).toBe(1); // запись не удаляется
  });

  it('ограничение БД не допускает второй открытый бонус даже в обход сервиса', async () => {
    const { userId } = await orderWithBonus();
    const [prize] = await env.db.select().from(prizes).limit(1);
    await expect(
      env.db.insert(bonuses).values({
        code: 'YB-TEST22',
        userId,
        prizeId: prize!.id,
        source: 'MANUAL',
        name: 'x',
        type: 'PRIVILEGE',
        rules: prize!.rules,
      }),
    ).rejects.toThrow();
  });
});

describe('уведомления', () => {
  it('сбой Telegram не теряет заказ; уведомление уходит при повторе', async () => {
    env.telegram.failTemporarily();
    const order = await post('/api/orders', CLIENT, orderInput());
    expect(order.status).toBe(201);
    await processNotifications(env.db, env.config, env.telegram);
    expect(env.telegram.sent).toHaveLength(0);
    expect(
      await count("notifications where status = 'PENDING' and attempts = 1 and last_error is not null"),
    ).toBeGreaterThan(0);
    expect((await call(env.app, 'GET', `/api/orders/${order.body.id}`, CLIENT)).status).toBe(200);

    env.telegram.failWith = null;
    await env.db.execute(sql`update notifications set next_attempt_at = now()`);
    await processNotifications(env.db, env.config, env.telegram);
    expect(
      env.telegram.sent.some((m) => m.chatId === '1001' && m.html.includes(order.body.orderNumber)),
    ).toBe(true);
    expect(await count("notifications where status = 'PENDING'")).toBe(0);
    // Повторный проход ничего не отправляет второй раз.
    const before = env.telegram.sent.length;
    await processNotifications(env.db, env.config, env.telegram);
    expect(env.telegram.sent.length).toBe(before);
  });

  it('команда получает заявку с данными клиента; HTML экранируется', async () => {
    await post(
      '/api/orders',
      tma(1001, '<b>Аня</b>', 'anya'),
      orderInput({ description: 'Нужен <script>alert(1)</script> баннер', useBonus: false }),
    );
    await processNotifications(env.db, env.config, env.telegram);
    // Рабочий чат не настроен — уведомление уходит сотрудникам с доступом к заказам (не тех. администратору).
    const team = env.telegram.sent.filter((m) => m.html.includes('НОВАЯ ЗАЯВКА'));
    expect(team.map((m) => m.chatId).sort()).toEqual(['1', '2', '3', '4']);
    expect(team[0]!.html).toContain('ID клиента: <code>1001</code>');
    expect(team[0]!.html).toContain('@anya');
    expect(team[0]!.html).toContain('&lt;script&gt;');
    expect(team[0]!.html).not.toContain('<script>');
  });

  it('рабочий чат из настроек получает одно сообщение', async () => {
    const settings = (await call(env.app, 'GET', '/api/admin/me', OWNER)).body.settings;
    const saved = await call(env.app, 'PUT', '/api/admin/settings', OWNER, {
      ...settings,
      teamChatId: '-1001234567890',
    });
    expect(saved.status).toBe(200);
    expect((await call(env.app, 'PUT', '/api/admin/settings', LEAD, settings)).status).toBe(403);
    expect(
      (
        await call(env.app, 'PUT', '/api/admin/settings', OWNER, {
          ...settings,
          managerContactUrl: 'javascript:alert(1)',
        })
      ).status,
    ).toBe(400);
    await orderWithBonus();
    await processNotifications(env.db, env.config, env.telegram, undefined, 50);
    const team = env.telegram.sent.filter((m) => m.html.includes('НОВАЯ ЗАЯВКА'));
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({ chatId: '-1001234567890' });
    expect(team[0]!.html).toContain('Статус бонуса: зарезервирован');
    expect(await count("audit_logs where action = 'settings.update'")).toBe(1);
  });

  it('клиент заблокировал бота — уведомление помечается FAILED без бесконечных повторов', async () => {
    env.telegram.failWith = new TelegramError(403, 'Forbidden: bot was blocked by the user');
    await post('/api/orders', CLIENT, orderInput());
    await processNotifications(env.db, env.config, env.telegram);
    expect(await count("notifications where status = 'PENDING'")).toBe(0);
    expect(await count("notifications where status = 'FAILED'")).toBeGreaterThan(0);
    expect(await count('orders')).toBe(1);
  });

  it('напоминание об истечении ставится один раз; истёкшие бонусы закрываются задачей', async () => {
    await call(env.app, 'POST', '/api/roulette/spin', CLIENT, { requestId: uuid() });
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() + 86_400_000) });
    expect(await enqueueExpiryReminders(env.ctx)).toBe(1);
    await enqueueExpiryReminders(env.ctx);
    expect(await count("notifications where notification_type = 'BONUS_EXPIRING'")).toBe(1);
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await expireDueBonuses(env.db)).toBe(1);
    expect(await count("bonuses where status = 'EXPIRED'")).toBe(1);
    expect(await count("bonus_history where new_status = 'EXPIRED'")).toBe(1);
  });
});

describe('применение и активация бонуса', () => {
  const hook = (body: unknown) =>
    post(
      '/api/telegram/webhook',
      { 'x-telegram-bot-api-secret-token': env.config.TELEGRAM_WEBHOOK_SECRET! },
      body,
    );
  const press = (fromId: number, data: string) =>
    hook({
      update_id: 9,
      callback_query: {
        id: 'cb1',
        from: { id: fromId },
        data,
        message: { message_id: 55, chat: { id: fromId }, text: 'Клиент применяет бонус' },
      },
    });

  async function win() {
    const res = await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    expect(res.status).toBe(200);
    return res.body.bonus as { id: string; code: string; expiresAt: string; createdAt: string };
  }

  it('бонус действует 14 дней по умолчанию', async () => {
    const bonus = await win();
    const days = (new Date(bonus.expiresAt).getTime() - new Date(bonus.createdAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
  });

  it('клиент применяет бонус: он ждёт активации, повторно применить нельзя, владелец и тимлид получают кнопки', async () => {
    const bonus = await win();
    const applied = await post(`/api/bonuses/${bonus.id}/apply`, CLIENT);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ status: 'RESERVED', code: bonus.code });
    expect(applied.body.appliedAt).not.toBeNull();

    // Повторные и одновременные нажатия ничего не меняют и не рассылают уведомления заново.
    const again = await Promise.all(
      Array.from({ length: 6 }, () => post(`/api/bonuses/${bonus.id}/apply`, CLIENT)),
    );
    expect(again.every((r) => r.status === 200 && r.body.status === 'RESERVED')).toBe(true);
    expect(await count("bonus_history where new_status = 'RESERVED'")).toBe(1);
    expect(await count("notifications where notification_type = 'TEAM_BONUS_APPLIED'")).toBe(2);

    await processNotifications(env.db, env.config, env.telegram, undefined, 50);
    const team = env.telegram.sent.filter((m) => m.html.includes('Клиент применяет бонус'));
    // Только сотрудники с правом активации: владелец и тимлид. Менеджер, финансы и тех. админ — нет.
    expect(team.map((m) => m.chatId).sort()).toEqual(['1', '2']);
    expect(team[0]!.html).toContain(bonus.code);
    expect(team[0]!.html).toContain('@anya');
    expect(team[0]!.html).toContain('ID клиента: <code>1001</code>');
    expect(team[0]!.buttons![0]!.map((b) => b.callback_data)).toEqual([`ba:${bonus.id}`, `br:${bonus.id}`]);

    // Пока бонус ждёт активации, рулетка закрыта.
    expect((await call(env.app, 'GET', '/api/roulette', CLIENT)).body.availability.reason).toBe(
      'ACTIVE_BONUS',
    );
  });

  it('чужой бонус применить нельзя; истёкший — тоже', async () => {
    const bonus = await win();
    expect((await post(`/api/bonuses/${bonus.id}/apply`, tma(1002))).status).toBe(404);
    expect((await post('/api/bonuses/not-a-uuid/apply', CLIENT)).status).toBe(404);
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await post(`/api/bonuses/${bonus.id}/apply`, CLIENT);
    expect(expired.body.error.code).toBe('BONUS_EXPIRED');
    const [row] = await env.db.select().from(bonuses);
    expect(row!.status).toBe('EXPIRED');
    expect(await count("notifications where notification_type = 'TEAM_BONUS_APPLIED'")).toBe(0);
  });

  it('кнопка «Активировать» списывает бонус один раз; вращение начисляется отдельной кнопкой', async () => {
    const bonus = await win();
    await post(`/api/bonuses/${bonus.id}/apply`, CLIENT);

    // Посторонний, клиент и сотрудник без права нажать кнопку не могут.
    for (const stranger of [999, 1001, 3, 4, 5]) {
      await press(stranger, `ba:${bonus.id}`);
      const [row] = await env.db.select().from(bonuses);
      expect(row!.status, String(stranger)).toBe('RESERVED');
    }
    expect(env.telegram.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);

    env.telegram.calls = [];
    expect((await press(2, `ba:${bonus.id}`)).status).toBe(200);
    const [row] = await env.db.select().from(bonuses);
    expect(row).toMatchObject({ status: 'REDEEMED' });
    const edit = env.telegram.calls.find((c) => c.method === 'editMessageText')!;
    expect(String(edit.body.text)).toContain('Активирован · TEAM_LEAD 2');
    // Вместо двух кнопок остаётся одна — «Начислить вращение».
    expect(JSON.stringify(edit.body.reply_markup)).toBe(
      JSON.stringify({
        inline_keyboard: [[{ text: '🎡 Начислить вращение', callback_data: `sg:${bonus.id}` }]],
      }),
    );

    // Владелец жмёт свою копию кнопки позже — второго списания нет.
    await press(1, `ba:${bonus.id}`);
    expect(await count("bonus_history where new_status = 'REDEEMED'")).toBe(1);
    expect(await count("audit_logs where action = 'bonus.activate'")).toBe(1);

    // Сама активация вращение не даёт: клиент не может крутить, пока сотрудник его не начислит.
    expect(await count('spin_grants where consumed_at is null')).toBe(0);
    let home = (await call(env.app, 'GET', '/api/home', CLIENT)).body;
    expect(home.activeBonus).toBeNull();
    expect(home.availability).toMatchObject({ canSpin: false, reason: 'NO_ATTEMPTS' });
    expect((await post(`/api/bonuses/${bonus.id}/apply`, CLIENT)).body.error.code).toBe('BONUS_NOT_ACTIVE');

    // Кнопка «Начислить вращение»: менеджер не может, тимлид может, второй раз — отказ.
    await press(3, `sg:${bonus.id}`);
    expect(await count('spin_grants where consumed_at is null')).toBe(0);
    env.telegram.calls = [];
    await press(2, `sg:${bonus.id}`);
    expect(await count("spin_grants where consumed_at is null and source = 'MANUAL'")).toBe(1);
    expect(String(env.telegram.calls.find((c) => c.method === 'editMessageText')!.body.text)).toContain(
      'Вращение начислено',
    );
    await press(1, `sg:${bonus.id}`);
    expect(await count('spin_grants where consumed_at is null')).toBe(1);
    home = (await call(env.app, 'GET', '/api/home', CLIENT)).body;
    expect(home.availability).toMatchObject({ canSpin: true, attempts: 1 });
    expect((await post('/api/roulette/spin', CLIENT, { requestId: uuid() })).status).toBe(200);
  });

  it('активация из админки: владелец и тимлид могут, менеджер нет; можно активировать по номеру без нажатия клиента', async () => {
    const bonus = await win(); // клиент кнопку не нажимал, просто назвал номер
    expect((await post(`/api/admin/bonuses/${bonus.id}/activate`, MANAGER)).status).toBe(403);
    expect((await post(`/api/admin/bonuses/${bonus.id}/activate`, CLIENT)).status).toBe(403);
    const done = await post(`/api/admin/bonuses/${bonus.id}/activate`, OWNER);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'REDEEMED', redeemedBy: 'OWNER 1' });
    expect(done.body.history.at(-1)).toMatchObject({
      previousStatus: 'ACTIVE',
      newStatus: 'REDEEMED',
      actor: 'OWNER 1',
    });
    // Повтор — без изменений.
    const repeat = await Promise.all(
      Array.from({ length: 5 }, () => post(`/api/admin/bonuses/${bonus.id}/activate`, LEAD)),
    );
    expect(repeat.every((r) => r.status === 200)).toBe(true);
    expect(await count("bonus_history where new_status = 'REDEEMED'")).toBe(1);
    // По умолчанию вращения начисляются только вручную.
    expect(await count("spin_grants where source = 'BONUS'")).toBe(0);
    // Настройка «автоматически после активации» по-прежнему доступна.
    const settings = (await call(env.app, 'GET', '/api/admin/me', OWNER)).body.settings;
    await call(env.app, 'PUT', '/api/admin/settings', OWNER, {
      ...settings,
      spinGrantTrigger: 'BONUS_ACTIVATED',
    });
    await env.db.insert(spinGrants).values({
      userId: (await env.db.select().from(users).where(eq(users.telegramId, 1001)))[0]!.id,
      source: 'MANUAL',
    });
    const second = await win();
    await post(`/api/admin/bonuses/${second.id}/activate`, OWNER);
    expect(await count("spin_grants where source = 'BONUS' and expires_at is not null")).toBe(1);
  });

  it('«Вернуть клиенту»: бонус снова активен и его можно применить заново', async () => {
    const bonus = await win();
    await post(`/api/bonuses/${bonus.id}/apply`, CLIENT);
    await press(1, `br:${bonus.id}`);
    let [row] = await env.db.select().from(bonuses);
    expect(row).toMatchObject({ status: 'ACTIVE', appliedAt: null });
    expect(String(env.telegram.calls.find((c) => c.method === 'editMessageText')!.body.text)).toContain(
      'Возвращён клиенту',
    );
    expect(await count("spin_grants where source = 'BONUS'")).toBe(0);

    expect((await post(`/api/bonuses/${bonus.id}/apply`, CLIENT)).body.status).toBe('RESERVED');
    expect(await count("notifications where notification_type = 'TEAM_BONUS_APPLIED'")).toBe(4);
    expect((await post(`/api/admin/bonuses/${bonus.id}/return`, MANAGER, {})).status).toBe(403);
    expect(
      (await post(`/api/admin/bonuses/${bonus.id}/return`, LEAD, { reason: 'Клиент передумал' })).body.status,
    ).toBe('ACTIVE');
    [row] = await env.db.select().from(bonuses);
    expect(row!.status).toBe('ACTIVE');
    expect(await count("audit_logs where action = 'bonus.return'")).toBe(2);
  });

  it('истёкший бонус активировать нельзя; мусорные данные кнопки игнорируются', async () => {
    const bonus = await win();
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await post(`/api/admin/bonuses/${bonus.id}/activate`, OWNER)).body.error.code).toBe(
      'BONUS_EXPIRED',
    );
    for (const data of ['ba:', 'ba:not-a-uuid', 'zz:' + bonus.id, "ba:'; drop table bonuses; --"]) {
      expect((await press(1, data)).status).toBe(200);
    }
    expect(await count('bonuses')).toBe(1);
    expect(await count("spin_grants where source = 'BONUS'")).toBe(0);
  });
});

describe('вращения: срок действия и ручное начисление', () => {
  const lookup = (q: string, who = LEAD) =>
    call(env.app, 'GET', `/api/admin/spins/lookup?q=${encodeURIComponent(q)}`, who);
  const grant = (userId: string, who = LEAD) => post('/api/admin/spins/grant', who, { userId });

  it('приветственное вращение действует 7 дней и сгорает, если им не воспользоваться', async () => {
    const home = (await call(env.app, 'GET', '/api/home', CLIENT)).body;
    expect(home.availability).toMatchObject({ canSpin: true, attempts: 1 });
    const days = (new Date(home.availability.attemptsExpireAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(7);

    await env.db.update(spinGrants).set({ expiresAt: new Date(Date.now() - 1000) });
    const late = (await call(env.app, 'GET', '/api/home', CLIENT)).body;
    expect(late.availability).toMatchObject({ canSpin: false, attempts: 0, reason: 'NO_ATTEMPTS' });
    expect(late.availability.message).toContain('менеджер начислит после вашего следующего заказа');
    const res = await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    expect(res.body.error.code).toBe('SPIN_NO_ATTEMPTS');
    expect(await count('bonuses')).toBe(0);
  });

  it('владелец и тимлид находят клиента по @username или ID и начисляют одно вращение', async () => {
    await call(env.app, 'GET', '/api/home', CLIENT);
    await env.db.update(spinGrants).set({ expiresAt: new Date(Date.now() - 1000) }); // приветственное сгорело

    // Поиск: @username в любом регистре, ссылка t.me, Telegram ID.
    for (const q of ['@anya', 'ANYA', 'https://t.me/anya', '1001']) {
      const found = await lookup(q);
      expect(found.status, q).toBe(200);
      expect(found.body).toMatchObject({
        client: { telegramId: 1001, username: 'anya' },
        attempts: 0,
        canGrant: true,
        reason: null,
      });
    }
    expect((await lookup('@nobody')).status).toBe(404);
    expect((await lookup('99999999')).status).toBe(404);
    expect((await lookup("' or 1=1 --")).status).toBe(404);
    // Менеджер, финансы, тех. админ и клиент — без доступа.
    for (const who of [MANAGER, FINANCE, TECH, CLIENT]) {
      expect((await lookup('@anya', who)).status).toBe(403);
      expect((await grant((await lookup('@anya')).body.client.id, who)).status).toBe(403);
    }

    const userId = (await lookup('@anya')).body.client.id;
    const granted = await grant(userId, LEAD);
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({
      attempts: 1,
      canGrant: false,
      reason: 'У клиента уже есть неиспользованное вращение',
    });
    expect(Math.round((new Date(granted.body.attemptsExpireAt).getTime() - Date.now()) / 86_400_000)).toBe(7);
    expect(await count("audit_logs where action = 'spin.grant'")).toBe(1);
    expect(
      await count(
        "notifications where notification_type = 'SPIN_GRANTED' and payload->>'expiresAt' is not null",
      ),
    ).toBe(1);

    // Второе вращение поверх неиспользованного не выдаётся — даже при одновременных нажатиях.
    const again = await Promise.all(Array.from({ length: 6 }, () => grant(userId, OWNER)));
    expect(again.every((r) => r.status === 409)).toBe(true);
    expect(await count('spin_grants where consumed_at is null and expires_at > now()')).toBe(1);
  });

  it('нельзя начислить вращение, пока у клиента действующий бонус; после сгорания бонуса — можно', async () => {
    const res = await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    const userId = (await lookup('1001')).body.client.id;
    const blocked = await lookup('1001');
    expect(blocked.body).toMatchObject({
      canGrant: false,
      openBonus: { code: res.body.bonus.code, status: 'ACTIVE' },
    });
    expect((await grant(userId)).body.error.code).toBe('SPIN_NOT_ALLOWED');

    // Клиент «применил» бонус и пропал: через 14 дней бонус сгорает, а не висит вечно.
    await post(`/api/bonuses/${res.body.bonus.id}/apply`, CLIENT);
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await expireDueBonuses(env.db)).toBe(1);
    const [row] = await env.db.select().from(bonuses);
    expect(row).toMatchObject({ status: 'EXPIRED', appliedAt: null });
    // Сам по себе сгоревший бонус нового вращения не даёт.
    expect((await call(env.app, 'GET', '/api/home', CLIENT)).body.availability).toMatchObject({
      canSpin: false,
      attempts: 0,
    });
    // Клиент сделал заказ без бонуса — сотрудник начисляет вращение, цикл продолжается.
    expect((await grant(userId)).status).toBe(200);
    expect((await post('/api/roulette/spin', CLIENT, { requestId: uuid() })).status).toBe(200);
  });

  it('сообщение о выигрыше не приходит, пока крутится колесо', async () => {
    await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    await processNotifications(env.db, env.config, env.telegram, undefined, 50);
    expect(env.telegram.sent.filter((m) => m.html.includes('Вы выиграли'))).toHaveLength(0);
    await flushNotifications();
    expect(env.telegram.sent.filter((m) => m.html.includes('Вы выиграли'))).toHaveLength(1);
  });

  it('приветственный бонус — на первый заказ, все следующие — на следующий заказ', async () => {
    const first = await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    expect(first.body.bonus.firstOrder).toBe(true);
    await flushNotifications();
    expect(env.telegram.sent.find((m) => m.chatId === '1001')!.html).toContain('на ваш <b>первый заказ</b>');
    // Сотрудники тоже видят, что бонус приветственный.
    await post(`/api/bonuses/${first.body.bonus.id}/apply`, CLIENT);
    await flushNotifications();
    expect(env.telegram.sent.find((m) => m.chatId === '1')!.html).toContain('на первый заказ клиента');
    expect(
      (await call(env.app, 'GET', `/api/admin/bonuses/${first.body.bonus.id}`, OWNER)).body.firstOrder,
    ).toBe(true);

    // Заказ сделан: бонус активирован, сотрудник начислил вращение — следующий бонус уже «на следующий заказ».
    await post(`/api/admin/bonuses/${first.body.bonus.id}/activate`, OWNER);
    await post('/api/admin/spins/grant', LEAD, { userId: (await lookup('1001')).body.client.id });
    env.telegram.sent = [];
    const second = await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    expect(second.body.bonus.firstOrder).toBe(false);
    await flushNotifications();
    expect(env.telegram.sent.find((m) => m.html.includes('Вы выиграли'))!.html).toContain(
      'на ваш <b>следующий заказ</b>',
    );
  });

  it('клиент открыл приложение без чата с ботом: язык не выбран, боту писать нельзя, пока он не разрешит', async () => {
    let me = (await call(env.app, 'GET', '/api/home', CLIENT)).body.me;
    expect(me).toMatchObject({ localeChosen: false, botStarted: false });
    expect((await call(env.app, 'GET', '/api/admin/broadcasts', OWNER)).body.audience.total).toBe(0);
    expect((await post('/api/me/bot-access', {})).status).toBe(401);
    await call(env.app, 'PUT', '/api/me/locale', CLIENT, { locale: 'ru' });
    expect((await post('/api/me/bot-access', CLIENT)).status).toBe(200);
    me = (await call(env.app, 'GET', '/api/home', CLIENT)).body.me;
    expect(me).toMatchObject({ localeChosen: true, botStarted: true });
    expect((await call(env.app, 'GET', '/api/admin/broadcasts', OWNER)).body.audience.total).toBe(1);
  });

  it('просроченный бонус, ожидающий активации, активировать нельзя', async () => {
    const res = await post('/api/roulette/spin', CLIENT, { requestId: uuid() });
    await post(`/api/bonuses/${res.body.bonus.id}/apply`, CLIENT);
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await post(`/api/admin/bonuses/${res.body.bonus.id}/activate`, OWNER)).body.error.code).toBe(
      'BONUS_EXPIRED',
    );
    expect((await env.db.select().from(bonuses))[0]!.status).toBe('EXPIRED');
  });
});

describe('номер бонуса', () => {
  it('у каждого бонуса уникальный номер; клиент видит его, сотрудник находит по нему аккаунт', async () => {
    const { bonusId } = await orderWithBonus();
    const mine = (await call(env.app, 'GET', `/api/bonuses/${bonusId}`, CLIENT)).body;
    expect(mine.code).toMatch(/^YB-[2-9A-HJKMNP-Z]{6}$/);
    expect(
      await count("notifications where notification_type = 'SPIN_WON' and payload->>'bonusCode' is not null"),
    ).toBe(1);

    // Второй клиент получает другой номер.
    await call(env.app, 'POST', '/api/roulette/spin', tma(1002, 'Борис', 'boris'), { requestId: uuid() });
    const codes = (await env.db.select({ code: bonuses.code }).from(bonuses)).map((b) => b.code);
    expect(new Set(codes).size).toBe(2);

    // Сотрудник вводит номер в любом виде и получает ровно этот бонус с аккаунтом владельца и статусом.
    const body = mine.code.slice(3);
    for (const q of [
      mine.code,
      mine.code.toLowerCase(),
      body,
      `yb ${body.toLowerCase()}`,
      ` ${mine.code} `,
    ]) {
      const found = await call(env.app, 'GET', `/api/admin/bonuses?q=${encodeURIComponent(q)}`, LEAD);
      expect(found.body.total, q).toBe(1);
      expect(found.body.items[0]).toMatchObject({ id: bonusId, code: mine.code, status: 'RESERVED' });
      expect(found.body.items[0].client).toMatchObject({ telegramId: 1001, username: 'anya' });
    }
    expect((await call(env.app, 'GET', '/api/admin/bonuses?q=YB-ZZZZZZ', LEAD)).body.total).toBe(0);
    expect((await call(env.app, 'GET', '/api/admin/bonuses?q=yb', LEAD)).status).toBe(200);
    // Поиск по номеру — только для сотрудников с доступом к бонусам.
    expect((await call(env.app, 'GET', `/api/admin/bonuses?q=${mine.code}`, TECH)).status).toBe(403);
    expect((await call(env.app, 'GET', `/api/admin/bonuses?q=${mine.code}`, CLIENT)).status).toBe(403);
  });
});

describe('бот: /start и выбор языка', () => {
  const hook = (body: unknown) =>
    post(
      '/api/telegram/webhook',
      { 'x-telegram-bot-api-secret-token': env.config.TELEGRAM_WEBHOOK_SECRET! },
      body,
    );
  const from = { id: 1001, first_name: 'Аня', username: 'anya', language_code: 'ru' };
  const start = (text = '/start') =>
    hook({ update_id: 1, message: { chat: { id: 1001, type: 'private' }, text, from } });
  const pick = (locale: string) =>
    hook({
      update_id: 2,
      callback_query: {
        id: 'cb',
        from,
        data: `lang:${locale}`,
        message: { message_id: 7, chat: { id: 1001 } },
      },
    });

  it('webhook отклоняет запрос без секрета', async () => {
    const update = { update_id: 1, message: { chat: { id: 1001, type: 'private' }, text: '/start', from } };
    expect((await post('/api/telegram/webhook', {}, update)).status).toBe(401);
    expect(
      (await post('/api/telegram/webhook', { 'x-telegram-bot-api-secret-token': 'wrong' }, update)).status,
    ).toBe(401);
    expect(await count('users')).toBe(0);
  });

  it('первый /start просит выбрать язык; после выбора бот отвечает на этом языке', async () => {
    expect((await start()).status).toBe(200);
    expect(env.telegram.sent).toHaveLength(1);
    expect(env.telegram.sent[0]!.html).toContain('Choose your language');
    expect(env.telegram.sent[0]!.buttons![0]!.map((b) => b.callback_data)).toEqual([
      'lang:ru',
      'lang:en',
      'lang:uk',
    ]);
    let [user] = await env.db.select().from(users);
    expect(user).toMatchObject({ telegramId: 1001, locale: null });
    expect(user!.botStartedAt).not.toBeNull();

    await pick('en');
    [user] = await env.db.select().from(users);
    expect(user!.locale).toBe('en');
    const edit = env.telegram.calls.find((c) => c.method === 'editMessageText')!;
    expect(String(edit.body.text)).toContain('Hi, Аня! This is the');
    expect(JSON.stringify(edit.body.reply_markup)).toContain('Open app');
    // Кнопка меню и команды чата — на выбранном языке.
    const menu = env.telegram.calls.find((c) => c.method === 'setChatMenuButton')!;
    expect(menu.body).toMatchObject({ chat_id: 1001, menu_button: { text: 'Open' } });
    expect(env.telegram.calls.find((c) => c.method === 'setMyCommands')!.body).toMatchObject({
      scope: { type: 'chat', chat_id: 1001 },
    });

    // Повторный /start — сразу приветствие на выбранном языке, без вопроса.
    env.telegram.sent = [];
    await start();
    expect(env.telegram.sent[0]!.html).toContain('bonus program');
    // /lang снова предлагает выбор; повторная доставка не плодит пользователей.
    await start('/lang');
    expect(env.telegram.sent[1]!.html).toContain('Оберіть мову');
    await pick('zz');
    expect((await env.db.select().from(users))[0]!.locale).toBe('en');
    expect(await count('users')).toBe(1);
    expect(await count('spin_grants')).toBe(1);
  });

  it('уведомления и данные приложения — на языке клиента, включая перевод приза', async () => {
    await env.db.update(prizes).set({
      translations: {
        en: { name: '15% discount', description: '15% off your next order', terms: 'One order only.' },
        uk: { name: 'Знижка 15%', description: '', terms: '' },
      },
    });
    const [target] = await env.db.select().from(prizes).where(eq(prizes.name, 'Скидка 15%'));
    await start();
    await pick('en');
    const [user] = await env.db.select().from(users);
    const won = await spin(env.ctx, user!, uuid(), () => 6000);
    expect(won.prizeId).toBe(target!.id);
    await flushNotifications();
    const message = env.telegram.sent.find((m) => m.html.includes('You won'))!;
    expect(message.html).toContain('You won: 15% discount');
    // Вращение приветственное, поэтому бонус — на первый заказ.
    expect(message.html).toContain('applies to your <b>first order</b>');
    expect(message.html).toMatch(/Bonus number: <code>YB-/);
    expect(message.html).toContain('Valid until');

    const home = (await call(env.app, 'GET', '/api/home', CLIENT)).body;
    expect(home.me.locale).toBe('en');
    expect(home.activeBonus).toMatchObject({ name: '15% discount', description: '15% off your next order' });
    expect(home.activeBonus.rules.terms).toBe('One order only.');
    const wheel = (await call(env.app, 'GET', '/api/roulette', CLIENT)).body;
    expect(wheel.segments.map((s: { name: string }) => s.name)).toContain('15% discount');

    // Смена языка из приложения: без перевода поля берётся русский текст.
    expect((await call(env.app, 'PUT', '/api/me/locale', CLIENT, { locale: 'uk' })).body).toEqual({
      locale: 'uk',
    });
    const uk = (await call(env.app, 'GET', '/api/home', CLIENT)).body;
    expect(uk.me.locale).toBe('uk');
    expect(uk.activeBonus).toMatchObject({ name: 'Знижка 15%', description: '' });
    expect(env.telegram.calls.filter((c) => c.method === 'setChatMenuButton').at(-1)!.body).toMatchObject({
      menu_button: { text: 'Відкрити' },
    });
    expect((await call(env.app, 'PUT', '/api/me/locale', CLIENT, { locale: 'de' })).status).toBe(400);
    expect((await call(env.app, 'PUT', '/api/me/locale', {}, { locale: 'en' })).status).toBe(401);
    // Сотрудники видят русское название, уведомление команде — тоже на русском.
    expect((await call(env.app, 'GET', '/api/admin/bonuses', OWNER)).body.items[0].name).toBe('Скидка 15%');
  });

  it('язык по умолчанию берётся из настроек Telegram, пока клиент не выбрал сам', async () => {
    const res = await call(env.app, 'GET', '/api/home', { authorization: tma(1001).authorization });
    expect(res.body.me.locale).toBe('ru');
    await env.db.update(users).set({ languageCode: 'uk' });
    expect((await call(env.app, 'GET', '/api/home', CLIENT)).body.me.locale).toBe('uk');
    await env.db.update(users).set({ languageCode: 'de' });
    expect((await call(env.app, 'GET', '/api/home', CLIENT)).body.me.locale).toBe('en');
  });
});

describe('рассылка', () => {
  const text =
    'Привет!\n\n<b>Скидки</b> до <i>пятницы</i> — <a href="https://yappi-agency.com">подробнее</a>';
  const input = (extra: Record<string, unknown> = {}) => ({
    text,
    mediaKind: null,
    mediaFileId: null,
    buttons: [],
    locale: null,
    ...extra,
  });

  /** Три подписчика (ru, en, без языка), один не нажимал /start, один заблокировал бота. */
  async function audience() {
    const now = new Date();
    await env.db.insert(users).values([
      { telegramId: 2001, displayName: 'Ru', locale: 'ru', botStartedAt: now },
      { telegramId: 2002, displayName: 'En', locale: 'en', botStartedAt: now },
      { telegramId: 2003, displayName: 'NoLang', botStartedAt: now },
      { telegramId: 2004, displayName: 'NeverStarted' },
      { telegramId: 2005, displayName: 'Blocked', locale: 'ru', botStartedAt: now, botBlockedAt: now },
    ]);
  }
  const drain = async () => {
    for (let i = 0; i < 10; i++)
      await (await import('../src/services/broadcasts.ts')).processBroadcasts(env.ctx, env.telegram);
  };

  it('доступна только с правом; аудитория — нажавшие /start и не заблокировавшие бота', async () => {
    await audience();
    for (const who of [LEAD, MANAGER, FINANCE, TECH, CLIENT]) {
      expect((await call(env.app, 'GET', '/api/admin/broadcasts', who)).status).toBe(403);
      expect((await post('/api/admin/broadcasts', who, input())).status).toBe(403);
    }
    const res = await call(env.app, 'GET', '/api/admin/broadcasts', OWNER);
    expect(res.body.audience).toEqual({ total: 3, byLocale: { ru: 1, en: 1, uk: 0, none: 1 } });
    expect(res.body.items).toEqual([]);
  });

  it('проверяет разметку до отправки', async () => {
    await audience();
    const bad = async (t: string) =>
      (await post('/api/admin/broadcasts', OWNER, input({ text: t }))).body.error?.code;
    expect(await bad('<script>alert(1)</script>')).toBe('MARKUP');
    expect(await bad('<b>не закрыт')).toBe('MARKUP');
    expect(await bad('<b><i>криво</b></i>')).toBe('MARKUP');
    expect(await bad('цена < 100')).toBe('MARKUP');
    expect(await bad('<a href="javascript:alert(1)">x</a>')).toBe('MARKUP');
    expect(await bad('<b onclick="x">x</b>')).toBe('MARKUP');
    expect(await bad('   ')).toBe('EMPTY');
    expect(await bad('я'.repeat(4097))).toBe('TOO_LONG');
    expect(
      (
        await post(
          '/api/admin/broadcasts',
          OWNER,
          input({ buttons: [{ text: 'x', url: 'http://insecure' }] }),
        )
      ).status,
    ).toBe(400);
    expect(await count('broadcasts')).toBe(0);
    expect(env.telegram.sent).toHaveLength(0);
  });

  it('отправляет всем подписчикам с форматированием, переносами и кнопками; каждому — один раз', async () => {
    await audience();
    const buttons = [
      { text: 'Сайт', url: 'https://yappi-agency.com' },
      { text: 'Открыть приложение', url: null },
    ];
    const created = await post('/api/admin/broadcasts', OWNER, input({ buttons }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'SENDING', total: 3, sent: 0 });
    // Пока идёт рассылка, вторую запустить нельзя.
    expect((await post('/api/admin/broadcasts', OWNER, input())).body.error.code).toBe('BROADCAST_RUNNING');

    await drain();
    const delivered = env.telegram.sent.filter((m) => m.html === text);
    expect(delivered.map((m) => m.chatId).sort()).toEqual(['2001', '2002', '2003']);
    expect(delivered[0]!.html).toContain('\n\n<b>Скидки</b>');
    expect(delivered[0]!.buttons).toEqual([
      [{ text: 'Сайт', url: 'https://yappi-agency.com' }],
      [{ text: 'Открыть приложение', web_app: { url: 'https://app.example.test' } }],
    ]);
    const [done] = (await call(env.app, 'GET', '/api/admin/broadcasts', OWNER)).body.items;
    expect(done).toMatchObject({ status: 'DONE', total: 3, sent: 3, failed: 0, createdBy: 'OWNER 1' });
    await drain();
    expect(env.telegram.sent.filter((m) => m.html === text)).toHaveLength(3);
    expect(await count("audit_logs where action = 'broadcast.create'")).toBe(1);
  });

  it('клиент заблокировал бота: остальные получают, он помечается и в следующую рассылку не попадает', async () => {
    await audience();
    env.telegram.failFor.set('2002', new TelegramError(403, 'Forbidden: bot was blocked by the user'));
    await post('/api/admin/broadcasts', OWNER, input());
    await drain();
    const [first] = (await call(env.app, 'GET', '/api/admin/broadcasts', OWNER)).body.items;
    expect(first).toMatchObject({ status: 'DONE', sent: 2, failed: 1 });
    const [blocked] = await env.db.select().from(users).where(eq(users.telegramId, 2002));
    expect(blocked!.botBlockedAt).not.toBeNull();
    expect((await call(env.app, 'GET', '/api/admin/broadcasts', OWNER)).body.audience.total).toBe(2);
    // Снова нажал /start — снова подписчик.
    await post(
      '/api/telegram/webhook',
      { 'x-telegram-bot-api-secret-token': env.config.TELEGRAM_WEBHOOK_SECRET! },
      {
        update_id: 5,
        message: {
          chat: { id: 2002, type: 'private' },
          text: '/start',
          from: { id: 2002, first_name: 'En' },
        },
      },
    );
    expect((await call(env.app, 'GET', '/api/admin/broadcasts', OWNER)).body.audience.total).toBe(3);
  });

  it('фильтр по языку, отмена и пустая аудитория', async () => {
    await audience();
    const en = await post('/api/admin/broadcasts', OWNER, input({ text: 'Hello!', locale: 'en' }));
    expect(en.body.total).toBe(1);
    const cancelled = await post(`/api/admin/broadcasts/${en.body.id}/cancel`, OWNER);
    expect(cancelled.body.status).toBe('CANCELLED');
    await drain();
    expect(env.telegram.sent.filter((m) => m.html === 'Hello!')).toHaveLength(0);
    expect((await post('/api/admin/broadcasts', OWNER, input({ locale: 'uk' }))).body.error.code).toBe(
      'NO_RECIPIENTS',
    );
    expect(await count("broadcasts where status = 'SENDING'")).toBe(0);
  });

  it('фото и голосовое: файл загружается один раз, рассылается по идентификатору с подписью', async () => {
    await audience();
    const upload = (kind: string, bytes = 2048) =>
      env.app.inject({
        method: 'POST',
        url: `/api/admin/broadcasts/media?kind=${kind}&name=pic.jpg`,
        headers: { ...OWNER, 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(bytes, 1),
      });
    expect((await upload('exe')).statusCode).toBe(400);
    expect((await upload('photo', 0)).statusCode).toBe(400);
    const lead = await env.app.inject({
      method: 'POST',
      url: '/api/admin/broadcasts/media?kind=photo',
      headers: { ...LEAD, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(10),
    });
    expect(lead.statusCode).toBe(403);

    const photo = (await upload('photo')).json();
    expect(photo).toEqual({ mediaKind: 'photo', mediaFileId: 'big-photo-file-id-0001' });
    // Файл уходит в личный чат сотрудника, а не клиентам.
    expect(env.telegram.uploads[0]).toMatchObject({
      method: 'sendPhoto',
      fields: { chat_id: '1' },
      fileBytes: 2048,
    });

    // Пробная отправка — только себе.
    expect(
      (await post('/api/admin/broadcasts/test', OWNER, input({ ...photo, text: 'Подпись <b>жирным</b>' })))
        .status,
    ).toBe(200);
    expect(env.telegram.calls.filter((c) => c.method === 'sendPhoto').map((c) => c.body.chat_id)).toEqual([
      1,
    ]);

    expect(
      (await post('/api/admin/broadcasts', OWNER, input({ ...photo, text: 'я'.repeat(1025) }))).body.error
        .code,
    ).toBe('TOO_LONG');
    expect(
      (await post('/api/admin/broadcasts', OWNER, input({ mediaKind: 'photo', mediaFileId: null }))).status,
    ).toBe(400);
    env.telegram.calls = [];
    await post(
      '/api/admin/broadcasts',
      OWNER,
      input({
        ...photo,
        text: 'Подпись <b>жирным</b>',
        buttons: [{ text: 'Сайт', url: 'https://yappi-agency.com' }],
      }),
    );
    await drain();
    const photos = env.telegram.calls.filter((c) => c.method === 'sendPhoto');
    expect(photos.map((c) => c.body.chat_id).sort()).toEqual([2001, 2002, 2003]);
    expect(photos[0]!.body).toMatchObject({
      photo: 'big-photo-file-id-0001',
      caption: 'Подпись <b>жирным</b>',
      parse_mode: 'HTML',
    });
    expect(JSON.stringify(photos[0]!.body.reply_markup)).toContain('yappi-agency.com');

    const voice = (await upload('voice')).json();
    expect(voice.mediaKind).toBe('voice');
    env.telegram.calls = [];
    await post('/api/admin/broadcasts', OWNER, input({ ...voice, text: '' }));
    await drain();
    expect(env.telegram.calls.filter((c) => c.method === 'sendVoice')).toHaveLength(3);
  });
});

describe('отчёты', () => {
  it('дашборд, статистика, карточки и CSV считаются по фактическим данным', async () => {
    const { orderId, bonusId, userId } = await orderWithBonus();
    await toAwaitingPayment(orderId);
    await post(`/api/admin/orders/${orderId}/confirm-payment`, FINANCE, { amount: '8500' });
    await post(`/api/admin/orders/${orderId}/redeem-bonus`, LEAD);
    await post('/api/orders', CLIENT, orderInput());

    const dash = (await call(env.app, 'GET', '/api/admin/dashboard', OWNER)).body;
    expect(dash).toMatchObject({
      clientsTotal: 1,
      clientsNew: 1,
      ordersTotal: 2,
      ordersNew: 1,
      repeatOrders: 1,
      bonusesRedeemed: 1,
      bonusesActive: 0,
    });
    expect(dash.finance).toMatchObject({ discounts: '1500.00', subtotal: '10000.00', total: '8500.00' });

    const stats = (await call(env.app, 'GET', '/api/admin/stats', OWNER)).body;
    expect(stats).toMatchObject({
      spins: 1,
      bonusesIssued: 1,
      bonusesRedeemed: 1,
      winToOrderConversion: 1,
      repeatClientsShare: 1,
    });
    expect(stats.distribution).toEqual([{ name: 'Скидка 15%', count: 1 }]);
    expect(stats.finance).toMatchObject({
      discounts: '1500.00',
      revenueWithBonus: '8500.00',
      avgCheckWithBonus: '8500.00',
      avgCheckWithoutBonus: null,
    });
    expect((await call(env.app, 'GET', '/api/admin/stats', LEAD)).body.finance).toBeNull();
    // Пустой период — нули, а не выдуманные значения.
    const empty = (await call(env.app, 'GET', '/api/admin/stats?from=2020-01-01&to=2020-01-31', OWNER)).body;
    expect(empty).toMatchObject({
      spins: 0,
      bonusesIssued: 0,
      winToOrderConversion: null,
      avgHoursToRedeem: null,
    });

    const card = (await call(env.app, 'GET', `/api/admin/clients/${userId}`, OWNER)).body;
    expect(card.orders).toHaveLength(2);
    expect(card.bonuses).toHaveLength(1);
    expect(card.payments).toHaveLength(1);
    expect(card.audit.length).toBeGreaterThanOrEqual(4);
    const bonusCard = (await call(env.app, 'GET', `/api/admin/bonuses/${bonusId}`, OWNER)).body;
    expect(bonusCard.history.map((h: { newStatus: string }) => h.newStatus)).toEqual([
      'ACTIVE',
      'RESERVED',
      'REDEEMED',
    ]);

    expect((await call(env.app, 'GET', '/api/admin/clients?q=anya', OWNER)).body.total).toBe(1);
    expect(
      (await call(env.app, 'GET', '/api/admin/clients?q=1001&sort=ordersCount&dir=asc', OWNER)).body.total,
    ).toBe(1);
    expect((await call(env.app, 'GET', '/api/admin/clients?q=nobody', OWNER)).body.total).toBe(0);
    expect((await call(env.app, 'GET', "/api/admin/clients?q=' OR 1=1 --", OWNER)).body.total).toBe(0);
    expect((await call(env.app, 'GET', '/api/admin/clients?sort=id;drop table users', OWNER)).status).toBe(
      400,
    );
    expect((await call(env.app, 'GET', '/api/admin/orders?hasBonus=yes&status=PAID', OWNER)).body.total).toBe(
      1,
    );
    expect((await call(env.app, 'GET', '/api/admin/orders?hasBonus=no', OWNER)).body.total).toBe(1);
    expect(
      (await call(env.app, 'GET', '/api/admin/bonuses?status=REDEEMED&type=PERCENT_DISCOUNT', OWNER)).body
        .total,
    ).toBe(1);

    const csv = await call(env.app, 'GET', '/api/admin/export/orders.csv', FINANCE);
    expect(csv.status).toBe(200);
    expect(String(csv.body).split('\r\n').filter(Boolean)).toHaveLength(3);
    expect(String(csv.body)).toContain('8500.00');
    for (const t of ['clients', 'bonuses', 'spins'])
      expect((await call(env.app, 'GET', `/api/admin/export/${t}.csv`, OWNER)).status, t).toBe(200);
    expect((await call(env.app, 'GET', '/api/admin/export/orders.csv', MANAGER)).status).toBe(403);
    expect(await count('payments')).toBe((await env.db.select().from(payments)).length);
  });
});
