import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bonuses, orders, prizes, spinGrants, spins, users } from '../src/db/schema.ts';
import { spin } from '../src/services/roulette.ts';
import { signInitData } from '../src/telegram/auth.ts';
import { BOT_TOKEN, call, createTestEnv, orderInput, resetDb, seedPrizes, tma, uuid } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetDb(env.db);
  await seedPrizes(env.db);
  env.telegram.sent = [];
  env.telegram.failWith = null;
});

const A = tma(1001, 'Аня', 'anya');
const B = tma(1002, 'Борис');
const count = async (table: string) =>
  Number((await env.db.execute(sql.raw(`select count(*) from ${table}`))).rows[0]!.count);

describe('вход и профиль', () => {
  it('первый вход создаёт профиль, повторный — открывает тот же', async () => {
    const first = await call(env.app, 'GET', '/api/home', A);
    expect(first.status).toBe(200);
    expect(first.body.me).toMatchObject({
      telegramId: 1001,
      username: 'anya',
      displayName: 'Аня',
      ordersCount: 0,
    });
    expect(first.body.availability).toMatchObject({ canSpin: true, attempts: 1 });

    const second = await call(env.app, 'GET', '/api/home', tma(1001, 'Аня Новая', 'anya_new'));
    expect(second.body.me.id).toBe(first.body.me.id);
    // Username изменился — профиль тот же, ключ — Telegram ID.
    expect(second.body.me.username).toBe('anya_new');
    expect(await count('users')).toBe(1);
    expect(await count('spin_grants')).toBe(1);
    const activity = await call(env.app, 'GET', '/api/activity', A);
    expect(activity.body.items).toHaveLength(1);
  });

  it('параллельный первый вход не создаёт дубликаты', async () => {
    await Promise.all(Array.from({ length: 8 }, () => call(env.app, 'GET', '/api/home', A)));
    expect(await count('users')).toBe(1);
    expect(await count('spin_grants')).toBe(1);
  });

  it('без подписи, с подделанной или устаревшей подписью — 401', async () => {
    expect((await call(env.app, 'GET', '/api/home')).status).toBe(401);
    const forged = new URLSearchParams(signInitData({ id: 1001, first_name: 'Аня' }, BOT_TOKEN));
    forged.set('user', JSON.stringify({ id: 1002, first_name: 'Аня' }));
    expect((await call(env.app, 'GET', '/api/home', { authorization: `tma ${forged}` })).status).toBe(401);
    const stale = signInitData({ id: 1001 }, BOT_TOKEN, new Date(Date.now() - 3 * 86_400_000));
    expect((await call(env.app, 'GET', '/api/home', { authorization: `tma ${stale}` })).status).toBe(401);
    // Telegram ID, переданный клиентом «от себя», игнорируется.
    expect(
      (await call(env.app, 'GET', '/api/home?telegramId=1001', { 'x-telegram-id': '1001' })).status,
    ).toBe(401);
    expect(await count('users')).toBe(0);
  });

  it('заблокированный клиент не может крутить рулетку и оформлять заявки', async () => {
    await call(env.app, 'GET', '/api/home', A);
    await env.db.update(users).set({ accountStatus: 'BLOCKED' });
    expect((await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() })).status).toBe(403);
    expect((await call(env.app, 'POST', '/api/orders', A, orderInput())).status).toBe(403);
  });
});

