// Преобразование строк БД в DTO и общие запросы чтения для клиента и админ-панели.
import { and, desc, eq, getTableColumns } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AdminBonusRow, AdminOrderRow, BonusDto, OrderDto } from '../contract/api.ts';
import type { Locale } from '../contract/constants.ts';
import type { Executor } from '../db/client.ts';
import { bonuses, orders, staff, users } from '../db/schema.ts';
import type { Bonus, Order } from '../db/schema.ts';
import { localizePrize } from './i18n.ts';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
const ref = (id: string | null, orderNumber: string | null) =>
  id && orderNumber ? { id, orderNumber } : null;

interface OrderNumbers {
  source: string | null;
  reserved: string | null;
  redeemed: string | null;
}

export function toBonusDto(
  b: Bonus,
  numbers: OrderNumbers = { source: null, reserved: null, redeemed: null },
  /** Язык клиента; сотрудники всегда видят русские названия */
  locale: Locale = 'ru',
): BonusDto {
  const text = localizePrize(b, locale);
  return {
    id: b.id,
    code: b.code,
    firstOrder: b.metadata?.firstOrder === true,
    name: text.name,
    description: text.description,
    type: b.type,
    value: b.value,
    status: b.status,
    createdAt: iso(b.createdAt),
    expiresAt: isoOrNull(b.expiresAt),
    appliedAt: isoOrNull(b.appliedAt),
    redeemedAt: isoOrNull(b.redeemedAt),
    discountAmount: b.discountAmount,
    minOrderAmount: b.minimumOrderAmount,
    maxDiscountAmount: b.maximumDiscountAmount,
    rules: { ...b.rules, terms: text.terms },
    source: b.source,
    sourceOrder: ref(b.sourceOrderId, numbers.source),
    reservedOrder: ref(b.reservedOrderId, numbers.reserved),
    redeemedOrder: ref(b.redeemedOrderId, numbers.redeemed),
  };
}

export function toOrderDto(o: Order, bonus: Bonus | null): OrderDto {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    serviceType: o.serviceType,
    description: o.description,
    wishes: o.wishes,
    referenceUrl: o.referenceUrl,
    desiredDeadline: o.desiredDeadline,
    contact: o.contact,
    status: o.status,
    paymentStatus: o.paymentStatus,
    subtotal: o.subtotal,
    discountAmount: o.discountAmount,
    totalAmount: o.totalAmount,
    currency: o.currency,
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
    paidAt: isoOrNull(o.paidAt),
    completedAt: isoOrNull(o.completedAt),
    cancelledAt: isoOrNull(o.cancelledAt),
    bonus: bonus
      ? { id: bonus.id, name: bonus.name, type: bonus.type, value: bonus.value, status: bonus.status }
      : null,
  };
}

const sourceOrder = alias(orders, 'source_order');
const reservedOrder = alias(orders, 'reserved_order');
const redeemedOrder = alias(orders, 'redeemed_order');
const redeemer = alias(staff, 'redeemer');

export interface ListOptions {
  where?: SQL;
  orderBy?: SQL;
  limit?: number;
  offset?: number;
}

/** Бонусы с номерами связанных заказов и клиентом. */
export async function queryBonuses(
  db: Executor,
  opts: ListOptions = {},
  locale: Locale = 'ru',
): Promise<AdminBonusRow[]> {
  const rows = await db
    .select({
      bonus: getTableColumns(bonuses),
      client: {
        id: users.id,
        telegramId: users.telegramId,
        username: users.username,
        displayName: users.displayName,
      },
      source: sourceOrder.orderNumber,
      reserved: reservedOrder.orderNumber,
      redeemed: redeemedOrder.orderNumber,
      redeemedBy: redeemer.displayName,
    })
    .from(bonuses)
    .innerJoin(users, eq(users.id, bonuses.userId))
    .leftJoin(sourceOrder, eq(sourceOrder.id, bonuses.sourceOrderId))
    .leftJoin(reservedOrder, eq(reservedOrder.id, bonuses.reservedOrderId))
    .leftJoin(redeemedOrder, eq(redeemedOrder.id, bonuses.redeemedOrderId))
    .leftJoin(redeemer, eq(redeemer.id, bonuses.redeemedByStaffId))
    .where(opts.where)
    .orderBy(opts.orderBy ?? desc(bonuses.createdAt))
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0);
  return rows.map((r) => ({ ...toBonusDto(r.bonus, r, locale), client: r.client, redeemedBy: r.redeemedBy }));
}

/** Заказы с клиентом, ответственным и привязанным бонусом. */
export async function queryOrders(db: Executor, opts: ListOptions = {}): Promise<AdminOrderRow[]> {
  const rows = await db
    .select({
      order: getTableColumns(orders),
      client: {
        id: users.id,
        telegramId: users.telegramId,
        username: users.username,
        displayName: users.displayName,
      },
      assignedStaff: { id: staff.id, displayName: staff.displayName },
      bonus: getTableColumns(bonuses),
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .leftJoin(staff, eq(staff.id, orders.assignedStaffId))
    .leftJoin(bonuses, eq(bonuses.reservedOrderId, orders.id))
    .where(opts.where)
    .orderBy(opts.orderBy ?? desc(orders.createdAt))
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0);
  return rows.map((r) => ({
    ...toOrderDto(r.order, r.bonus),
    client: r.client,
    assignedStaff: r.assignedStaff,
  }));
}

/** Заказы одного клиента — только его собственные. */
export async function ordersOfUser(db: Executor, userId: string, orderId?: string): Promise<OrderDto[]> {
  const rows = await queryOrders(db, {
    where: and(eq(orders.userId, userId), orderId ? eq(orders.id, orderId) : undefined),
  });
  // Клиенту не отдаём служебные поля админ-панели.
  return rows.map(({ client: _client, assignedStaff: _staff, ...order }) => order);
}

export async function bonusesOfUser(
  db: Executor,
  userId: string,
  locale: Locale,
  bonusId?: string,
): Promise<BonusDto[]> {
  const rows = await queryBonuses(
    db,
    { where: and(eq(bonuses.userId, userId), bonusId ? eq(bonuses.id, bonusId) : undefined) },
    locale,
  );
  return rows.map(({ client: _client, redeemedBy: _by, ...bonus }) => bonus);
}
