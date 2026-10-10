import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { manualTransitions, ORDER_STATUSES } from '../contract/constants.ts';
import type { OrderStatus } from '../contract/constants.ts';
import type { Config } from '../config.ts';
import type { Tx } from '../db/client.ts';
import { bonuses, orders, orderStatusHistory, payments, staff } from '../db/schema.ts';
import type { Bonus, Order, User } from '../db/schema.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { computeDiscount, fromMinor, isMoney, toMinor } from '../lib/money.ts';
import { redeemReservedBonus, releaseReservedBonus, reserveBonus } from './bonuses.ts';
import { audit, can, lockOrder, lockUser, logActivity, requirePermission, staffIdOf } from './common.ts';
import type { Actor, Ctx } from './common.ts';
import { notifyTeam, notifyUser } from './notifications.ts';
import { getSettings } from './settings.ts';
import { createSpinGrant } from './spins.ts';

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const createOrderSchema = z.object({
  requestId: z.uuid(),
  serviceType: z.string().trim().min(1, 'выберите услугу').max(60),
  description: z.string().trim().min(5, 'опишите задачу подробнее (от 5 символов)').max(4000),
  wishes: text(2000),
  referenceUrl: text(500).refine(
    (v) => v === null || /^https?:\/\/\S+$/i.test(v),
    'ссылка должна начинаться с http:// или https://',
  ),
  desiredDeadline: text(100),
  contact: text(200),
  useBonus: z.boolean(),
});

const reasonSchema = z.string().trim().min(3, 'укажите причину (от 3 символов)').max(500);

async function addStatusHistory(
  tx: Tx,
  order: Order,
  newStatus: OrderStatus,
  actor: Actor,
  reason: string | null,
): Promise<string> {
  const [row] = await tx
    .insert(orderStatusHistory)
    .values({
      orderId: order.id,
      previousStatus: order.status,
      newStatus,
      actorType: actor.type,
      changedBy: staffIdOf(actor),
      reason,
    })
    .returning({ id: orderStatusHistory.id });
  return row!.id;
}

/** Бонус, привязанный к заказу (в резерве или уже списанный на нём). */
export async function bonusOfOrder(tx: Tx, orderId: string, lock = false): Promise<Bonus | null> {
  const query = tx.select().from(bonuses).where(eq(bonuses.reservedOrderId, orderId));
  const [bonus] = lock ? await query.for('update') : await query;
  return bonus ?? null;
}

/** Пересчитывает скидку и итог заказа по текущей стоимости и зарезервированному бонусу. */
async function recalcTotals(tx: Tx, order: Order, bonus: Bonus | null): Promise<Order> {
  let discount = 0;
  let total: string | null = null;
  if (order.subtotal !== null) {
    if (bonus?.status === 'RESERVED')
      discount = computeDiscount(bonus, order.subtotal, order.serviceType).discount;
    total = fromMinor(toMinor(order.subtotal) - discount);
  }
  const [updated] = await tx
    .update(orders)
    .set({ discountAmount: fromMinor(discount), totalAmount: total, updatedAt: new Date() })
    .where(eq(orders.id, order.id))
    .returning();
  return updated!;
}

/** Начисляет право на вращение за заказ. Уникальный индекс не даст начислить дважды за один заказ. */
async function maybeGrantSpin(
  tx: Tx,
  config: Config,
  order: Order,
  user: User,
  event: 'ORDER_PAID' | 'ORDER_COMPLETED',
) {
  const settings = await getSettings(tx, config);
  if (settings.spinGrantTrigger !== event) return;
  const grant = await createSpinGrant(tx, config, {
    userId: order.userId,
    source: 'ORDER',
    sourceOrderId: order.id,
  });
  if (!grant) return;
  await logActivity(tx, user.id, 'SPIN_GRANTED', `Начислено вращение рулетки за заказ ${order.orderNumber}`);
  await notifyUser(tx, user, 'SPIN_GRANTED', { expiresAt: grant.expiresAt }, `spin-granted:${order.id}`);
}

// ── Создание заявки ──────────────────────────────────────────────────────────

export interface CreatedOrder {
  order: Order;
  bonus: Bonus | null;
  replayed: boolean;
}

/**
 * Создаёт заявку и, если клиент выбрал бонус, резервирует его — в одной транзакции.
 * actor — сам клиент либо сотрудник, оформляющий заявку от его имени.
 */
