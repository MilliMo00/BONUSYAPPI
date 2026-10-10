import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACCOUNT_STATUSES,
  BONUS_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PRIZE_TYPES,
  ROLES,
} from '../contract/constants.ts';
import type {
  AccountStatus,
  BonusStatus,
  Locale,
  OrderStatus,
  PaymentStatus,
  PermissionOverrides,
  PrizeType,
  Role,
} from '../contract/constants.ts';
import type { BroadcastButton, PrizeRules, PrizeTranslations } from '../contract/api.ts';

const id = () => uuid().primaryKey().defaultRandom();
const ts = () => timestamp({ withTimezone: true, mode: 'date' });
const createdAt = () => ts().notNull().defaultNow();
const money = () => numeric({ precision: 12, scale: 2 });
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

export const orderNumberSeq = pgSequence('order_number_seq', { startWith: 10001 });

export const users = pgTable(
  'users',
  {
    id: id(),
    telegramId: bigint({ mode: 'number' }).notNull().unique(),
    username: text(),
    displayName: text().notNull(),
    languageCode: text(),
    /** Язык, выбранный клиентом в боте или приложении; NULL — ещё не выбирал */
    locale: text().$type<Locale>(),
    /** Когда клиент нажал /start: только таким пользователям бот может писать */
    botStartedAt: ts(),
    /** Клиент заблокировал бота — рассылки и уведомления ему не отправляются */
    botBlockedAt: ts(),
    accountStatus: text().$type<AccountStatus>().notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: createdAt(),
    lastActiveAt: createdAt(),
  },
  (t) => [
    check('users_account_status_check', oneOf('account_status', ACCOUNT_STATUSES)),
    index('users_created_at_idx').on(t.createdAt),
  ],
);

