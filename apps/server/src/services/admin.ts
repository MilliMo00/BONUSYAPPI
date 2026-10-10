// Запросы чтения и управляющие операции админ-панели.
import { and, asc, count, desc, eq, exists, gte, ilike, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ActivityDto,
  AdminBonusCard,
  AdminClientCard,
  AdminClientRow,
  AdminOrderCard,
  AuditDto,
  DashboardDto,
  HistoryEntry,
  Paginated,
  PaymentDto,
  StaffDto,
  StatsDto,
} from '../contract/api.ts';
import {
  ACCOUNT_STATUSES,
  BONUS_STATUSES,
  effectivePermissions,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PERMISSIONS,
  PRIZE_TYPES,
  ROLES,
} from '../contract/constants.ts';
import type { Executor } from '../db/client.ts';
import {
  auditLogs,
  bonuses,
  bonusHistory,
  orders,
  orderStatusHistory,
  payments,
  staff,
  userActivity,
  users,
} from '../db/schema.ts';
import type { Staff } from '../db/schema.ts';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../lib/errors.ts';
import { computeDiscount } from '../lib/money.ts';
import { audit, can, lockUser, requirePermission } from './common.ts';
import type { Actor, Ctx } from './common.ts';
import { queryBonuses, queryOrders } from './dto.ts';
import { getSettings } from './settings.ts';
import { usableGrants } from './spins.ts';

const iso = (d: Date) => d.toISOString();
const PAGE_SIZE = 25;

// ── Период ───────────────────────────────────────────────────────────────────

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodSchema = z.object({ from: dateOnly.optional(), to: dateOnly.optional() });

/** Период [from, to) в UTC; по умолчанию — последние 30 дней включая сегодня. */
export function parsePeriod(query: unknown): { from: Date; to: Date } {
  const q = parse(periodSchema, query);
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const to = new Date((q.to ? new Date(q.to + 'T00:00:00Z') : today).getTime() + 86_400_000);
  const from = q.from ? new Date(q.from + 'T00:00:00Z') : new Date(to.getTime() - 30 * 86_400_000);
  if (from >= to) throw badRequest('PERIOD', 'Начало периода должно быть раньше конца');
  return { from, to };
}

const between = (column: SQL | string, p: { from: Date; to: Date }) =>
  sql`(${typeof column === 'string' ? sql.raw(column) : column} >= ${iso(p.from)}::timestamptz AND ${
    typeof column === 'string' ? sql.raw(column) : column
  } < ${iso(p.to)}::timestamptz)`;

async function one<T>(db: Executor, query: SQL): Promise<T> {
  const result = await db.execute(query);
  return result.rows[0] as T;
}

// ── Дашборд и статистика ─────────────────────────────────────────────────────

export async function getDashboard(ctx: Ctx, actor: Actor, query: unknown): Promise<DashboardDto> {
  const p = parsePeriod(query);
  const r = await one<Record<string, string>>(
    ctx.db,
    sql`SELECT
      (SELECT count(*) FROM users) AS clients_total,
      (SELECT count(*) FROM users WHERE ${between('created_at', p)}) AS clients_new,
      (SELECT count(*) FROM orders) AS orders_total,
      (SELECT count(*) FROM orders WHERE ${between('created_at', p)}) AS orders_in_period,
      (SELECT count(*) FROM orders WHERE status = 'NEW') AS orders_new,
      (SELECT count(*) FROM orders WHERE status IN ('IN_PROGRESS', 'REVIEW')) AS orders_in_progress,
      (SELECT count(*) FROM orders WHERE status = 'AWAITING_PAYMENT') AS orders_awaiting_payment,
      (SELECT count(*) FROM orders o WHERE ${between('o.created_at', p)} AND EXISTS (
         SELECT 1 FROM orders prev WHERE prev.user_id = o.user_id AND prev.created_at < o.created_at AND prev.status <> 'CANCELLED'
       )) AS repeat_orders,
      (SELECT count(*) FROM bonuses WHERE status = 'ACTIVE') AS bonuses_active,
      (SELECT count(*) FROM bonuses WHERE status = 'RESERVED') AS bonuses_reserved,
      (SELECT count(*) FROM bonuses WHERE status = 'REDEEMED' AND ${between('redeemed_at', p)}) AS bonuses_redeemed,
      (SELECT coalesce(sum(discount_amount), 0) FROM bonuses WHERE status = 'REDEEMED' AND ${between('redeemed_at', p)}) AS discounts,
      (SELECT coalesce(sum(subtotal), 0) FROM orders WHERE payment_status = 'PAID' AND ${between('paid_at', p)}) AS subtotal,
      (SELECT coalesce(sum(total_amount), 0) FROM orders WHERE payment_status = 'PAID' AND ${between('paid_at', p)}) AS total`,
  );
  const settings = await getSettings(ctx.db, ctx.config);
  return {
    period: { from: iso(p.from), to: iso(p.to) },
    clientsTotal: Number(r.clients_total),
    clientsNew: Number(r.clients_new),
    ordersTotal: Number(r.orders_total),
    ordersInPeriod: Number(r.orders_in_period),
    ordersNew: Number(r.orders_new),
    ordersInProgress: Number(r.orders_in_progress),
    ordersAwaitingPayment: Number(r.orders_awaiting_payment),
    repeatOrders: Number(r.repeat_orders),
    bonusesActive: Number(r.bonuses_active),
    bonusesReserved: Number(r.bonuses_reserved),
    bonusesRedeemed: Number(r.bonuses_redeemed),
    finance: can(actor, 'finance.view')
      ? { discounts: r.discounts!, subtotal: r.subtotal!, total: r.total!, currency: settings.currency }
      : null,
  };
}

