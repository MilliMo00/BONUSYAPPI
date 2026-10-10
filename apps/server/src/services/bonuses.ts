import { randomInt } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BonusStatus } from '../contract/constants.ts';
import type { Config } from '../config.ts';
import type { Db, Tx } from '../db/client.ts';
import { bonuses, bonusHistory, orders, prizes, users } from '../db/schema.ts';
import type { Bonus, Order, Prize, User } from '../db/schema.ts';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, parse } from '../lib/errors.ts';
import { audit, lockUser, logActivity, requirePermission, staffIdOf, SYSTEM } from './common.ts';
import type { Actor, Ctx } from './common.ts';
import { notifyStaffWith, notifyUser } from './notifications.ts';
import { getSettings } from './settings.ts';
import { createSpinGrant } from './spins.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// Без похожих символов (0/O, 1/I/L), чтобы номер было легко прочитать и продиктовать.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const BONUS_CODE_PREFIX = 'YB-';

export function generateBonusCode(): string {
  let body = '';
  for (let i = 0; i < 6; i++) body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return BONUS_CODE_PREFIX + body;
}

/** Подбирает свободный номер. Уникальный индекс в БД остаётся последним рубежом. */
async function freeBonusCode(tx: Tx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateBonusCode();
    const [taken] = await tx.select({ id: bonuses.id }).from(bonuses).where(eq(bonuses.code, code));
    if (!taken) return code;
  }
  throw new Error('Не удалось подобрать свободный номер бонуса');
}

/** Срок действия: у приза NULL — берём срок по умолчанию из настроек, 0 — бессрочно. */
export function computeExpiresAt(
  prizeValidityDays: number | null,
  defaultDays: number | null,
  from = new Date(),
) {
  const days = prizeValidityDays ?? defaultDays;
  return days && days > 0 ? new Date(from.getTime() + days * DAY_MS) : null;
}

function isExpired(bonus: Pick<Bonus, 'expiresAt'>, at = new Date()): boolean {
  return bonus.expiresAt !== null && bonus.expiresAt.getTime() <= at.getTime();
}

/** Единственная точка смены статуса бонуса: обновляет запись и пишет историю. */
async function transition(
  tx: Tx,
  bonus: Bonus,
  newStatus: BonusStatus,
  patch: Partial<typeof bonuses.$inferInsert>,
  actor: Actor,
  reason: string | null,
  orderId: string | null,
): Promise<Bonus> {
  const [updated] = await tx
    .update(bonuses)
    .set({ ...patch, status: newStatus, updatedAt: new Date() })
    .where(eq(bonuses.id, bonus.id))
    .returning();
  await tx.insert(bonusHistory).values({
    bonusId: bonus.id,
    previousStatus: bonus.status,
    newStatus,
    actorType: actor.type,
    changedBy: staffIdOf(actor),
    reason,
    orderId,
  });
  return updated!;
}

/**
 * Возвращает открытый (ACTIVE или RESERVED) бонус клиента, предварительно переводя
 * просроченный активный бонус в EXPIRED. Вызывать только после lockUser.
 */
export async function findOpenBonus(tx: Tx, userId: string): Promise<Bonus | null> {
  const [bonus] = await tx
    .select()
    .from(bonuses)
    .where(and(eq(bonuses.userId, userId), inArray(bonuses.status, ['ACTIVE', 'RESERVED'])))
    .for('update');
  if (!bonus) return null;
  // Срок действует и на бонус, ожидающий активации: «применить» его кнопкой — не способ продлить.
  // Исключение — бонус, закреплённый за заявкой (reservedOrderId): его судьбу решает заявка.
  if (isExpired(bonus) && (bonus.status === 'ACTIVE' || bonus.reservedOrderId === null)) {
    await transition(
      tx,
      bonus,
      'EXPIRED',
      { appliedAt: null },
      { type: 'SYSTEM' },
      'Истёк срок действия',
      null,
    );
    return null;
  }
  return bonus;
}

