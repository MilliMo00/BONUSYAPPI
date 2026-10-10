import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { PrizeDto, RouletteState, SpinAvailability } from '../contract/api.ts';
import { PRIZE_TYPES, ROUNDING_RULES } from '../contract/constants.ts';
import type { Executor, Tx } from '../db/client.ts';
import { prizes, spinGrants, spins } from '../db/schema.ts';
import type { Bonus, Prize, User } from '../db/schema.ts';
import { AppError, badRequest, forbidden, isUniqueViolation, parse } from '../lib/errors.ts';
import { isMoney, toMinor } from '../lib/money.ts';
import { findOpenBonus, issueBonus } from './bonuses.ts';
import { audit, lockUser, logActivity, requirePermission } from './common.ts';
import type { Actor, Ctx } from './common.ts';
import { localeOf, localizePrize } from './i18n.ts';
import { notifyUser } from './notifications.ts';
import { getSettings } from './settings.ts';
import { usableGrant, usableGrants } from './spins.ts';

/** Анимация колеса длится около 6 секунд; с запасом на медленную связь. */
const WIN_MESSAGE_DELAY_SECONDS = 12;

const TOTAL_BP = 10_000; // 100.00% в сотых долях процента

/** Вероятность "35.00" → 3500 сотых долей процента. */
const toBp = (probability: string) => toMinor(probability);

export function activePrizes(db: Executor): Promise<Prize[]> {
  return db
    .select()
    .from(prizes)
    .where(and(eq(prizes.isActive, true), isNull(prizes.archivedAt)))
    .orderBy(asc(prizes.sortOrder), asc(prizes.createdAt));
}

export function isConfigValid(list: { probability: string }[]): boolean {
  return list.length >= 2 && list.reduce((sum, p) => sum + toBp(p.probability), 0) === TOTAL_BP;
}

/**
 * Выбирает приз по настроенным вероятностям.
 * roll — целое число в диапазоне [0, 10000), полученное из криптографического генератора.
 */
export function pickPrize<T extends Pick<Prize, 'probability'>>(list: T[], roll: number): T {
  let cumulative = 0;
  for (const prize of list) {
    cumulative += toBp(prize.probability);
    if (roll < cumulative) return prize;
  }
  throw new Error('Конфигурация рулетки некорректна: сумма вероятностей меньше 100%');
}

const MESSAGES = {
  ACTIVE_BONUS:
    'У тебя уже есть активный бонус! Используй его в следующем заказе, чтобы получить новый шанс на выигрыш.',
  NOT_CONFIGURED: 'Рулетка временно недоступна — мы обновляем призы. Загляните чуть позже.',
  BLOCKED: 'Участие в программе лояльности приостановлено. Напишите менеджеру, чтобы уточнить детали.',
} as const;

/** Проверка права на вращение. Внутри spin() вызывается под блокировкой строки клиента. */
export async function getAvailability(
  db: Executor,
  ctx: Ctx,
  user: User,
  lockedTx: Tx | null = null,
): Promise<SpinAvailability> {
  const settings = await getSettings(db, ctx.config);
  // Считаются только действующие вращения: неиспользованные и не сгоревшие по сроку.
  const grants = await usableGrants(db, user.id);
  const attempts = grants.length;
  const attemptsExpireAt = grants[0]?.expiresAt?.toISOString() ?? null;
  const no = (
    reason: NonNullable<SpinAvailability['reason']>,
    message: string,
    nextAvailableAt: Date | null = null,
  ) =>
    ({
      canSpin: false,
      attempts,
      attemptsExpireAt,
      reason,
      message,
      nextAvailableAt: nextAvailableAt?.toISOString() ?? null,
    }) as const;

  if (user.accountStatus !== 'ACTIVE') return no('BLOCKED', MESSAGES.BLOCKED);
  if (!isConfigValid(await activePrizes(db))) return no('NOT_CONFIGURED', MESSAGES.NOT_CONFIGURED);

  // Под блокировкой (внутри spin) просроченный бонус сразу переводится в EXPIRED;
  // при обычном чтении он просто не считается открытым.
  const open = lockedTx
    ? await findOpenBonus(lockedTx, user.id)
    : await db.query.bonuses.findFirst({
        where: (b, { and, eq, or, isNull, isNotNull, inArray, gt }) =>
          and(
            eq(b.userId, user.id),
            inArray(b.status, ['ACTIVE', 'RESERVED']),
            // Просроченный бонус открытым не считается; исключение — закреплённый за заявкой.
            or(isNull(b.expiresAt), gt(b.expiresAt, new Date()), isNotNull(b.reservedOrderId)),
          ),
      });
  if (open) return no('ACTIVE_BONUS', MESSAGES.ACTIVE_BONUS);

  if (attempts === 0) {
    const how =
      settings.spinGrantTrigger === 'BONUS_ACTIVATED'
        ? 'Новое вращение появится после того, как вы используете бонус в заказе.'
        : 'Новое вращение менеджер начислит после вашего следующего заказа.';
    return no('NO_ATTEMPTS', `Сейчас попыток нет. ${how}`);
  }

  if (settings.spinCooldownHours > 0) {
    const [last] = await db
      .select({ createdAt: spins.createdAt })
      .from(spins)
      .where(eq(spins.userId, user.id))
      .orderBy(desc(spins.createdAt))
      .limit(1);
    if (last) {
      const next = new Date(last.createdAt.getTime() + settings.spinCooldownHours * 3600_000);
      if (next.getTime() > Date.now()) {
        return no('COOLDOWN', 'Между вращениями должен пройти небольшой перерыв. Попробуйте позже.', next);
      }
    }
  }
  return { canSpin: true, attempts, attemptsExpireAt, reason: null, message: null, nextAvailableAt: null };
}