export async function createOrder(
  ctx: Ctx,
  userId: string,
  input: unknown,
  actor: Actor,
): Promise<CreatedOrder> {
  if (actor.type === 'STAFF') requirePermission(actor, 'orders.create');
  const data = parse(createOrderSchema, input);

  return ctx.db.transaction(async (tx) => {
    const user = await lockUser(tx, userId);
    if (user.accountStatus !== 'ACTIVE')
      throw forbidden('Аккаунт клиента заблокирован — оформление заявок недоступно');

    // Повторная доставка того же запроса: возвращаем уже созданную заявку.
    const [existing] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.userId, user.id), eq(orders.requestId, data.requestId)));
    if (existing) return { order: existing, bonus: await bonusOfOrder(tx, existing.id), replayed: true };

    const settings = await getSettings(tx, ctx.config);
    if (!settings.services.includes(data.serviceType)) {
      throw badRequest('SERVICE_UNKNOWN', 'Выберите услугу из списка');
    }

    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber: sql`'ORD-' || nextval('order_number_seq')`,
        userId: user.id,
        serviceType: data.serviceType,
        description: data.description,
        wishes: data.wishes,
        referenceUrl: data.referenceUrl,
        desiredDeadline: data.desiredDeadline,
        contact: data.contact,
        currency: settings.currency,
        requestId: data.requestId,
        createdByStaffId: staffIdOf(actor),
      })
      .returning();
    await tx.insert(orderStatusHistory).values({
      orderId: order!.id,
      previousStatus: null,
      newStatus: 'NEW',
      actorType: actor.type,
      changedBy: staffIdOf(actor),
      reason: null,
    });

    const bonus = data.useBonus ? await reserveBonus(tx, user, order!, actor) : null;

    await logActivity(tx, user.id, 'ORDER_CREATED', `Оформлена заявка ${order!.orderNumber}`);
    if (actor.type === 'STAFF') {
      await audit(tx, actor, 'order.create', 'order', order!.id, {
        userId: user.id,
        bonusId: bonus?.id ?? null,
      });
    }
    await notifyUser(
      tx,
      user,
      'ORDER_CREATED',
      { orderNumber: order!.orderNumber, serviceType: order!.serviceType, bonusName: bonus?.name ?? null },
      `order-created:${order!.id}`,
    );
    await notifyTeam(
      tx,
      ctx.config,
      'TEAM_NEW_ORDER',
      {
        orderId: order!.id,
        orderNumber: order!.orderNumber,
        telegramId: user.telegramId,
        username: user.username,
        displayName: user.displayName,
        serviceType: order!.serviceType,
        description: order!.description,
        contact: order!.contact,
        bonusName: bonus?.name ?? null,
      },
      `team-new-order:${order!.id}`,
    );
    return { order: order!, bonus, replayed: false };
  });
}

// ── Операции сотрудников ─────────────────────────────────────────────────────

function assertOpen(order: Order): void {
  if (order.status === 'CANCELLED') throw conflict('ORDER_CANCELLED', 'Заказ отменён');
  if (order.status === 'COMPLETED') throw conflict('ORDER_COMPLETED', 'Заказ уже выполнен');
}

export async function changeOrderStatus(
  ctx: Ctx,
  actor: Actor,
  orderId: string,
  input: unknown,
): Promise<Order> {
  requirePermission(actor, 'orders.update_status');
  const data = parse(
    z.object({ status: z.enum(ORDER_STATUSES), reason: z.string().trim().max(500).optional() }),
    input,
  );

  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status === data.status) return order;
    if (data.status === 'PAID') {
      throw badRequest(
        'USE_PAYMENT_CONFIRMATION',
        'Статус «Оплачен» выставляется только подтверждением оплаты',
      );
    }
    if (data.status === 'CANCELLED')
      throw badRequest('USE_CANCEL', 'Для отмены используйте действие «Отменить заказ»');
    if (!manualTransitions(order.status).includes(data.status)) {
      throw conflict(
        'TRANSITION_NOT_ALLOWED',
        `Переход из статуса «${order.status}» в «${data.status}» недопустим`,
      );
    }
    if (data.status === 'AWAITING_PAYMENT' && order.totalAmount === null) {
      throw conflict('PRICE_REQUIRED', 'Сначала укажите согласованную стоимость заказа');
    }
    if (data.status === 'COMPLETED' && order.paymentStatus !== 'PAID') {
      throw conflict('PAYMENT_REQUIRED', 'Нельзя завершить заказ без подтверждённой оплаты');
    }

    const [updated] = await tx
      .update(orders)
      .set({
        status: data.status,
        updatedAt: new Date(),
        completedAt: data.status === 'COMPLETED' ? new Date() : order.completedAt,
      })
      .where(eq(orders.id, order.id))
      .returning();
    const historyId = await addStatusHistory(tx, order, data.status, actor, data.reason ?? null);
    await audit(tx, actor, 'order.status', 'order', order.id, { from: order.status, to: data.status });

    const user = await lockUser(tx, order.userId);
    const settings = await getSettings(tx, ctx.config);
    await notifyUser(
      tx,
      user,
      'ORDER_STATUS',
      { orderNumber: order.orderNumber, statusLabel: settings.statusLabels[data.status] },
      `order-status:${historyId}`,
    );
    if (data.status === 'AWAITING_PAYMENT') {
      await notifyTeam(
        tx,
        ctx.config,
        'TEAM_AWAITING_PAYMENT',
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          displayName: user.displayName,
          username: user.username,
          total: updated!.totalAmount,
          currency: order.currency,
        },
        `team-awaiting-payment:${historyId}`,
      );
    }
    if (data.status === 'COMPLETED') await maybeGrantSpin(tx, ctx.config, updated!, user, 'ORDER_COMPLETED');
    return updated!;
  });
}