export interface IssueBonusInput {
  user: User;
  prize: Prize;
  source: 'SPIN' | 'MANUAL';
  sourceOrderId: string | null;
  actor: Actor;
  reason: string | null;
  /** Бонус с приветственного вращения — на первый заказ клиента */
  firstOrder?: boolean;
}

/** Создаёт бонус со снимком условий приза. Вызывать после lockUser и проверки findOpenBonus. */
export async function issueBonus(tx: Tx, config: Config, input: IssueBonusInput): Promise<Bonus> {
  const { prize, user } = input;
  const settings = await getSettings(tx, config);
  try {
    const [bonus] = await tx
      .insert(bonuses)
      .values({
        code: await freeBonusCode(tx),
        userId: user.id,
        prizeId: prize.id,
        source: input.source,
        sourceOrderId: input.sourceOrderId,
        name: prize.name,
        description: prize.description,
        type: prize.type,
        value: prize.value,
        minimumOrderAmount: prize.minimumOrderAmount,
        maximumDiscountAmount: prize.maximumDiscountAmount,
        rules: prize.rules,
        translations: prize.translations,
        status: 'ACTIVE',
        expiresAt: computeExpiresAt(prize.validityDays, settings.bonusValidityDays),
        metadata: input.firstOrder ? { firstOrder: true } : {},
      })
      .returning();
    await tx.insert(bonusHistory).values({
      bonusId: bonus!.id,
      previousStatus: null,
      newStatus: 'ACTIVE',
      actorType: input.actor.type,
      changedBy: staffIdOf(input.actor),
      reason: input.reason,
      orderId: input.sourceOrderId,
    });
    return bonus!;
  } catch (err) {
    // Последний рубеж: частичный уникальный индекс в БД.
    if (isUniqueViolation(err, 'bonuses_one_open_per_user_uidx')) {
      throw conflict('ACTIVE_BONUS_EXISTS', 'У клиента уже есть активный или зарезервированный бонус');
    }
    throw err;
  }
}

/** Резервирует активный бонус клиента за заказом. Вызывать после lockUser. */
export async function reserveBonus(tx: Tx, user: User, order: Order, actor: Actor): Promise<Bonus> {
  const bonus = await findOpenBonus(tx, user.id);
  if (!bonus) throw conflict('NO_ACTIVE_BONUS', 'Активного бонуса нет — возможно, срок его действия истёк');
  if (bonus.userId !== user.id) throw conflict('BONUS_FOREIGN', 'Бонус принадлежит другому клиенту');
  if (bonus.status === 'RESERVED') {
    throw conflict('BONUS_RESERVED', 'Бонус уже зарезервирован за другой заявкой');
  }
  if (bonus.sourceOrderId === order.id) {
    throw conflict('BONUS_SOURCE_ORDER', 'Бонус нельзя применить к заказу, за который он получен');
  }
  const allowed = bonus.rules.allowedServices;
  if (allowed.length > 0 && !allowed.includes(order.serviceType)) {
    throw badRequest('BONUS_SERVICE', `Этот бонус действует только на услуги: ${allowed.join(', ')}`);
  }
  try {
    return await transition(tx, bonus, 'RESERVED', { reservedOrderId: order.id }, actor, null, order.id);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('ORDER_HAS_BONUS', 'К этому заказу уже привязан бонус');
    throw err;
  }
}

/**
 * Снимает резерв. Если срок действия истёк за время резерва, бонус получает EXPIRED,
 * иначе возвращается в ACTIVE.
 */