export async function getRouletteState(ctx: Ctx, user: User): Promise<RouletteState> {
  const list = await activePrizes(ctx.db);
  return {
    // Сегменты одинакового размера: вероятности клиенту не раскрываются.
    segments: list.map((p) => ({
      prizeId: p.id,
      name: localizePrize(p, localeOf(user)).name,
      type: p.type,
      value: p.value,
    })),
    availability: await getAvailability(ctx.db, ctx, user),
  };
}

export interface SpinOutcome {
  spinId: string;
  prizeId: string;
  bonus: Bonus;
  replayed: boolean;
}

/**
 * Вращение рулетки. Результат определяется только здесь, на сервере.
 * requestId делает операцию идемпотентной: повтор того же запроса вернёт тот же выигрыш.
 */
export async function spin(
  ctx: Ctx,
  user: User,
  requestId: string,
  roll: () => number = () => randomInt(TOTAL_BP),
) {
  const run = () =>
    ctx.db.transaction(async (tx): Promise<SpinOutcome> => {
      const locked = await lockUser(tx, user.id);

      const [previous] = await tx
        .select()
        .from(spins)
        .where(and(eq(spins.userId, locked.id), eq(spins.requestId, requestId)));
      if (previous) {
        const bonus = await tx.query.bonuses.findFirst({ where: (b, { eq }) => eq(b.id, previous.bonusId) });
        return { spinId: previous.id, prizeId: previous.prizeId, bonus: bonus!, replayed: true };
      }

      const availability = await getAvailability(tx, ctx, locked, tx);
      if (!availability.canSpin) {
        throw availability.reason === 'BLOCKED'
          ? forbidden(availability.message!)
          : new AppError(409, `SPIN_${availability.reason}`, availability.message!);
      }

      const [grant] = await tx
        .select()
        .from(spinGrants)
        .where(usableGrant(locked.id))
        .orderBy(asc(spinGrants.createdAt))
        .limit(1)
        .for('update');
      const list = await activePrizes(tx);
      const rolled = roll();
      const prize = pickPrize(list, rolled);

      const bonus = await issueBonus(tx, ctx.config, {
        user: locked,
        prize,
        source: 'SPIN',
        sourceOrderId: grant!.sourceOrderId,
        actor: { type: 'CLIENT', user: locked },
        reason: 'Выигрыш в рулетке',
        firstOrder: grant!.source === 'WELCOME',
      });
      const [created] = await tx
        .insert(spins)
        .values({
          userId: locked.id,
          grantId: grant!.id,
          bonusId: bonus.id,
          prizeId: prize.id,
          requestId,
          result: {
            prizeName: prize.name,
            type: prize.type,
            value: prize.value,
            probability: prize.probability,
          },
        })
        .returning();
      await tx.update(spinGrants).set({ consumedAt: new Date() }).where(eq(spinGrants.id, grant!.id));
      await logActivity(tx, locked.id, 'SPIN_WON', `Выигрыш в рулетке: ${prize.name}`);
      await notifyUser(
        tx,
        locked,
        'SPIN_WON',
        {
          bonusName: bonus.name,
          bonusCode: bonus.code,
          expiresAt: bonus.expiresAt,
          firstOrder: grant!.source === 'WELCOME',
        },
        `spin:${created!.id}`,
        bonus,
        // Сообщение о выигрыше приходит после остановки колеса, а не пока оно ещё крутится.
        WIN_MESSAGE_DELAY_SECONDS,
      );
      return { spinId: created!.id, prizeId: prize.id, bonus, replayed: false };
    });

  try {
    return await run();
  } catch (err) {
    // Два одинаковых запроса пришли одновременно: второй упёрся в уникальный индекс — отдаём результат первого.
    if (isUniqueViolation(err, 'spins_user_request_uidx')) return run();
    throw err;
  }
}