describe('рулетка', () => {
  it('выигрыш сохраняется, виден клиенту и приходит уведомление в очередь', async () => {
    const state = await call(env.app, 'GET', '/api/roulette', A);
    expect(state.body.segments).toHaveLength(5);
    // Вероятности клиенту не раскрываются.
    expect(JSON.stringify(state.body)).not.toContain('probability');

    const res = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    expect(res.status).toBe(200);
    expect(res.body.bonus.status).toBe('ACTIVE');
    expect(res.body.bonus.expiresAt).not.toBeNull();
    expect(state.body.segments.map((s: { prizeId: string }) => s.prizeId)).toContain(res.body.prizeId);

    const list = await call(env.app, 'GET', '/api/bonuses', A);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(res.body.bonus.id);
    const home = await call(env.app, 'GET', '/api/home', A);
    expect(home.body.activeBonus.id).toBe(res.body.bonus.id);
    expect(home.body.availability).toMatchObject({ canSpin: false, reason: 'ACTIVE_BONUS' });
    expect(await count("notifications where notification_type = 'SPIN_WON'")).toBe(1);
    // Сообщение о выигрыше отложено: оно не должно прийти, пока колесо ещё крутится.
    expect(
      await count(
        "notifications where notification_type = 'SPIN_WON' and next_attempt_at > now() + interval '8 seconds'",
      ),
    ).toBe(1);
    expect(await count('bonus_history')).toBe(1);
  });

  it('повторный запрос с тем же requestId возвращает тот же выигрыш', async () => {
    const requestId = uuid();
    const first = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId });
    const again = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ spinId: first.body.spinId, replayed: true });
    expect(again.body.bonus.id).toBe(first.body.bonus.id);
    expect(await count('spins')).toBe(1);
    expect(await count('bonuses')).toBe(1);
  });

  it('новое вращение при активном бонусе запрещено', async () => {
    await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    // Даже если попытки есть — активный бонус блокирует вращение.
    const [user] = await env.db.select().from(users);
    await env.db.insert(spinGrants).values({ userId: user!.id, source: 'MANUAL' });
    const res = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SPIN_ACTIVE_BONUS');
    expect(await count('bonuses')).toBe(1);
  });

  it('20 одновременных вращений выдают ровно один приз', async () => {
    await call(env.app, 'GET', '/api/home', A);
    const [user] = await env.db.select().from(users);
    await env.db
      .insert(spinGrants)
      .values(Array.from({ length: 5 }, () => ({ userId: user!.id, source: 'MANUAL' as const })));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await count('bonuses')).toBe(1);
    expect(await count('spins')).toBe(1);
    expect(await count('spin_grants where consumed_at is not null')).toBe(1);
  });

  it('одновременная повторная доставка одного запроса не создаёт второй выигрыш', async () => {
    await call(env.app, 'GET', '/api/home', A);
    const requestId = uuid();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(env.app, 'POST', '/api/roulette/spin', A, { requestId })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.bonus.id)).size).toBe(1);
    expect(await count('bonuses')).toBe(1);
  });

  it('без попыток вращение недоступно, с понятным объяснением', async () => {
    await call(env.app, 'GET', '/api/home', A);
    await env.db.update(spinGrants).set({ consumedAt: new Date() });
    const state = await call(env.app, 'GET', '/api/roulette', A);
    expect(state.body.availability).toMatchObject({ canSpin: false, reason: 'NO_ATTEMPTS' });
    expect(state.body.availability.message).toMatch(/заказ/);
    const res = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    expect(res.body.error.code).toBe('SPIN_NO_ATTEMPTS');
  });

  it('клиент не может выбрать приз: лишние поля запроса игнорируются, результат задаёт сервер', async () => {
    await call(env.app, 'GET', '/api/home', A);
    const [user] = await env.db.select().from(users);
    const all = await env.db.select().from(prizes).orderBy(prizes.sortOrder);
    // roll = 9999 → последний приз (5%). Клиентский prizeId не влияет.
    const outcome = await spin(env.ctx, user!, uuid(), () => 9999);
    expect(outcome.prizeId).toBe(all[4]!.id);
    await env.db.update(bonuses).set({ status: 'CANCELLED' });
    await env.db.insert(spinGrants).values({ userId: user!.id, source: 'MANUAL' });
    const res = await call(env.app, 'POST', '/api/roulette/spin', A, {
      requestId: uuid(),
      prizeId: all[4]!.id,
      prize: 'Скидка 25%',
    });
    expect(res.status).toBe(200);
    const [row] = await env.db.select().from(spins).where(eq(spins.id, res.body.spinId));
    expect(row!.prizeId).toBe(res.body.prizeId);
  });

  it('просроченный активный бонус не блокирует рулетку и становится EXPIRED', async () => {
    const first = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    const [user] = await env.db.select().from(users);
    await env.db.insert(spinGrants).values({ userId: user!.id, source: 'MANUAL' });
    const second = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    expect(second.status).toBe(200);
    const [old] = await env.db.select().from(bonuses).where(eq(bonuses.id, first.body.bonus.id));
    expect(old!.status).toBe('EXPIRED');
  });
});