export async function releaseReservedBonus(
  tx: Tx,
  bonus: Bonus,
  user: User,
  actor: Actor,
  reason: string,
): Promise<Bonus> {
  if (bonus.status !== 'RESERVED') throw conflict('BONUS_NOT_RESERVED', 'Бонус не находится в резерве');
  const orderId = bonus.reservedOrderId;
  const next: BonusStatus = isExpired(bonus) ? 'EXPIRED' : 'ACTIVE';
  const released = await transition(tx, bonus, next, { reservedOrderId: null }, actor, reason, orderId);
  if (next === 'ACTIVE') {
    await logActivity(tx, user.id, 'BONUS_RETURNED', `Бонус «${bonus.name}» снова активен`);
    await notifyUser(
      tx,
      user,
      'BONUS_RETURNED',
      { bonusName: bonus.name, expiresAt: bonus.expiresAt },
      `bonus-returned:${bonus.id}:${orderId ?? Date.now()}`,
      bonus,
    );
  }
  return released;
}

/** Списание: только из RESERVED, только за свой заказ. Вызывать после lockOrder и lockUser. */
export async function redeemReservedBonus(tx: Tx, bonus: Bonus, order: Order, actor: Actor): Promise<Bonus> {
  if (bonus.status !== 'RESERVED' || bonus.reservedOrderId !== order.id) {
    throw conflict('BONUS_NOT_RESERVED', 'Бонус не зарезервирован за этим заказом');
  }
  return transition(
    tx,
    bonus,
    'REDEEMED',
    {
      redeemedOrderId: order.id,
      redeemedAt: new Date(),
      redeemedByStaffId: staffIdOf(actor),
      discountAmount: order.discountAmount,
    },
    actor,
    'Оплата подтверждена, бонус применён',
    order.id,
  );
}

async function loadBonusForUpdate(tx: Tx, bonusId: string): Promise<{ bonus: Bonus; user: User }> {
  const [found] = await tx.select({ userId: bonuses.userId }).from(bonuses).where(eq(bonuses.id, bonusId));
  if (!found) throw notFound('Бонус не найден');
  const user = await lockUser(tx, found.userId);
  const [bonus] = await tx.select().from(bonuses).where(eq(bonuses.id, bonusId)).for('update');
  return { bonus: bonus!, user };
}

const reasonSchema = z.string().trim().min(3, 'укажите причину (от 3 символов)').max(500);

// ── Применение бонуса без заказа в приложении ────────────────────────────────
// Клиент нажимает «Применить бонус» и пишет менеджеру. Бонус переходит в RESERVED
// («Ожидает активации»): применить его повторно нельзя. Сотрудник активирует бонус
// (REDEEMED) либо возвращает клиенту (ACTIVE).

/** Клиент применяет свой бонус. Идемпотентно: повторное нажатие ничего не меняет и не шлёт второе уведомление. */
export async function applyBonus(ctx: Ctx, user: User, bonusId: string): Promise<Bonus> {
  return ctx.db.transaction(async (tx) => {
    const locked = await lockUser(tx, user.id);
    if (locked.accountStatus !== 'ACTIVE') throw forbidden('Участие в программе лояльности приостановлено');
    // Принадлежность проверяется в самом запросе: чужой бонус неотличим от несуществующего.
    const [bonus] = await tx
      .select()
      .from(bonuses)
      .where(and(eq(bonuses.id, bonusId), eq(bonuses.userId, locked.id)))
      .for('update');
    if (!bonus) throw notFound('Бонус не найден');
    if (bonus.status === 'RESERVED') return bonus;
    if (bonus.status !== 'ACTIVE')
      throw conflict('BONUS_NOT_ACTIVE', 'Этот бонус уже использован или недействителен');
    if (isExpired(bonus)) {
      await transition(tx, bonus, 'EXPIRED', {}, SYSTEM, 'Истёк срок действия', null);
      // Фиксируем истечение, а клиенту объясняем причину отдельным ответом.
      return { ...bonus, status: 'EXPIRED' as const };
    }
    const applied = await transition(
      tx,
      bonus,
      'RESERVED',
      { appliedAt: new Date() },
      { type: 'CLIENT', user: locked },
      'Клиент применил бонус',
      null,
    );
    await logActivity(tx, locked.id, 'BONUS_APPLIED', `Бонус «${bonus.name}» отправлен менеджеру`);
    await notifyStaffWith(
      tx,
      'bonuses.redeem',
      'TEAM_BONUS_APPLIED',
      {
        bonusId: bonus.id,
        bonusName: bonus.name,
        bonusCode: bonus.code,
        firstOrder: bonus.metadata?.firstOrder === true,
        telegramId: locked.telegramId,
        username: locked.username,
        displayName: locked.displayName,
        expiresAt: bonus.expiresAt,
      },
      `bonus-applied:${bonus.id}:${applied.appliedAt!.getTime()}`,
    );
    return applied;
  });
}