// ── Настройка призов ─────────────────────────────────────────────────────────

const moneyField = z
  .string()
  .trim()
  .refine(isMoney, 'сумма должна быть числом, например 1500 или 1500.50')
  .nullable();

const prizeText = z.object({
  name: z.string().trim().max(60),
  description: z.string().trim().max(500),
  terms: z.string().trim().max(1000),
});

const prizeSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, 'укажите название').max(60),
    description: z.string().trim().max(500),
    type: z.enum(PRIZE_TYPES),
    value: moneyField,
    probability: z
      .string()
      .refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && toMinor(v) <= TOTAL_BP, 'вероятность — от 0 до 100'),
    isActive: z.boolean(),
    validityDays: z.number().int().min(0).max(3650).nullable(),
    minOrderAmount: moneyField,
    maxDiscountAmount: moneyField,
    rules: z.object({
      rounding: z.enum(ROUNDING_RULES),
      allowedServices: z.array(z.string().trim().min(1).max(60)).max(30),
      stackable: z.boolean(),
      terms: z.string().trim().max(1000),
    }),
    translations: z.object({ en: prizeText.optional(), uk: prizeText.optional() }).default({}),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .superRefine((p, ctx) => {
    if (p.type === 'PRIVILEGE') return;
    if (!p.value || toMinor(p.value) <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `у приза «${p.name}» не задан размер скидки`,
      });
    } else if (p.type === 'PERCENT_DISCOUNT' && toMinor(p.value) > 10_000) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `скидка приза «${p.name}» больше 100%` });
    }
  });

export function toPrizeDto(p: Prize): PrizeDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    type: p.type,
    value: p.value,
    probability: p.probability,
    isActive: p.isActive,
    validityDays: p.validityDays,
    minOrderAmount: p.minimumOrderAmount,
    maxDiscountAmount: p.maximumDiscountAmount,
    rules: p.rules,
    translations: p.translations ?? {},
    sortOrder: p.sortOrder,
  };
}

export function listPrizes(db: Executor): Promise<Prize[]> {
  return db
    .select()
    .from(prizes)
    .where(isNull(prizes.archivedAt))
    .orderBy(asc(prizes.sortOrder), asc(prizes.createdAt));
}

/**
 * Сохраняет конфигурацию рулетки целиком и атомарно. Некорректная конфигурация
 * (сумма вероятностей активных призов ≠ 100%) не сохраняется. Призы, отсутствующие в списке,
 * архивируются, а не удаляются: история выигрышей остаётся целой.
 */
export async function savePrizes(ctx: Ctx, actor: Actor, input: unknown): Promise<Prize[]> {
  requirePermission(actor, 'roulette.manage');
  const list = parse(z.object({ prizes: z.array(prizeSchema).max(24) }), input).prizes;
  const active = list.filter((p) => p.isActive);
  const sum = active.reduce((acc, p) => acc + toBp(p.probability), 0);
  if (active.length < 2)
    throw badRequest('PRIZES_TOO_FEW', 'В рулетке должно быть минимум два активных приза');
  if (sum !== TOTAL_BP) {
    throw badRequest(
      'PROBABILITY_SUM',
      `Сумма вероятностей активных призов должна быть ровно 100%, сейчас ${(sum / 100).toFixed(2)}%`,
    );
  }

  return ctx.db.transaction(async (tx) => {
    const before = await tx.select().from(prizes).where(isNull(prizes.archivedAt)).for('update');
    const beforeIds = new Set(before.map((p) => p.id));
    const keptIds = new Set<string>();
    for (const p of list) {
      const values = {
        name: p.name,
        description: p.description,
        type: p.type,
        value: p.type === 'PRIVILEGE' ? null : p.value,
        probability: p.probability,
        isActive: p.isActive,
        validityDays: p.validityDays,
        minimumOrderAmount: p.minOrderAmount,
        maximumDiscountAmount: p.maxDiscountAmount,
        rules: p.rules,
        translations: p.translations,
        sortOrder: p.sortOrder,
        updatedAt: new Date(),
      };
      if (p.id) {
        if (!beforeIds.has(p.id))
          throw badRequest('PRIZE_UNKNOWN', `Приз «${p.name}» не найден — обновите страницу`);
        await tx.update(prizes).set(values).where(eq(prizes.id, p.id));
        keptIds.add(p.id);
      } else {
        await tx.insert(prizes).values(values);
      }
    }
    for (const old of before) {
      if (!keptIds.has(old.id)) {
        await tx.update(prizes).set({ archivedAt: new Date(), isActive: false }).where(eq(prizes.id, old.id));
      }
    }
    const after = await listPrizes(tx);
    await audit(tx, actor, 'roulette.update', 'prizes', null, {
      before: before.map(toPrizeDto),
      after: after.map(toPrizeDto),
    });
    return after;
  });
}