export async function getStats(ctx: Ctx, actor: Actor, query: unknown): Promise<StatsDto> {
  requirePermission(actor, 'stats.view');
  const p = parsePeriod(query);
  const withBonus = sql`EXISTS (SELECT 1 FROM bonuses b WHERE b.redeemed_order_id = o.id AND b.status = 'REDEEMED')`;
  const paidInPeriod = sql`o.payment_status = 'PAID' AND ${between('o.paid_at', p)}`;
  const r = await one<Record<string, string | null>>(
    ctx.db,
    sql`SELECT
      (SELECT count(*) FROM spins WHERE ${between('created_at', p)}) AS spins,
      (SELECT count(*) FROM bonuses WHERE ${between('created_at', p)}) AS issued,
      (SELECT count(*) FROM bonuses WHERE status = 'REDEEMED' AND ${between('redeemed_at', p)}) AS redeemed,
      (SELECT count(*) FROM bonus_history WHERE new_status = 'EXPIRED' AND ${between('created_at', p)}) AS expired,
      (SELECT count(*) FROM bonuses b WHERE ${between('b.created_at', p)} AND EXISTS (
         SELECT 1 FROM bonus_history h WHERE h.bonus_id = b.id AND h.new_status = 'RESERVED')) AS applied,
      (SELECT avg(extract(epoch FROM redeemed_at - created_at)) / 3600 FROM bonuses
         WHERE status = 'REDEEMED' AND ${between('redeemed_at', p)}) AS avg_hours,
      (SELECT count(*) FROM (SELECT user_id FROM orders WHERE status <> 'CANCELLED' GROUP BY user_id) t) AS buyers,
      (SELECT count(*) FROM (SELECT user_id FROM orders WHERE status <> 'CANCELLED' GROUP BY user_id HAVING count(*) >= 2) t) AS repeat_buyers,
      (SELECT coalesce(sum(discount_amount), 0) FROM bonuses WHERE status = 'REDEEMED' AND ${between('redeemed_at', p)}) AS discounts,
      (SELECT coalesce(sum(o.total_amount), 0) FROM orders o WHERE ${paidInPeriod} AND ${withBonus}) AS revenue_with_bonus,
      (SELECT round(avg(o.total_amount), 2) FROM orders o WHERE ${paidInPeriod} AND ${withBonus}) AS avg_with,
      (SELECT round(avg(o.total_amount), 2) FROM orders o WHERE ${paidInPeriod} AND NOT ${withBonus}) AS avg_without`,
  );
  const distribution = await ctx.db.execute(
    sql`SELECT result->>'prizeName' AS name, count(*)::int AS count FROM spins
        WHERE ${between('created_at', p)} GROUP BY 1 ORDER BY 2 DESC`,
  );
  const settings = await getSettings(ctx.db, ctx.config);
  const issued = Number(r.issued);
  const buyers = Number(r.buyers);
  return {
    period: { from: iso(p.from), to: iso(p.to) },
    spins: Number(r.spins),
    distribution: distribution.rows as { name: string; count: number }[],
    bonusesIssued: issued,
    bonusesRedeemed: Number(r.redeemed),
    bonusesExpired: Number(r.expired),
    winToOrderConversion: issued > 0 ? Number(r.applied) / issued : null,
    avgHoursToRedeem: r.avg_hours === null ? null : Number(r.avg_hours),
    repeatClientsShare: buyers > 0 ? Number(r.repeat_buyers) / buyers : null,
    finance: can(actor, 'finance.view')
      ? {
          discounts: r.discounts!,
          revenueWithBonus: r.revenue_with_bonus!,
          avgCheckWithBonus: r.avg_with ?? null,
          avgCheckWithoutBonus: r.avg_without ?? null,
          currency: settings.currency,
        }
      : null,
  };
}