/**
 * Сотрудник активирует бонус: он считается использованным и пропадает из активных.
 * Можно активировать и бонус, который клиент ещё не «применил» кнопкой, а просто назвал номер.
 * Идемпотентно: повторная активация ничего не меняет.
 */
export async function activateBonus(
  ctx: Ctx,
  actor: Actor,
  bonusId: string,
): Promise<{ bonus: Bonus; changed: boolean }> {
  requirePermission(actor, 'bonuses.redeem');
  return ctx.db.transaction(async (tx) => {
    const { bonus, user } = await loadBonusForUpdate(tx, bonusId);
    if (bonus.status === 'REDEEMED') return { bonus, changed: false };
    if (bonus.status !== 'ACTIVE' && bonus.status !== 'RESERVED') {
      throw conflict('BONUS_NOT_ACTIVE', 'Бонус недействителен — активировать его нельзя');
    }
    if (isExpired(bonus) && bonus.reservedOrderId === null) {
      await transition(tx, bonus, 'EXPIRED', { appliedAt: null }, SYSTEM, 'Истёк срок действия', null);
      return { bonus: { ...bonus, status: 'EXPIRED' as const }, changed: false };
    }
    const redeemed = await transition(
      tx,
      bonus,
      'REDEEMED',
      { redeemedAt: new Date(), redeemedByStaffId: staffIdOf(actor) },
      actor,
      'Бонус активирован сотрудником',
      null,
    );
    await audit(tx, actor, 'bonus.activate', 'bonus', bonus.id, {
      userId: user.id,
      code: bonus.code,
      name: bonus.name,
      from: bonus.status,
    });
    await logActivity(tx, user.id, 'BONUS_REDEEMED', `Бонус «${bonus.name}» активирован`);

    let spinGranted = false;
    const settings = await getSettings(tx, ctx.config);
    if (settings.spinGrantTrigger === 'BONUS_ACTIVATED') {
      await createSpinGrant(tx, ctx.config, {
        userId: user.id,
        source: 'BONUS',
        reason: `Бонус ${bonus.code} активирован`,
      });
      await logActivity(tx, user.id, 'SPIN_GRANTED', 'Начислено вращение рулетки');
      spinGranted = true;
    }
    await notifyUser(
      tx,
      user,
      'BONUS_ACTIVATED',
      { bonusName: bonus.name, bonusCode: bonus.code, spinGranted },
      `bonus-activated:${bonus.id}`,
      bonus,
    );
    return { bonus: redeemed, changed: true };
  });
}

/** Сотрудник возвращает клиенту бонус, ожидавший активации (заказ не состоялся). */
export async function returnBonus(
  ctx: Ctx,
  actor: Actor,
  bonusId: string,
  input: unknown,
): Promise<{ bonus: Bonus; changed: boolean }> {
  requirePermission(actor, 'bonuses.release');
  const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), input ?? {});
  return ctx.db.transaction(async (tx) => {
    const { bonus, user } = await loadBonusForUpdate(tx, bonusId);
    if (bonus.status === 'ACTIVE') return { bonus, changed: false };
    if (bonus.status !== 'RESERVED') throw conflict('BONUS_NOT_PENDING', 'Бонус не ожидает активации');
    const why = reason || 'Возвращён клиенту сотрудником';
    const released = await releaseReservedBonus(tx, bonus, user, actor, why);
    await tx.update(bonuses).set({ appliedAt: null }).where(eq(bonuses.id, bonus.id));
    await audit(tx, actor, 'bonus.return', 'bonus', bonus.id, {
      userId: user.id,
      code: bonus.code,
      reason: why,
      result: released.status,
    });
    return { bonus: { ...released, appliedAt: null }, changed: true };
  });
}