export async function setOrderPrice(ctx: Ctx, actor: Actor, orderId: string, input: unknown): Promise<Order> {
  requirePermission(actor, 'orders.set_price');
  const { subtotal } = parse(
    z.object({
      subtotal: z.string().trim().refine(isMoney, 'стоимость — число, например 15000 или 15000.50'),
    }),
    input,
  );
  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertOpen(order);
    if (order.paymentStatus !== 'UNPAID') {
      throw conflict('ALREADY_PAID', 'Оплата уже подтверждена — стоимость изменить нельзя');
    }
    const bonus = await bonusOfOrder(tx, order.id);
    const [priced] = await tx
      .update(orders)
      .set({ subtotal: fromMinor(toMinor(subtotal)) })
      .where(eq(orders.id, order.id))
      .returning();
    const updated = await recalcTotals(tx, priced!, bonus);
    // Полный снимок «до/после»: любое изменение сумм воспроизводимо из журнала.
    await audit(tx, actor, 'order.price', 'order', order.id, {
      before: { subtotal: order.subtotal, discount: order.discountAmount, total: order.totalAmount },
      after: { subtotal: updated.subtotal, discount: updated.discountAmount, total: updated.totalAmount },
      bonusId: bonus?.id ?? null,
    });
    return updated;
  });
}

export async function assignOrder(ctx: Ctx, actor: Actor, orderId: string, input: unknown): Promise<Order> {
  requirePermission(actor, 'orders.assign');
  const { staffId } = parse(z.object({ staffId: z.uuid().nullable() }), input);
  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (staffId) {
      const [member] = await tx.select().from(staff).where(eq(staff.id, staffId));
      if (!member?.isActive) throw badRequest('STAFF_UNKNOWN', 'Сотрудник не найден или отключён');
    }
    const [updated] = await tx
      .update(orders)
      .set({ assignedStaffId: staffId, updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();
    await audit(tx, actor, 'order.assign', 'order', order.id, { from: order.assignedStaffId, to: staffId });
    return updated!;
  });
}

/**
 * Подтверждение оплаты уполномоченным сотрудником. Идемпотентно: повторный вызов
 * для уже оплаченного заказа ничего не меняет и не создаёт вторую запись об оплате.
 */