// ── Клиенты ──────────────────────────────────────────────────────────────────

const pageSchema = z.coerce.number().int().min(1).max(100000).default(1);
const optionalString = z.string().trim().max(100).optional();

const clientsQuery = z.object({
  q: optionalString,
  status: z.enum(ACCOUNT_STATUSES).optional(),
  hasBonus: z.enum(['yes', 'no']).optional(),
  sort: z
    .enum(['createdAt', 'lastActiveAt', 'displayName', 'ordersCount', 'ordersTotal'])
    .default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: pageSchema,
});

const CLIENT_SORT: Record<z.infer<typeof clientsQuery>['sort'], string> = {
  createdAt: 'u.created_at',
  lastActiveAt: 'u.last_active_at',
  displayName: 'lower(u.display_name)',
  ordersCount: 'orders_count',
  ordersTotal: 'orders_total',
};

interface ClientSqlRow {
  id: string;
  telegram_id: string;
  username: string | null;
  display_name: string;
  created_at: Date;
  last_active_at: Date;
  account_status: AdminClientRow['accountStatus'];
  orders_count: number;
  orders_total: string | null;
  active_bonuses: number;
  total_count: number;
}

async function selectClients(db: Executor, where: SQL, tail: SQL, showMoney: boolean) {
  const result = await db.execute(sql`
    SELECT u.id, u.telegram_id, u.username, u.display_name, u.created_at, u.last_active_at, u.account_status,
           o.orders_count, o.orders_total, b.active_bonuses, count(*) OVER ()::int AS total_count
    FROM users u
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS orders_count, sum(total_amount) FILTER (WHERE payment_status = 'PAID') AS orders_total
      FROM orders WHERE user_id = u.id AND status <> 'CANCELLED'
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS active_bonuses FROM bonuses WHERE user_id = u.id AND status IN ('ACTIVE', 'RESERVED')
    ) b ON true
    WHERE ${where} ${tail}`);
  const rows = result.rows as unknown as ClientSqlRow[];
  return {
    total: rows[0]?.total_count ?? 0,
    items: rows.map((r): AdminClientRow => ({
      id: r.id,
      telegramId: Number(r.telegram_id),
      username: r.username,
      displayName: r.display_name,
      createdAt: iso(new Date(r.created_at)),
      lastActiveAt: iso(new Date(r.last_active_at)),
      accountStatus: r.account_status,
      ordersCount: r.orders_count,
      ordersTotal: showMoney ? r.orders_total : null,
      activeBonuses: r.active_bonuses,
    })),
  };
}

export async function listClients(
  ctx: Ctx,
  actor: Actor,
  query: unknown,
  all = false,
): Promise<Paginated<AdminClientRow>> {
  requirePermission(actor, 'clients.view');
  const q = parse(clientsQuery, query);
  const conds: SQL[] = [sql`true`];
  if (q.q) {
    const like = `%${q.q.replace(/^@/, '').replace(/[%_\\]/g, '\\$&')}%`;
    conds.push(
      sql`(u.display_name ILIKE ${like} OR u.username ILIKE ${like} OR u.telegram_id::text LIKE ${like})`,
    );
  }
  if (q.status) conds.push(sql`u.account_status = ${q.status}`);
  if (q.hasBonus) conds.push(sql`b.active_bonuses ${sql.raw(q.hasBonus === 'yes' ? '> 0' : '= 0')}`);
  const order = sql.raw(
    `ORDER BY ${CLIENT_SORT[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, u.id`,
  );
  const tail = all ? order : sql`${order} LIMIT ${PAGE_SIZE} OFFSET ${(q.page - 1) * PAGE_SIZE}`;
  const { items, total } = await selectClients(
    ctx.db,
    sql.join(conds, sql` AND `),
    tail,
    can(actor, 'finance.view'),
  );
  return { items, total, page: q.page, pageSize: PAGE_SIZE };
}