describe('заявки и резерв бонуса', () => {
  it('заявка создаётся на сервере с уникальным номером и уведомляет команду', async () => {
    const res = await call(env.app, 'POST', '/api/orders', A, orderInput({ contact: '@anya' }));
    expect(res.status).toBe(201);
    expect(res.body.orderNumber).toMatch(/^ORD-\d{5,}$/);
    expect(res.body).toMatchObject({ status: 'NEW', paymentStatus: 'UNPAID', bonus: null, subtotal: null });
    const second = await call(env.app, 'POST', '/api/orders', A, orderInput());
    expect(second.body.orderNumber).not.toBe(res.body.orderNumber);
    const list = await call(env.app, 'GET', '/api/orders', A);
    expect(list.body.items).toHaveLength(2);
    expect(await count("notifications where notification_type = 'ORDER_CREATED'")).toBe(2);
  });

  it('проверяет обязательные поля и список услуг', async () => {
    expect((await call(env.app, 'POST', '/api/orders', A, orderInput({ description: '' }))).status).toBe(400);
    expect(
      (await call(env.app, 'POST', '/api/orders', A, orderInput({ serviceType: 'Нет такой' }))).status,
    ).toBe(400);
    expect(
      (await call(env.app, 'POST', '/api/orders', A, orderInput({ referenceUrl: 'javascript:alert(1)' })))
        .status,
    ).toBe(400);
    expect((await call(env.app, 'POST', '/api/orders', A, { ...orderInput(), requestId: 'x' })).status).toBe(
      400,
    );
    expect(await count('orders')).toBe(0);
  });

  it('повторная отправка формы с тем же requestId не создаёт вторую заявку', async () => {
    const input = orderInput();
    const first = await call(env.app, 'POST', '/api/orders', A, input);
    const again = await call(env.app, 'POST', '/api/orders', A, input);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const parallel = orderInput();
    await Promise.all(Array.from({ length: 6 }, () => call(env.app, 'POST', '/api/orders', A, parallel)));
    expect(await count('orders')).toBe(2);
    expect(await count("notifications where notification_type = 'ORDER_CREATED'")).toBe(2);
  });

  it('бонус резервируется за заявкой и не списывается при её создании', async () => {
    const won = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    const order = await call(env.app, 'POST', '/api/orders', A, orderInput({ useBonus: true }));
    expect(order.status).toBe(201);
    expect(order.body.bonus).toMatchObject({ id: won.body.bonus.id, status: 'RESERVED' });
    const bonus = await call(env.app, 'GET', `/api/bonuses/${won.body.bonus.id}`, A);
    expect(bonus.body.status).toBe('RESERVED');
    expect(bonus.body.reservedOrder.orderNumber).toBe(order.body.orderNumber);
    expect(bonus.body.redeemedAt).toBeNull();
  });

  it('зарезервированный бонус нельзя использовать во второй заявке', async () => {
    await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    await call(env.app, 'POST', '/api/orders', A, orderInput({ useBonus: true }));
    const second = await call(env.app, 'POST', '/api/orders', A, orderInput({ useBonus: true }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BONUS_RESERVED');
    // Заявка без бонуса не создалась «наполовину».
    expect(await count('orders')).toBe(1);
  });

  it('10 одновременных заявок с одним бонусом: резерв получает ровно одна', async () => {
    await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        call(env.app, 'POST', '/api/orders', A, orderInput({ useBonus: true })),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await count('orders')).toBe(1);
    expect(await count("bonuses where status = 'RESERVED'")).toBe(1);
  });

  it('без активного бонуса заявка с useBonus отклоняется; истёкший бонус применить нельзя', async () => {
    const none = await call(env.app, 'POST', '/api/orders', A, orderInput({ useBonus: true }));
    expect(none.body.error.code).toBe('NO_ACTIVE_BONUS');
    await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    await env.db.update(bonuses).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await call(env.app, 'POST', '/api/orders', A, orderInput({ useBonus: true }));
    expect(expired.status).toBe(409);
    expect(await count('orders')).toBe(0);
  });
});

describe('изоляция данных клиентов', () => {
  it('чужие заказы и бонусы недоступны по подмене ID', async () => {
    const won = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    const order = await call(env.app, 'POST', '/api/orders', A, orderInput());

    expect((await call(env.app, 'GET', `/api/orders/${order.body.id}`, B)).status).toBe(404);
    expect((await call(env.app, 'GET', `/api/bonuses/${won.body.bonus.id}`, B)).status).toBe(404);
    expect((await call(env.app, 'GET', '/api/orders', B)).body.items).toHaveLength(0);
    expect((await call(env.app, 'GET', '/api/bonuses', B)).body.items).toHaveLength(0);
    expect((await call(env.app, 'GET', '/api/orders/not-a-uuid', B)).status).toBe(404);
    // Владелец свои данные видит.
    expect((await call(env.app, 'GET', `/api/orders/${order.body.id}`, A)).status).toBe(200);
  });

  it('клиент B не может использовать бонус клиента A', async () => {
    const won = await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() });
    // B пытается подсунуть чужой bonusId и userId — сервер берёт клиента только из подписи.
    const res = await call(
      env.app,
      'POST',
      '/api/orders',
      B,
      orderInput({ useBonus: true, bonusId: won.body.bonus.id, userId: 'x' }),
    );
    expect(res.status).toBe(409);
    const [bonus] = await env.db.select().from(bonuses);
    expect(bonus!.status).toBe('ACTIVE');
  });

  it('клиент не может менять статус заказа, оплату и бонус через админ-API', async () => {
    const order = await call(env.app, 'POST', '/api/orders', A, orderInput());
    for (const path of ['status', 'confirm-payment', 'redeem-bonus', 'cancel', 'price']) {
      const res = await call(env.app, 'POST', `/api/admin/orders/${order.body.id}/${path}`, A, {
        status: 'PAID',
        amount: '1',
        subtotal: '1',
        reason: 'xxx',
      });
      expect(res.status).toBe(403);
    }
    expect((await call(env.app, 'GET', '/api/admin/clients', A)).status).toBe(403);
    expect((await call(env.app, 'GET', '/api/admin/me', A)).status).toBe(403);
    expect((await call(env.app, 'GET', '/api/admin/me')).status).toBe(401);
    const [row] = await env.db.select().from(orders);
    expect(row).toMatchObject({ status: 'NEW', paymentStatus: 'UNPAID' });
  });
});