export async function confirmPayment(
  ctx: Ctx,
  actor: Actor,
  orderId: string,
  input: unknown,
): Promise<Order> {
  requirePermission(actor, 'payments.confirm');
  const data = parse(
    z.object({
      amount: z.string().trim().refine(isMoney, 'сумма — число, например 15000'),
      paymentReference: text(200),
      notes: text(1000),
    }),
    input,
  );
  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.paymentStatus === 'PAID') return order;
    assertOpen(order);
    if (order.status !== 'AWAITING_PAYMENT') {
      throw conflict(
        'NOT_AWAITING_PAYMENT',
        'Подтвердить оплату можно только у заказа в статусе «Ожидает оплаты»',
      );
    }
    if (order.totalAmount === null) throw conflict('PRICE_REQUIRED', 'У заказа не указана стоимость');
    if (toMinor(data.amount) !== toMinor(order.totalAmount)) {
      throw conflict(
        'AMOUNT_MISMATCH',
        `Сумма оплаты должна совпадать с итогом заказа (${order.totalAmount} ${order.currency}). Если договорились о другой цене — сначала измените стоимость.`,
      );
    }

    const [payment] = await tx
      .insert(payments)
      .values({
        orderId: order.id,
        amount: order.totalAmount,
        currency: order.currency,
        status: 'CONFIRMED',
        paymentReference: data.paymentReference,
        notes: data.notes,
        confirmedBy: staffIdOf(actor),
      })
      .returning();
    const [updated] = await tx
      .update(orders)
      .set({ paymentStatus: 'PAID', status: 'PAID', paidAt: new Date(), updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();
    await addStatusHistory(tx, order, 'PAID', actor, 'Оплата подтверждена');
    await audit(tx, actor, 'payment.confirm', 'order', order.id, {
      paymentId: payment!.id,
      amount: payment!.amount,
      subtotal: order.subtotal,
      discount: order.discountAmount,
      reference: data.paymentReference,
    });

    const user = await lockUser(tx, order.userId);
    await logActivity(tx, user.id, 'PAYMENT_CONFIRMED', `Подтверждена оплата заказа ${order.orderNumber}`);
    await notifyUser(
      tx,
      user,
      'PAYMENT_CONFIRMED',
      { orderNumber: order.orderNumber, amount: payment!.amount, currency: order.currency },
      `payment:${payment!.id}`,
    );
    const bonus = await bonusOfOrder(tx, order.id);
    if (bonus?.status === 'RESERVED') {
      await notifyTeam(
        tx,
        ctx.config,
        'TEAM_BONUS_CONFIRM',
        { orderId: order.id, orderNumber: order.orderNumber, bonusName: bonus.name, username: user.username },
        `team-bonus-confirm:${payment!.id}`,
      );
    }
    await maybeGrantSpin(tx, ctx.config, updated!, user, 'ORDER_PAID');
    return updated!;
  });
}

/**
 * Подтверждение использования бонуса: RESERVED → REDEEMED. Возможно только после
 * подтверждённой оплаты. Идемпотентно: повторный вызов не списывает бонус второй раз.
 */
export async function redeemOrderBonus(ctx: Ctx, actor: Actor, orderId: string): Promise<Bonus> {
  requirePermission(actor, 'bonuses.redeem');
  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    const user = await lockUser(tx, order.userId);
    const bonus = await bonusOfOrder(tx, order.id, true);
    if (!bonus) throw conflict('NO_BONUS', 'К заказу не привязан бонус');
    if (bonus.status === 'REDEEMED' && bonus.redeemedOrderId === order.id) return bonus;
    if (order.status === 'CANCELLED')
      throw conflict('ORDER_CANCELLED', 'Заказ отменён — бонус списать нельзя');
    if (order.paymentStatus !== 'PAID') {
      throw conflict('PAYMENT_REQUIRED', 'Бонус списывается только после подтверждения оплаты');
    }
    const check = computeDiscount(bonus, order.subtotal!, order.serviceType);
    if (!check.applicable) {
      throw conflict('BONUS_NOT_APPLICABLE', `${check.reason}. Верните резерв, чтобы клиент сохранил бонус.`);
    }

    const redeemed = await redeemReservedBonus(tx, bonus, order, actor);
    await audit(tx, actor, 'bonus.redeem', 'bonus', bonus.id, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      subtotal: order.subtotal,
      discount: order.discountAmount,
      total: order.totalAmount,
    });
    await logActivity(
      tx,
      user.id,
      'BONUS_REDEEMED',
      `Бонус «${bonus.name}» применён к заказу ${order.orderNumber}`,
    );
    await notifyUser(
      tx,
      user,
      'BONUS_REDEEMED',
      {
        orderNumber: order.orderNumber,
        bonusName: bonus.name,
        discount: toMinor(order.discountAmount) > 0 ? order.discountAmount : null,
        currency: order.currency,
      },
      `bonus-redeemed:${bonus.id}`,
    );
    return redeemed;
  });
}

/**
 * Отмена заказа. До оплаты резерв бонуса снимается автоматически. После оплаты бонус
 * не возвращается сам: это отдельное решение сотрудника (возврат резерва или корректировка).
 */