const staffName = sql<string | null>`(SELECT display_name FROM staff WHERE staff.id = `;

function actorLabel(actorType: string, name: string | null): string {
  return actorType === 'STAFF' ? (name ?? 'Сотрудник') : actorType === 'CLIENT' ? 'Клиент' : 'Система';
}

async function auditFor(db: Executor, where: SQL, limit = 100): Promise<AuditDto[]> {
  const rows = await db
    .select({ log: auditLogs, name: sql<string | null>`${staffName}${auditLogs.actorId})` })
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map(({ log, name }) => ({
    id: log.id,
    actor: actorLabel(log.actorType, name),
    actorRole: log.actorRole,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    details: log.details,
    createdAt: iso(log.createdAt),
  }));
}

async function paymentsFor(db: Executor, where: SQL): Promise<PaymentDto[]> {
  const rows = await db
    .select({
      p: payments,
      orderNumber: orders.orderNumber,
      by: sql<string | null>`${staffName}${payments.confirmedBy})`,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(where)
    .orderBy(desc(payments.confirmedAt));
  return rows.map(({ p, orderNumber, by }) => ({
    id: p.id,
    orderId: p.orderId,
    orderNumber,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    paymentReference: p.paymentReference,
    notes: p.notes,
    confirmedBy: by,
    confirmedAt: iso(p.confirmedAt),
  }));
}

const uuidParam = (id: string, what: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound(`${what} не найден`);
  return id;
};

export async function getClientCard(ctx: Ctx, actor: Actor, clientId: string): Promise<AdminClientCard> {
  requirePermission(actor, 'clients.view');
  uuidParam(clientId, 'Клиент');
  const showMoney = can(actor, 'finance.view');
  const { items } = await selectClients(ctx.db, sql`u.id = ${clientId}`, sql``, showMoney);
  const client = items[0];
  if (!client) throw notFound('Клиент не найден');
  const attempts = (await usableGrants(ctx.db, clientId)).length;
  const activity = await ctx.db
    .select()
    .from(userActivity)
    .where(eq(userActivity.userId, clientId))
    .orderBy(desc(userActivity.createdAt))
    .limit(100);
  return {
    client: { ...client, spinAttempts: attempts },
    orders: can(actor, 'orders.view')
      ? await queryOrders(ctx.db, { where: eq(orders.userId, clientId) })
      : [],
    bonuses: can(actor, 'bonuses.view')
      ? await queryBonuses(ctx.db, { where: eq(bonuses.userId, clientId) })
      : [],
    payments:
      showMoney || can(actor, 'payments.confirm')
        ? await paymentsFor(ctx.db, eq(orders.userId, clientId))
        : [],
    activity: activity.map(toActivityDto),
    audit: await auditFor(
      ctx.db,
      sql`(${auditLogs.entityId} = ${clientId} OR ${auditLogs.details}->>'userId' = ${clientId}
           OR ${auditLogs.entityId} IN (SELECT id FROM orders WHERE user_id = ${clientId})
           OR ${auditLogs.entityId} IN (SELECT id FROM bonuses WHERE user_id = ${clientId}))`,
    ),
  };
}

export function toActivityDto(a: typeof userActivity.$inferSelect): ActivityDto {
  return { id: a.id, type: a.type, title: a.title, createdAt: iso(a.createdAt) };
}

export async function setClientStatus(
  ctx: Ctx,
  actor: Actor,
  clientId: string,
  input: unknown,
): Promise<void> {
  requirePermission(actor, 'clients.manage');
  uuidParam(clientId, 'Клиент');
  const data = parse(
    z.object({ status: z.enum(ACCOUNT_STATUSES), reason: z.string().trim().min(3).max(500) }),
    input,
  );
  await ctx.db.transaction(async (tx) => {
    const user = await lockUser(tx, clientId);
    if (user.accountStatus === data.status) return;
    await tx
      .update(users)
      .set({ accountStatus: data.status, updatedAt: new Date() })
      .where(eq(users.id, clientId));
    await audit(tx, actor, 'client.status', 'user', clientId, {
      from: user.accountStatus,
      to: data.status,
      reason: data.reason,
    });
  });
}

// ── Заказы ───────────────────────────────────────────────────────────────────

const ordersQuery = z.object({
  q: optionalString,
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  staffId: z.union([z.uuid(), z.literal('none')]).optional(),
  hasBonus: z.enum(['yes', 'no']).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: pageSchema,
});

function ordersWhere(query: unknown) {
  const q = parse(ordersQuery, query);
  const linked = sql`(SELECT 1 FROM bonuses b WHERE b.reserved_order_id = ${orders.id})`;
  const conds: (SQL | undefined)[] = [
    q.status ? eq(orders.status, q.status) : undefined,
    q.paymentStatus ? eq(orders.paymentStatus, q.paymentStatus) : undefined,
    q.staffId === 'none'
      ? isNull(orders.assignedStaffId)
      : q.staffId
        ? eq(orders.assignedStaffId, q.staffId)
        : undefined,
    q.hasBonus === 'yes' ? exists(linked) : q.hasBonus === 'no' ? notExists(linked) : undefined,
    q.from ? gte(orders.createdAt, new Date(q.from + 'T00:00:00Z')) : undefined,
    q.to ? lt(orders.createdAt, new Date(new Date(q.to + 'T00:00:00Z').getTime() + 86_400_000)) : undefined,
  ];
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
    conds.push(
      or(
        ilike(orders.orderNumber, like),
        ilike(orders.serviceType, like),
        exists(
          sql`(SELECT 1 FROM users cu WHERE cu.id = ${orders.userId} AND (cu.display_name ILIKE ${like} OR cu.username ILIKE ${like}))`,
        ),
      ),
    );
  }
  return { where: and(...conds), page: q.page };
}

export async function listOrders(ctx: Ctx, actor: Actor, query: unknown, all = false) {
  requirePermission(actor, 'orders.view');
  const { where, page } = ordersWhere(query);
  const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(orders).where(where);
  const items = await queryOrders(ctx.db, {
    where,
    limit: all ? 100_000 : PAGE_SIZE,
    offset: all ? 0 : (page - 1) * PAGE_SIZE,
  });
  return { items, total, page, pageSize: PAGE_SIZE };
}

export async function getOrderCard(ctx: Ctx, actor: Actor, orderId: string): Promise<AdminOrderCard> {
  requirePermission(actor, 'orders.view');
  uuidParam(orderId, 'Заказ');
  const [row] = await queryOrders(ctx.db, { where: eq(orders.id, orderId) });
  if (!row) throw notFound('Заказ не найден');
  const [raw] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));

  const history = await ctx.db
    .select({ h: orderStatusHistory, name: sql<string | null>`${staffName}${orderStatusHistory.changedBy})` })
    .from(orderStatusHistory)
    .where(eq(orderStatusHistory.orderId, orderId))
    .orderBy(asc(orderStatusHistory.createdAt));

  const [bonusDetails] = row.bonus ? await queryBonuses(ctx.db, { where: eq(bonuses.id, row.bonus.id) }) : [];
  let discountNote: string | null = null;
  if (bonusDetails?.status === 'RESERVED' && row.subtotal !== null) {
    const check = computeDiscount(
      {
        type: bonusDetails.type,
        value: bonusDetails.value,
        minimumOrderAmount: bonusDetails.minOrderAmount,
        maximumDiscountAmount: bonusDetails.maxDiscountAmount,
        rules: bonusDetails.rules,
      },
      row.subtotal,
      row.serviceType,
    );
    discountNote = check.applicable ? null : check.reason;
  }

  let attachableBonus: AdminOrderCard['attachableBonus'] = null;
  if (!row.bonus && row.paymentStatus === 'UNPAID' && !['CANCELLED', 'COMPLETED'].includes(row.status)) {
    const [active] = await ctx.db
      .select({
        id: bonuses.id,
        name: bonuses.name,
        expiresAt: bonuses.expiresAt,
        sourceOrderId: bonuses.sourceOrderId,
      })
      .from(bonuses)
      .where(and(eq(bonuses.userId, row.client.id), eq(bonuses.status, 'ACTIVE')));
    if (active && active.sourceOrderId !== orderId && (!active.expiresAt || active.expiresAt > new Date())) {
      attachableBonus = { id: active.id, name: active.name };
    }
  }

  return {
    ...row,
    cancelReason: raw!.cancelReason,
    statusHistory: history.map(({ h, name }): HistoryEntry => ({
      id: h.id,
      previousStatus: h.previousStatus,
      newStatus: h.newStatus,
      actor: actorLabel(h.actorType, name),
      reason: h.reason,
      createdAt: iso(h.createdAt),
    })),
    payments: await paymentsFor(ctx.db, eq(payments.orderId, orderId)),
    audit: await auditFor(
      ctx.db,
      sql`(${auditLogs.entityId} = ${orderId} OR ${auditLogs.details}->>'orderId' = ${orderId})`,
    ),
    bonusDetails: bonusDetails ?? null,
    attachableBonus,
    discountNote,
  };
}