// ── Ручные операции сотрудников ──────────────────────────────────────────────

export async function grantBonusManually(ctx: Ctx, actor: Actor, input: unknown): Promise<Bonus> {
  requirePermission(actor, 'bonuses.grant');
  const data = parse(z.object({ userId: z.uuid(), prizeId: z.uuid(), reason: reasonSchema }), input);
  return ctx.db.transaction(async (tx) => {
    const user = await lockUser(tx, data.userId);
    const [prize] = await tx.select().from(prizes).where(eq(prizes.id, data.prizeId));
    if (!prize || prize.archivedAt) throw notFound('Приз не найден');
    if (await findOpenBonus(tx, user.id)) {
      throw conflict('ACTIVE_BONUS_EXISTS', 'У клиента уже есть активный или зарезервированный бонус');
    }
    const bonus = await issueBonus(tx, ctx.config, {
      user,
      prize,
      source: 'MANUAL',
      sourceOrderId: null,
      actor,
      reason: data.reason,
    });
    await audit(tx, actor, 'bonus.grant_manual', 'bonus', bonus.id, {
      userId: user.id,
      prize: prize.name,
      reason: data.reason,
    });
    await logActivity(tx, user.id, 'BONUS_GRANTED', `Начислен бонус «${bonus.name}»`);
    await notifyUser(
      tx,
      user,
      'BONUS_GRANTED',
      { bonusName: bonus.name, bonusCode: bonus.code, expiresAt: bonus.expiresAt },
      `bonus-granted:${bonus.id}`,
      bonus,
    );
    return bonus;
  });
}

export async function cancelBonus(ctx: Ctx, actor: Actor, bonusId: string, input: unknown): Promise<Bonus> {
  requirePermission(actor, 'bonuses.cancel');
  const { reason } = parse(z.object({ reason: reasonSchema }), input);
  return ctx.db.transaction(async (tx) => {
    const { bonus } = await loadBonusForUpdate(tx, bonusId);
    if (bonus.status === 'CANCELLED') return bonus;
    if (bonus.status === 'RESERVED') {
      throw conflict('BONUS_RESERVED', 'Бонус ожидает активации — сначала верните его клиенту');
    }
    if (bonus.status !== 'ACTIVE')
      throw conflict('BONUS_NOT_ACTIVE', 'Аннулировать можно только активный бонус');
    const updated = await transition(tx, bonus, 'CANCELLED', {}, actor, reason, null);
    await audit(tx, actor, 'bonus.cancel', 'bonus', bonus.id, { reason });
    return updated;
  });
}

/**
 * Контролируемая корректировка: возвращает использованный, истёкший или аннулированный бонус
 * в ACTIVE. Использованный бонус можно вернуть только если заказ, на котором он списан, отменён.
 */
