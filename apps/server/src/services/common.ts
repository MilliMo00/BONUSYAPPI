import { eq, sql } from 'drizzle-orm';
import type { Permission } from '../contract/constants.ts';
import type { Config } from '../config.ts';
import type { Db, Executor, Tx } from '../db/client.ts';
import { auditLogs, orders, userActivity, users } from '../db/schema.ts';
import type { Order, Staff, User } from '../db/schema.ts';
import { forbidden, notFound } from '../lib/errors.ts';

export interface Ctx {
  db: Db;
  config: Config;
}

export type Actor =
  | { type: 'STAFF'; staff: Staff; permissions: ReadonlySet<Permission> }
  | { type: 'CLIENT'; user: User }
  | { type: 'SYSTEM' };

export const SYSTEM: Actor = { type: 'SYSTEM' };

export function staffIdOf(actor: Actor): string | null {
  return actor.type === 'STAFF' ? actor.staff.id : null;
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.type === 'STAFF' && actor.permissions.has(permission);
}

/** Проверка права выполняется на сервере в каждой операции, а не только на уровне маршрута. */
export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw forbidden('Недостаточно прав для этого действия');
}

export async function audit(
  tx: Executor,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: actor.type,
    actorId: actor.type === 'STAFF' ? actor.staff.id : actor.type === 'CLIENT' ? actor.user.id : null,
    actorRole: actor.type === 'STAFF' ? actor.staff.role : null,
    action,
    entityType,
    entityId,
    details,
  });
}

export async function logActivity(tx: Executor, userId: string, type: string, title: string): Promise<void> {
  await tx.insert(userActivity).values({ userId, type, title });
}

/**
 * Блокирует строку клиента до конца транзакции. Все операции, меняющие бонусы клиента,
 * сначала берут эту блокировку — так параллельные запросы выполняются строго по очереди.
 * Порядок блокировок везде одинаковый: заказ → клиент → бонус.
 */
export async function lockUser(tx: Tx, userId: string): Promise<User> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
  if (!user) throw notFound('Клиент не найден');
  return user;
}

export async function lockOrder(tx: Tx, orderId: string): Promise<Order> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  if (!order) throw notFound('Заказ не найден');
  return order;
}

export const now = sql`now()`;
