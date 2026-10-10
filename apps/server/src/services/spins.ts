// Вращения рулетки: начисление, срок действия, ручная выдача сотрудником по @username или Telegram ID.
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SpinLookupDto } from '../contract/api.ts';
import type { Config } from '../config.ts';
import type { Executor, Tx } from '../db/client.ts';
import { bonuses, spinGrants, users } from '../db/schema.ts';
import type { User } from '../db/schema.ts';
import { badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import { audit, lockUser, logActivity, requirePermission } from './common.ts';
import type { Actor, Ctx } from './common.ts';
import { notifyUser } from './notifications.ts';
import { getSettings } from './settings.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Условие «вращение ещё можно использовать»: не израсходовано и не сгорело. */
export const usableGrant = (userId: string) =>
  and(
    eq(spinGrants.userId, userId),
    isNull(spinGrants.consumedAt),
    or(isNull(spinGrants.expiresAt), gt(spinGrants.expiresAt, sql`now()`)),
  );

export async function usableGrants(db: Executor, userId: string) {
  return db.select().from(spinGrants).where(usableGrant(userId)).orderBy(asc(spinGrants.createdAt));
}

/** Создаёт вращение со сроком действия из настроек. Единственная точка начисления. */
export async function createSpinGrant(
  tx: Executor,
  config: Config,
  values: Pick<
    typeof spinGrants.$inferInsert,
    'userId' | 'source' | 'sourceOrderId' | 'grantedByStaffId' | 'reason'
  >,
) {
  const { spinValidityDays } = await getSettings(tx, config);
  const [grant] = await tx
    .insert(spinGrants)
    .values({ ...values, expiresAt: new Date(Date.now() + spinValidityDays * DAY_MS) })
    .onConflictDoNothing()
    .returning();
  return grant ?? null;
}

async function describe(db: Executor, user: User): Promise<SpinLookupDto> {
  const grants = await usableGrants(db, user.id);
  const [open] = await db
    .select()
    .from(bonuses)
    .where(and(eq(bonuses.userId, user.id), inArray(bonuses.status, ['ACTIVE', 'RESERVED'])));
  const bonusAlive = open && (open.expiresAt === null || open.expiresAt > new Date());
  const reason =
    user.accountStatus !== 'ACTIVE'
      ? 'Клиент заблокирован'
      : grants.length > 0
        ? 'У клиента уже есть неиспользованное вращение'
        : bonusAlive
          ? 'У клиента есть действующий бонус — сначала активируйте его или дождитесь, пока он сгорит'
          : null;
  return {
    client: {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
      displayName: user.displayName,
    },
    attempts: grants.length,
    attemptsExpireAt: grants[0]?.expiresAt?.toISOString() ?? null,
    openBonus: bonusAlive
      ? {
          id: open.id,
          code: open.code,
          name: open.name,
          status: open.status,
          expiresAt: open.expiresAt?.toISOString() ?? null,
        }
      : null,
    canGrant: reason === null,
    reason,
  };
}

/** Находит клиента по @username или Telegram ID и показывает, можно ли начислить ему вращение. */
export async function lookupClient(ctx: Ctx, actor: Actor, query: unknown): Promise<SpinLookupDto> {
  requirePermission(actor, 'spins.grant');
  const { q } = parse(
    z.object({ q: z.string().trim().min(2, 'введите @username или Telegram ID').max(64) }),
    query,
  );
  const value = q.replace(/^(https?:\/\/)?t\.me\//i, '').replace(/^@/, '');
  const [user] = /^\d{4,16}$/.test(value)
    ? await ctx.db
        .select()
        .from(users)
        .where(eq(users.telegramId, Number(value)))
    : /^\w{3,32}$/.test(value)
      ? await ctx.db
          .select()
          .from(users)
          .where(sql`lower(${users.username}) = ${value.toLowerCase()}`)
      : [];
  if (!user) {
    throw notFound(
      'Клиент не найден. Он должен хотя бы раз открыть бота; проверьте @username или введите Telegram ID',
    );
  }
  return describe(ctx.db, user);
}

/**
 * Сотрудник начисляет клиенту одно вращение за заказ. Не больше одного неиспользованного вращения
 * и не поверх действующего бонуса: так бонус нельзя получить, не сделав заказ.
 */
export async function grantSpin(ctx: Ctx, actor: Actor, input: unknown): Promise<SpinLookupDto> {
  requirePermission(actor, 'spins.grant');
  const { userId } = parse(z.object({ userId: z.uuid() }), input);
  return ctx.db.transaction(async (tx) => {
    const user = await lockUser(tx, userId);
    return grantSpinLocked(ctx, tx, actor, user);
  });
}

/** То же, но внутри уже открытой транзакции с заблокированной строкой клиента. */
export async function grantSpinLocked(ctx: Ctx, tx: Tx, actor: Actor, user: User): Promise<SpinLookupDto> {
  requirePermission(actor, 'spins.grant');
  const before = await describe(tx, user);
  if (!before.canGrant) throw conflict('SPIN_NOT_ALLOWED', before.reason!);
  const grant = await createSpinGrant(tx, ctx.config, {
    userId: user.id,
    source: 'MANUAL',
    grantedByStaffId: actor.type === 'STAFF' ? actor.staff.id : null,
    reason: 'Начислено за заказ',
  });
  if (!grant) throw badRequest('SPIN_FAILED', 'Не удалось начислить вращение');
  await audit(tx, actor, 'spin.grant', 'user', user.id, { grantId: grant.id, expiresAt: grant.expiresAt });
  await logActivity(tx, user.id, 'SPIN_GRANTED', 'Начислено вращение рулетки');
  await notifyUser(tx, user, 'SPIN_GRANTED', { expiresAt: grant.expiresAt }, `spin-granted:${grant.id}`);
  return describe(tx, user);
}

/**
 * Ставит в очередь напоминания клиентам, чьё вращение скоро сгорит (по одному на вращение).
 * За сколько дней напоминать и напоминать ли вообще — задаётся в настройках.
 */
export async function enqueueSpinReminders(ctx: Ctx): Promise<number> {
  const settings = await getSettings(ctx.db, ctx.config);
  if (!settings.spinReminderEnabled) return 0;
  const threshold = new Date(Date.now() + settings.spinReminderDaysBefore * DAY_MS);
  const rows = await ctx.db
    .select({ grant: spinGrants, user: users })
    .from(spinGrants)
    .innerJoin(users, eq(users.id, spinGrants.userId))
    .where(
      and(
        isNull(spinGrants.consumedAt),
        gt(spinGrants.expiresAt, sql`now()`),
        lte(spinGrants.expiresAt, threshold),
        eq(users.accountStatus, 'ACTIVE'),
        isNull(users.botBlockedAt),
      ),
    );
  for (const { grant, user } of rows) {
    await notifyUser(
      ctx.db,
      user,
      'SPIN_EXPIRING',
      { expiresAt: grant.expiresAt },
      `spin-expiring:${grant.id}`,
    );
  }
  return rows.length;
}