export async function cancelOrder(ctx: Ctx, actor: Actor, orderId: string, input: unknown): Promise<Order> {
  requirePermission(actor, 'orders.cancel');
  const data = parse(z.object({ reason: reasonSchema, refunded: z.boolean().default(false) }), input);
  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status === 'CANCELLED') return order;
    if (order.status === 'COMPLETED') throw conflict('ORDER_COMPLETED', 'Выполненный заказ отменить нельзя');
    if (data.refunded) {
      if (!can(actor, 'payments.confirm'))
        throw forbidden('Отметить возврат денег может только сотрудник с правом подтверждения оплаты');
      if (order.paymentStatus !== 'PAID')
        throw conflict('NOT_PAID', 'Заказ не был оплачен — возвращать нечего');
    }
    const user = await lockUser(tx, order.userId);

    const [updated] = await tx
      .update(orders)
      .set({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: data.reason,
        paymentStatus: data.refunded ? 'REFUNDED' : order.paymentStatus,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id))
      .returning();
    await addStatusHistory(tx, order, 'CANCELLED', actor, data.reason);
    if (data.refunded) {
      await tx
        .update(payments)
        .set({ status: 'REFUNDED' })
        .where(and(eq(payments.orderId, order.id), eq(payments.status, 'CONFIRMED')));
    }

    let bonusReturned = false;
    if (order.paymentStatus === 'UNPAID') {
      const bonus = await bonusOfOrder(tx, order.id, true);
      if (bonus?.status === 'RESERVED') {
        await releaseReservedBonus(
          tx,
          bonus,
          user,
          actor,
          `Заказ ${order.orderNumber} отменён: ${data.reason}`,
        );
        bonusReturned = true;
      }
    }
    await audit(tx, actor, 'order.cancel', 'order', order.id, {
      reason: data.reason,
      wasPaid: order.paymentStatus === 'PAID',
      refunded: data.refunded,
      bonusReturned,
    });
    await logActivity(tx, user.id, 'ORDER_CANCELLED', `Заказ ${order.orderNumber} отменён`);
    await notifyUser(
      tx,
      user,
      'ORDER_CANCELLED',
      { orderNumber: order.orderNumber, reason: data.reason },
      `order-cancelled:${order.id}`,
    );
    return updated!;
  });
}

/** Возврат зарезервированного бонуса клиенту по решению сотрудника, с обязательной причиной. */
export async function releaseOrderBonus(
  ctx: Ctx,
  actor: Actor,
  orderId: string,
  input: unknown,
): Promise<Bonus> {
  requirePermission(actor, 'bonuses.release');
  const { reason } = parse(z.object({ reason: reasonSchema }), input);
  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    const user = await lockUser(tx, order.userId);
    const bonus = await bonusOfOrder(tx, order.id, true);
    if (!bonus || bonus.status !== 'RESERVED')
      throw conflict('BONUS_NOT_RESERVED', 'За заказом нет зарезервированного бонуса');

    const released = await releaseReservedBonus(tx, bonus, user, actor, reason);
    // До оплаты скидка снимается с заказа. После оплаты суммы не трогаем: оплата уже зафиксирована.
    const after =
      order.paymentStatus === 'UNPAID' && order.status !== 'CANCELLED'
        ? await recalcTotals(tx, order, null)
        : order;
    await audit(tx, actor, 'bonus.release', 'bonus', bonus.id, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      reason,
      resultStatus: released.status,
      before: { discount: order.discountAmount, total: order.totalAmount },
      after: { discount: after.discountAmount, total: after.totalAmount },
    });
    return released;
  });
}

/** Привязка активного бонуса клиента к уже созданному неоплаченному заказу. */
export async function attachBonusToOrder(ctx: Ctx, actor: Actor, orderId: string): Promise<Bonus> {
  requirePermission(actor, 'bonuses.release');
  return ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertOpen(order);
    if (order.paymentStatus !== 'UNPAID')
      throw conflict('ALREADY_PAID', 'Заказ уже оплачен — бонус привязать нельзя');
    const user = await lockUser(tx, order.userId);
    const bonus = await reserveBonus(tx, user, order, actor);
    const after = await recalcTotals(tx, order, bonus);
    await audit(tx, actor, 'bonus.reserve', 'bonus', bonus.id, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      before: { discount: order.discountAmount, total: order.totalAmount },
      after: { discount: after.discountAmount, total: after.totalAmount },
    });
    return bonus;
  });
}

/** Заказ клиента с проверкой принадлежности: чужой заказ неотличим от несуществующего. */
export async function getOwnOrder(tx: Tx | Ctx['db'], userId: string, orderId: string): Promise<Order> {
  if (!z.uuid().safeParse(orderId).success) throw notFound('Заказ не найден');
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId)));
  if (!order) throw notFound('Заказ не найден');
  return order;
}