export async function correctBonus(ctx: Ctx, actor: Actor, bonusId: string, input: unknown): Promise<Bonus> {
  requirePermission(actor, 'bonuses.correct');
  const data = parse(
    z.object({
      reason: reasonSchema,
      extendDays: z.number().int().min(1).max(3650).nullable().default(null),
    }),
    input,
  );
  return ctx.db.transaction(async (tx) => {
    const { bonus, user } = await loadBonusForUpdate(tx, bonusId);
    if (bonus.status === 'ACTIVE' || bonus.status === 'RESERVED') {
      throw conflict('BONUS_OPEN', 'Бонус уже активен или зарезервирован — корректировка не требуется');
    }
    if (bonus.status === 'REDEEMED' && bonus.redeemedOrderId) {
      const [order] = await tx.select().from(orders).where(eq(orders.id, bonus.redeemedOrderId));
      if (order?.status !== 'CANCELLED') {
        throw conflict(
          'ORDER_NOT_CANCELLED',
          'Использованный бонус можно вернуть только после отмены заказа',
        );
      }
    }
    if (await findOpenBonus(tx, user.id)) {
      throw conflict('ACTIVE_BONUS_EXISTS', 'У клиента уже есть другой активный или зарезервированный бонус');
    }
    const expiresAt = data.extendDays ? new Date(Date.now() + data.extendDays * DAY_MS) : bonus.expiresAt;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw badRequest(
        'EXPIRY_REQUIRED',
        'Срок действия бонуса истёк — укажите, на сколько дней его продлить',
      );
    }
    const previousOrderId = bonus.redeemedOrderId ?? bonus.reservedOrderId;
    const updated = await transition(
      tx,
      bonus,
      'ACTIVE',
      {
        expiresAt,
        reservedOrderId: null,
        redeemedOrderId: null,
        appliedAt: null,
        redeemedAt: null,
        redeemedByStaffId: null,
        discountAmount: null,
        metadata: { ...bonus.metadata, correctedFrom: bonus.status, correctedOrderId: previousOrderId },
      },
      actor,
      data.reason,
      previousOrderId,
    );
    await audit(tx, actor, 'bonus.correct', 'bonus', bonus.id, {
      from: bonus.status,
      to: 'ACTIVE',
      reason: data.reason,
      previousExpiresAt: bonus.expiresAt,
      expiresAt,
      previousDiscountAmount: bonus.discountAmount,
      previousOrderId,
    });
    await logActivity(tx, user.id, 'BONUS_RETURNED', `Бонус «${bonus.name}» снова активен`);
    await notifyUser(
      tx,
      user,
      'BONUS_RETURNED',
      { bonusName: bonus.name, expiresAt },
      `bonus-corrected:${bonus.id}:${Date.now()}`,
      bonus,
    );
    return updated;
  });
}

// ── Фоновые задачи ───────────────────────────────────────────────────────────

/** Переводит в EXPIRED просроченные бонусы: активные и ожидающие активации. Закреплённые за заявкой не трогает. */
export async function expireDueBonuses(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(bonuses)
      .where(
        and(
          isNotNull(bonuses.expiresAt),
          lte(bonuses.expiresAt, sql`now()`),
          or(
            eq(bonuses.status, 'ACTIVE'),
            and(eq(bonuses.status, 'RESERVED'), isNull(bonuses.reservedOrderId)),
          ),
        ),
      )
      .for('update', { skipLocked: true });
    for (const bonus of due) {
      await transition(
        tx,
        bonus,
        'EXPIRED',
        { appliedAt: null },
        { type: 'SYSTEM' },
        'Истёк срок действия',
        null,
      );
    }
    return due.length;
  });
}

/** Ставит в очередь напоминания о скором истечении активных бонусов (по одному на бонус). */
export async function enqueueExpiryReminders(ctx: Ctx): Promise<number> {
  const settings = await getSettings(ctx.db, ctx.config);
  if (!settings.expiryReminderEnabled) return 0;
  const threshold = new Date(Date.now() + settings.expiryReminderDaysBefore * DAY_MS);
  const rows = await ctx.db
    .select({ bonus: bonuses, user: users })
    .from(bonuses)
    .innerJoin(users, eq(users.id, bonuses.userId))
    .where(
      and(
        eq(bonuses.status, 'ACTIVE'),
        isNotNull(bonuses.expiresAt),
        lte(bonuses.expiresAt, threshold),
        eq(users.accountStatus, 'ACTIVE'),
      ),
    );
  for (const { bonus, user } of rows) {
    await notifyUser(
      ctx.db,
      user,
      'BONUS_EXPIRING',
      { bonusName: bonus.name, expiresAt: bonus.expiresAt },
      `bonus-expiring:${bonus.id}:${bonus.expiresAt!.toISOString()}`,
      bonus,
    );
  }
  return rows.length;
}