// ── Бонусы ───────────────────────────────────────────────────────────────────

const bonusesQuery = z.object({
  q: optionalString,
  status: z.enum(BONUS_STATUSES).optional(),
  type: z.enum(PRIZE_TYPES).optional(),
  userId: z.uuid().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  page: pageSchema,
});

export async function listBonuses(ctx: Ctx, actor: Actor, query: unknown, all = false) {
  requirePermission(actor, 'bonuses.view');
  const q = parse(bonusesQuery, query);
  const like = q.q ? `%${q.q.replace(/^@/, '').replace(/[%_\\]/g, '\\$&')}%` : null;
  // Номер бонуса сотрудник может ввести в любом виде: «yb-7kq4mx», «YB 7KQ4MX», «7kq4mx».
  const codeBody = (q.q ?? '').replace(/[^0-9A-Za-z]/g, '').replace(/^yb/i, '');
  const codeLike = codeBody.length >= 3 ? `%${codeBody}%` : null;
  const where = and(
    q.status ? eq(bonuses.status, q.status) : undefined,
    q.type ? eq(bonuses.type, q.type) : undefined,
    q.userId ? eq(bonuses.userId, q.userId) : undefined,
    q.from ? gte(bonuses.createdAt, new Date(q.from + 'T00:00:00Z')) : undefined,
    q.to ? lt(bonuses.createdAt, new Date(new Date(q.to + 'T00:00:00Z').getTime() + 86_400_000)) : undefined,
    like
      ? or(
          ilike(bonuses.name, like),
          codeLike ? ilike(bonuses.code, codeLike) : undefined,
          exists(
            sql`(SELECT 1 FROM users cu WHERE cu.id = ${bonuses.userId} AND (cu.display_name ILIKE ${like} OR cu.username ILIKE ${like} OR cu.telegram_id::text LIKE ${like}))`,
          ),
        )
      : undefined,
  );
  const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(bonuses).where(where);
  const items = await queryBonuses(ctx.db, {
    where,
    limit: all ? 100_000 : PAGE_SIZE,
    offset: all ? 0 : (q.page - 1) * PAGE_SIZE,
  });
  return { items, total, page: q.page, pageSize: PAGE_SIZE };
}