export const staff = pgTable(
  'staff',
  {
    id: id(),
    telegramId: bigint({ mode: 'number' }).notNull().unique(),
    username: text(),
    displayName: text().notNull(),
    role: text().$type<Role>().notNull(),
    permissions: jsonb().$type<PermissionOverrides>().notNull().default({ grant: [], revoke: [] }),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  () => [check('staff_role_check', oneOf('role', ROLES))],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    orderNumber: text().notNull().unique(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    serviceType: text().notNull(),
    description: text().notNull(),
    wishes: text(),
    referenceUrl: text(),
    desiredDeadline: text(),
    contact: text(),
    status: text().$type<OrderStatus>().notNull().default('NEW'),
    paymentStatus: text().$type<PaymentStatus>().notNull().default('UNPAID'),
    assignedStaffId: uuid().references(() => staff.id),
    createdByStaffId: uuid().references(() => staff.id),
    subtotal: money(),
    discountAmount: money().notNull().default('0'),
    totalAmount: money(),
    currency: text().notNull(),
    cancelReason: text(),
    /** Ключ идемпотентности: повторная отправка формы не создаёт вторую заявку */
    requestId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
    paidAt: ts(),
    completedAt: ts(),
    cancelledAt: ts(),
  },
  (t) => [
    check('orders_status_check', oneOf('status', ORDER_STATUSES)),
    check('orders_payment_status_check', oneOf('payment_status', PAYMENT_STATUSES)),
    check(
      'orders_amounts_check',
      sql`(subtotal IS NULL OR subtotal >= 0) AND discount_amount >= 0 AND (total_amount IS NULL OR total_amount >= 0)`,
    ),
    uniqueIndex('orders_user_request_uidx').on(t.userId, t.requestId),
    index('orders_user_idx').on(t.userId, t.createdAt),
    index('orders_status_idx').on(t.status),
    index('orders_created_at_idx').on(t.createdAt),
  ],
);

export const prizes = pgTable(
  'prizes',
  {
    id: id(),
    name: text().notNull(),
    description: text().notNull().default(''),
    type: text().$type<PrizeType>().notNull(),
    value: money(),
    /** Вероятность в процентах, 0.00–100.00 */
    probability: numeric({ precision: 5, scale: 2 }).notNull(),
    isActive: boolean().notNull().default(true),
    /** NULL — срок по умолчанию из настроек, 0 — бессрочно */
    validityDays: integer(),
    minimumOrderAmount: money(),
    maximumDiscountAmount: money(),
    rules: jsonb().$type<PrizeRules>().notNull(),
    translations: jsonb().$type<PrizeTranslations>().notNull().default({}),
    sortOrder: integer().notNull().default(0),
    /** Мягкое удаление: приз скрыт из настроек, но остаётся в истории выигрышей */
    archivedAt: ts(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  () => [
    check('prizes_type_check', oneOf('type', PRIZE_TYPES)),
    check('prizes_probability_check', sql`probability >= 0 AND probability <= 100`),
  ],
);

export const bonuses = pgTable(
  'bonuses',
  {
    id: id(),
    /** Короткий уникальный номер бонуса: клиент называет его менеджеру, сотрудник находит по нему бонус */
    code: text().notNull().unique(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    prizeId: uuid().references(() => prizes.id),
    source: text().$type<'SPIN' | 'MANUAL'>().notNull(),
    sourceOrderId: uuid().references(() => orders.id),
    reservedOrderId: uuid().references(() => orders.id),
    redeemedOrderId: uuid().references(() => orders.id),
    // Снимок условий приза на момент выигрыша: изменение настроек рулетки не меняет выданные бонусы.
    name: text().notNull(),
    description: text().notNull().default(''),
    type: text().$type<PrizeType>().notNull(),
    value: money(),
    minimumOrderAmount: money(),
    maximumDiscountAmount: money(),
    rules: jsonb().$type<PrizeRules>().notNull(),
    translations: jsonb().$type<PrizeTranslations>().notNull().default({}),
    status: text().$type<BonusStatus>().notNull().default('ACTIVE'),
    discountAmount: money(),
    redeemedByStaffId: uuid().references(() => staff.id),
    createdAt: createdAt(),
    updatedAt: createdAt(),
    expiresAt: ts(),
    /** Клиент нажал «Применить бонус»: бонус ждёт активации сотрудником */
    appliedAt: ts(),
    redeemedAt: ts(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    check('bonuses_status_check', oneOf('status', BONUS_STATUSES)),
    check('bonuses_type_check', oneOf('type', PRIZE_TYPES)),
    // Главный инвариант программы: не более одного активного или зарезервированного бонуса на клиента.
    uniqueIndex('bonuses_one_open_per_user_uidx')
      .on(t.userId)
      .where(sql`status IN ('ACTIVE', 'RESERVED')`),
    // Один заказ — один бонус.
    uniqueIndex('bonuses_reserved_order_uidx')
      .on(t.reservedOrderId)
      .where(sql`reserved_order_id IS NOT NULL`),
    uniqueIndex('bonuses_redeemed_order_uidx')
      .on(t.redeemedOrderId)
      .where(sql`redeemed_order_id IS NOT NULL`),
    index('bonuses_user_idx').on(t.userId, t.createdAt),
    index('bonuses_status_idx').on(t.status, t.expiresAt),
  ],
);

/** Право на вращение. Каждое вращение расходует одну запись. */
export const spinGrants = pgTable(
  'spin_grants',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    source: text().$type<'WELCOME' | 'ORDER' | 'BONUS' | 'MANUAL'>().notNull(),
    sourceOrderId: uuid().references(() => orders.id),
    grantedByStaffId: uuid().references(() => staff.id),
    reason: text(),
    /** Вращение нужно использовать до этого момента, иначе оно сгорает */
    expiresAt: ts(),
    consumedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    // Повторная обработка одного события заказа не начисляет вторую попытку.
    uniqueIndex('spin_grants_order_uidx')
      .on(t.sourceOrderId)
      .where(sql`source_order_id IS NOT NULL`),
    index('spin_grants_user_idx').on(t.userId, t.consumedAt),
  ],
);

export const spins = pgTable(
  'spins',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    grantId: uuid()
      .notNull()
      .unique()
      .references(() => spinGrants.id),
    bonusId: uuid()
      .notNull()
      .references(() => bonuses.id),
    prizeId: uuid()
      .notNull()
      .references(() => prizes.id),
    result: jsonb().$type<Record<string, unknown>>().notNull(),
    requestId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('spins_user_request_uidx').on(t.userId, t.requestId),
    index('spins_created_at_idx').on(t.createdAt),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    amount: money().notNull(),
    currency: text().notNull(),
    status: text().$type<'CONFIRMED' | 'REFUNDED'>().notNull(),
    paymentReference: text(),
    confirmedBy: uuid().references(() => staff.id),
    confirmedAt: createdAt(),
    notes: text(),
  },
  (t) => [
    check('payments_status_check', oneOf('status', ['CONFIRMED', 'REFUNDED'])),
    check('payments_amount_check', sql`amount >= 0`),
    // Одну оплату заказа нельзя подтвердить дважды.
    uniqueIndex('payments_one_confirmed_per_order_uidx')
      .on(t.orderId)
      .where(sql`status = 'CONFIRMED'`),
    index('payments_order_idx').on(t.orderId),
  ],
);

export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    previousStatus: text(),
    newStatus: text().notNull(),
    actorType: text().$type<'CLIENT' | 'STAFF' | 'SYSTEM'>().notNull(),
    changedBy: uuid().references(() => staff.id),
    reason: text(),
    createdAt: createdAt(),
  },
  (t) => [index('order_status_history_order_idx').on(t.orderId, t.createdAt)],
);

export const bonusHistory = pgTable(
  'bonus_history',
  {
    id: id(),
    bonusId: uuid()
      .notNull()
      .references(() => bonuses.id),
    previousStatus: text(),
    newStatus: text().notNull(),
    actorType: text().$type<'CLIENT' | 'STAFF' | 'SYSTEM'>().notNull(),
    changedBy: uuid().references(() => staff.id),
    reason: text(),
    orderId: uuid().references(() => orders.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('bonus_history_bonus_idx').on(t.bonusId, t.createdAt),
    index('bonus_history_status_idx').on(t.newStatus, t.createdAt),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorType: text().$type<'CLIENT' | 'STAFF' | 'SYSTEM'>().notNull(),
    /** staff.id либо users.id — в зависимости от actor_type */
    actorId: uuid(),
    actorRole: text(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.createdAt),
    index('audit_logs_created_at_idx').on(t.createdAt),
  ],
);

export const userActivity = pgTable(
  'user_activity',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    type: text().notNull(),
    title: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('user_activity_user_idx').on(t.userId, t.createdAt)],
);

/** Очередь исходящих уведомлений (outbox): запись создаётся в бизнес-транзакции, отправка — отдельно. */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    recipientType: text().$type<'USER' | 'STAFF' | 'TEAM_CHAT'>().notNull(),
    /** Telegram chat id получателя */
    recipientId: text().notNull(),
    notificationType: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text().$type<'PENDING' | 'SENT' | 'FAILED'>().notNull().default('PENDING'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    /** Защита от повторной постановки одного и того же уведомления */
    dedupeKey: text().unique(),
    nextAttemptAt: createdAt(),
    createdAt: createdAt(),
    sentAt: ts(),
  },
  (t) => [
    check('notifications_status_check', oneOf('status', ['PENDING', 'SENT', 'FAILED'])),
    index('notifications_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`status = 'PENDING'`),
  ],
);

/** Рассылка подписчикам бота. Получатели фиксируются в момент создания. */
export const broadcasts = pgTable('broadcasts', {
  id: id(),
  createdByStaffId: uuid().references(() => staff.id),
  text: text().notNull(),
  mediaKind: text().$type<'photo' | 'voice'>(),
  /** file_id Telegram: файл загружается один раз, дальше рассылается по идентификатору */
  mediaFileId: text(),
  buttons: jsonb().$type<BroadcastButton[]>().notNull().default([]),
  locale: text().$type<Locale>(),
  status: text().$type<'SENDING' | 'DONE' | 'CANCELLED'>().notNull().default('SENDING'),
  total: integer().notNull().default(0),
  createdAt: createdAt(),
  finishedAt: ts(),
});

export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    status: text().$type<'PENDING' | 'SENT' | 'FAILED'>().notNull().default('PENDING'),
    error: text(),
    sentAt: ts(),
  },
  (t) => [
    // Один получатель — одно сообщение в рамках рассылки.
    primaryKey({ columns: [t.broadcastId, t.userId] }),
    index('broadcast_recipients_pending_idx')
      .on(t.broadcastId)
      .where(sql`status = 'PENDING'`),
  ],
);

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().$type<Record<string, unknown>>().notNull(),
  updatedAt: createdAt(),
});

export type User = typeof users.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Prize = typeof prizes.$inferSelect;
export type Bonus = typeof bonuses.$inferSelect;
export type Payment = typeof payments.$inferSelect;