export async function getBonusCard(ctx: Ctx, actor: Actor, bonusId: string): Promise<AdminBonusCard> {
  requirePermission(actor, 'bonuses.view');
  uuidParam(bonusId, 'Бонус');
  const [row] = await queryBonuses(ctx.db, { where: eq(bonuses.id, bonusId) });
  if (!row) throw notFound('Бонус не найден');
  const history = await ctx.db
    .select({
      h: bonusHistory,
      name: sql<string | null>`${staffName}${bonusHistory.changedBy})`,
      orderNumber: orders.orderNumber,
    })
    .from(bonusHistory)
    .leftJoin(orders, eq(orders.id, bonusHistory.orderId))
    .where(eq(bonusHistory.bonusId, bonusId))
    .orderBy(asc(bonusHistory.createdAt));
  return {
    ...row,
    history: history.map(({ h, name, orderNumber }) => ({
      id: h.id,
      previousStatus: h.previousStatus,
      newStatus: h.newStatus,
      actor: actorLabel(h.actorType, name),
      reason: h.reason,
      orderNumber,
      createdAt: iso(h.createdAt),
    })),
  };
}

// ── Сотрудники ───────────────────────────────────────────────────────────────

export function toStaffDto(s: Staff): StaffDto {
  return {
    id: s.id,
    telegramId: s.telegramId,
    username: s.username,
    displayName: s.displayName,
    role: s.role,
    permissions: { grant: s.permissions.grant ?? [], revoke: s.permissions.revoke ?? [] },
    effectivePermissions: effectivePermissions(s.role, s.permissions),
    isActive: s.isActive,
    createdAt: iso(s.createdAt),
  };
}

export async function listStaff(ctx: Ctx, actor: Actor): Promise<StaffDto[]> {
  // Список имён нужен и для назначения ответственных, поэтому достаточно доступа к заказам.
  if (!can(actor, 'staff.manage') && !can(actor, 'orders.view')) requirePermission(actor, 'staff.manage');
  const rows = await ctx.db.select().from(staff).orderBy(asc(staff.createdAt));
  return rows.map(toStaffDto);
}

const overridesSchema = z.object({
  grant: z.array(z.enum(PERMISSIONS)).default([]),
  revoke: z.array(z.enum(PERMISSIONS)).default([]),
});
const telegramIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export async function createStaff(ctx: Ctx, actor: Actor, input: unknown): Promise<StaffDto> {
  requirePermission(actor, 'staff.manage');
  const data = parse(
    z.object({
      telegramId: telegramIdSchema,
      displayName: z.string().trim().min(1, 'укажите имя').max(120),
      role: z.enum(ROLES),
      permissions: overridesSchema.default({ grant: [], revoke: [] }),
    }),
    input,
  );
  return ctx.db.transaction(async (tx) => {
    try {
      const [created] = await tx.insert(staff).values(data).returning();
      await audit(tx, actor, 'staff.create', 'staff', created!.id, {
        telegramId: data.telegramId,
        role: data.role,
        permissions: data.permissions,
      });
      return toStaffDto(created!);
    } catch (err) {
      if (isUniqueViolation(err))
        throw conflict('STAFF_EXISTS', 'Сотрудник с таким Telegram ID уже добавлен');
      throw err;
    }
  });
}

export async function updateStaff(
  ctx: Ctx,
  actor: Actor,
  staffId: string,
  input: unknown,
): Promise<StaffDto> {
  requirePermission(actor, 'staff.manage');
  uuidParam(staffId, 'Сотрудник');
  const data = parse(
    z.object({
      displayName: z.string().trim().min(1).max(120).optional(),
      role: z.enum(ROLES).optional(),
      permissions: overridesSchema.optional(),
      isActive: z.boolean().optional(),
    }),
    input,
  );
  return ctx.db.transaction(async (tx) => {
    // Блокируем всех владельцев, чтобы два параллельных запроса не оставили систему без владельца.
    const owners = await tx.select().from(staff).where(eq(staff.role, 'OWNER')).for('update');
    const [current] = await tx.select().from(staff).where(eq(staff.id, staffId)).for('update');
    if (!current) throw notFound('Сотрудник не найден');
    const next = { ...current, ...data };
    const wasOwner = current.role === 'OWNER' && current.isActive;
    const staysOwner = next.role === 'OWNER' && next.isActive;
    if (wasOwner && !staysOwner && owners.filter((o) => o.isActive).length <= 1) {
      throw conflict('LAST_OWNER', 'Нельзя отключить или понизить единственного владельца');
    }
    const [updated] = await tx
      .update(staff)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(staff.id, staffId))
      .returning();
    await audit(tx, actor, 'staff.update', 'staff', staffId, {
      before: {
        displayName: current.displayName,
        role: current.role,
        permissions: current.permissions,
        isActive: current.isActive,
      },
      after: {
        displayName: updated!.displayName,
        role: updated!.role,
        permissions: updated!.permissions,
        isActive: updated!.isActive,
      },
    });
    return toStaffDto(updated!);
  });
}

// ── Журнал аудита ────────────────────────────────────────────────────────────

export async function listAudit(ctx: Ctx, actor: Actor, query: unknown): Promise<Paginated<AuditDto>> {
  requirePermission(actor, 'audit.view');
  const q = parse(z.object({ action: optionalString, entityType: optionalString, page: pageSchema }), query);
  const where =
    and(
      q.action ? ilike(auditLogs.action, `${q.action.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
      q.entityType ? eq(auditLogs.entityType, q.entityType) : undefined,
    ) ?? sql`true`;
  const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(auditLogs).where(where);
  const rows = await ctx.db
    .select({ log: auditLogs, name: sql<string | null>`${staffName}${auditLogs.actorId})` })
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(PAGE_SIZE)
    .offset((q.page - 1) * PAGE_SIZE);
  return {
    items: rows.map(({ log, name }) => ({
      id: log.id,
      actor: actorLabel(log.actorType, name),
      actorRole: log.actorRole,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      details: log.details,
      createdAt: iso(log.createdAt),
    })),
    total,
    page: q.page,
    pageSize: PAGE_SIZE,
  };
}

// ── Экспорт CSV ──────────────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Защита от формул в Excel/Sheets: значения, начинающиеся с = + - @, экранируются апострофом.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  // BOM — чтобы Excel корректно открыл кириллицу.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const EXPORT_TABLES = ['clients', 'orders', 'bonuses', 'spins'] as const;

export async function exportCsv(ctx: Ctx, actor: Actor, table: string, query: unknown): Promise<string> {
  requirePermission(actor, 'reports.export');
  const money = can(actor, 'finance.view');
  const hidden = 'нет доступа';
  switch (table) {
    case 'clients': {
      const { items } = await listClients(ctx, actor, query, true);
      return toCsv(
        [
          'Telegram ID',
          'Username',
          'Имя',
          'Регистрация',
          'Последняя активность',
          'Статус',
          'Заказов',
          'Сумма оплаченных заказов',
          'Открытых бонусов',
        ],
        items.map((c) => [
          c.telegramId,
          c.username,
          c.displayName,
          c.createdAt,
          c.lastActiveAt,
          c.accountStatus,
          c.ordersCount,
          money ? c.ordersTotal : hidden,
          c.activeBonuses,
        ]),
      );
    }
    case 'orders': {
      const { items } = await listOrders(ctx, actor, query, true);
      return toCsv(
        [
          'Номер',
          'Создан',
          'Клиент',
          'Telegram ID',
          'Услуга',
          'Статус',
          'Оплата',
          'Ответственный',
          'Сумма до скидки',
          'Скидка',
          'Итого',
          'Валюта',
          'Бонус',
          'Статус бонуса',
          'Оплачен',
          'Выполнен',
          'Отменён',
        ],
        items.map((o) => [
          o.orderNumber,
          o.createdAt,
          o.client.displayName,
          o.client.telegramId,
          o.serviceType,
          o.status,
          o.paymentStatus,
          o.assignedStaff?.displayName,
          o.subtotal,
          o.discountAmount,
          o.totalAmount,
          o.currency,
          o.bonus?.name,
          o.bonus?.status,
          o.paidAt,
          o.completedAt,
          o.cancelledAt,
        ]),
      );
    }
    case 'bonuses': {
      const { items } = await listBonuses(ctx, actor, query, true);
      return toCsv(
        [
          'ID бонуса',
          'Клиент',
          'Telegram ID',
          'Приз',
          'Тип',
          'Значение',
          'Статус',
          'Получен',
          'Истекает',
          'Заявка (резерв)',
          'Заказ использования',
          'Сумма скидки',
          'Использован',
          'Подтвердил',
        ],
        items.map((b) => [
          b.id,
          b.client.displayName,
          b.client.telegramId,
          b.name,
          b.type,
          b.value,
          b.status,
          b.createdAt,
          b.expiresAt,
          b.reservedOrder?.orderNumber,
          b.redeemedOrder?.orderNumber,
          b.discountAmount,
          b.redeemedAt,
          b.redeemedBy,
        ]),
      );
    }
    case 'spins': {
      const p = parsePeriod(query);
      const result = await ctx.db.execute(
        sql`SELECT s.id, s.created_at, u.display_name, u.telegram_id, s.result->>'prizeName' AS prize, s.bonus_id
            FROM spins s JOIN users u ON u.id = s.user_id WHERE ${between('s.created_at', p)} ORDER BY s.created_at DESC`,
      );
      return toCsv(
        ['ID вращения', 'Дата', 'Клиент', 'Telegram ID', 'Выигрыш', 'ID бонуса'],
        result.rows.map((r) => [
          r.id,
          new Date(r.created_at as string).toISOString(),
          r.display_name,
          r.telegram_id,
          r.prize,
          r.bonus_id,
        ]),
      );
    }
    default:
      throw notFound('Такой выгрузки нет');
  }
}
