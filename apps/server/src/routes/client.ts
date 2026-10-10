import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActivityDto, HomeDto, MeDto, RouletteState, SpinResult } from '../contract/api.ts';
import { LOCALES } from '../contract/constants.ts';
import { bonuses, orders, userActivity, users } from '../db/schema.ts';
import type { User } from '../db/schema.ts';
import { conflict, notFound, parse } from '../lib/errors.ts';
import { toActivityDto } from '../services/admin.ts';
import { applyBonus } from '../services/bonuses.ts';
import type { Ctx } from '../services/common.ts';
import { bonusesOfUser, ordersOfUser, toBonusDto } from '../services/dto.ts';
import { createOrder } from '../services/orders.ts';
import { getAvailability, getRouletteState, spin } from '../services/roulette.ts';
import { localeOf } from '../services/i18n.ts';
import { getSettings } from '../services/settings.ts';
import { applyChatLocale } from '../telegram/bot.ts';
import type { TelegramClient } from '../telegram/client.ts';
import { authClient, isActiveStaff } from './auth.ts';

const idParam = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound();
  return id;
};

async function buildMe(ctx: Ctx, user: User): Promise<MeDto> {
  const [o] = await ctx.db.select({ n: count() }).from(orders).where(eq(orders.userId, user.id));
  const [b] = await ctx.db
    .select({ n: count() })
    .from(bonuses)
    .where(and(eq(bonuses.userId, user.id), eq(bonuses.status, 'REDEEMED')));
  return {
    id: user.id,
    telegramId: user.telegramId,
    username: user.username,
    displayName: user.displayName,
    locale: localeOf(user),
    localeChosen: user.locale !== null,
    botStarted: user.botStartedAt !== null && user.botBlockedAt === null,
    createdAt: user.createdAt.toISOString(),
    ordersCount: o?.n ?? 0,
    redeemedBonusesCount: b?.n ?? 0,
    isStaff: await isActiveStaff(ctx, user.telegramId),
  };
}

export function registerClientRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  telegram: TelegramClient,
  limits: { spin: number; order: number },
) {
  // Ограничение частоты считается по подписанным данным входа, а не только по IP.
  const perUser = (max: number) => ({
    rateLimit: {
      max,
      timeWindow: '1 minute',
      keyGenerator: (req: { headers: { authorization?: string }; ip: string }) =>
        req.headers.authorization?.slice(-64) ?? req.ip,
    },
  });

  app.get('/api/home', async (req): Promise<HomeDto> => {
    const user = await authClient(ctx, req);
    const settings = await getSettings(ctx.db, ctx.config);
    const availability = await getAvailability(ctx.db, ctx, user);
    const open = (await bonusesOfUser(ctx.db, user.id, localeOf(user))).filter(
      (b) =>
        b.status === 'RESERVED' ||
        (b.status === 'ACTIVE' && (!b.expiresAt || new Date(b.expiresAt) > new Date())),
    );
    const [lastOrder] = await ordersOfUser(ctx.db, user.id);
    return {
      me: await buildMe(ctx, user),
      activeBonus: open[0] ?? null,
      activeBonusesCount: open.length,
      availability,
      lastOrder: lastOrder ?? null,
      settings: {
        brandName: settings.brandName,
        managerContactUrl: settings.managerContactUrl,
        services: settings.services,
        statusLabels: settings.statusLabels,
        currency: settings.currency,
        spinGrantTrigger: settings.spinGrantTrigger,
      },
    };
  });

  // Смена языка из приложения: интерфейс, сообщения бота и кнопка меню переключаются вместе.
  app.put('/api/me/locale', async (req) => {
    const user = await authClient(ctx, req);
    const { locale } = parse(z.object({ locale: z.enum(LOCALES) }), req.body);
    await ctx.db.update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, user.id));
    // Настройка кнопки меню — не критична: ошибка Telegram не мешает сменить язык.
    await applyChatLocale(ctx, telegram, user.telegramId, locale).catch(() => {});
    return { locale };
  });

  // Клиент открыл приложение, не заходя в чат с ботом, и разрешил боту писать ему
  // (запрос показывает сам Telegram). Без этого уведомления и рассылки до него не дойдут.
  app.post('/api/me/bot-access', async (req) => {
    const user = await authClient(ctx, req);
    await ctx.db
      .update(users)
      .set({ botStartedAt: user.botStartedAt ?? new Date(), botBlockedAt: null })
      .where(eq(users.id, user.id));
    await applyChatLocale(ctx, telegram, user.telegramId, localeOf(user)).catch(() => {});
    return { ok: true };
  });

  app.get('/api/roulette', async (req): Promise<RouletteState> =>
    getRouletteState(ctx, await authClient(ctx, req)),
  );

  app.post('/api/roulette/spin', { config: perUser(limits.spin) }, async (req): Promise<SpinResult> => {
    const user = await authClient(ctx, req);
    const { requestId } = parse(z.object({ requestId: z.uuid() }), req.body);
    const outcome = await spin(ctx, user, requestId);
    return {
      spinId: outcome.spinId,
      prizeId: outcome.prizeId,
      bonus: toBonusDto(outcome.bonus, undefined, localeOf(user)),
      replayed: outcome.replayed,
    };
  });

  app.get('/api/bonuses', async (req) => {
    const user = await authClient(ctx, req);
    return { items: await bonusesOfUser(ctx.db, user.id, localeOf(user)) };
  });

  app.get<{ Params: { id: string } }>('/api/bonuses/:id', async (req) => {
    const user = await authClient(ctx, req);
    // Фильтр по владельцу — в самом запросе: чужой бонус неотличим от несуществующего.
    const [bonus] = await bonusesOfUser(ctx.db, user.id, localeOf(user), idParam(req.params.id));
    if (!bonus) throw notFound('Бонус не найден');
    return bonus;
  });

  // «Применить бонус»: бонус уходит сотрудникам на активацию. Повторное нажатие безопасно.
  app.post<{ Params: { id: string } }>(
    '/api/bonuses/:id/apply',
    { config: perUser(limits.order) },
    async (req) => {
      const user = await authClient(ctx, req);
      const applied = await applyBonus(ctx, user, idParam(req.params.id));
      if (applied.status === 'EXPIRED') throw conflict('BONUS_EXPIRED', 'Срок действия бонуса истёк');
      const [bonus] = await bonusesOfUser(ctx.db, user.id, localeOf(user), applied.id);
      return bonus;
    },
  );

  app.get('/api/orders', async (req) => {
    const user = await authClient(ctx, req);
    return { items: await ordersOfUser(ctx.db, user.id) };
  });

  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req) => {
    const user = await authClient(ctx, req);
    const [order] = await ordersOfUser(ctx.db, user.id, idParam(req.params.id));
    if (!order) throw notFound('Заказ не найден');
    return order;
  });

  app.post('/api/orders', { config: perUser(limits.order) }, async (req, reply) => {
    const user = await authClient(ctx, req);
    const created = await createOrder(ctx, user.id, req.body, { type: 'CLIENT', user });
    const [order] = await ordersOfUser(ctx.db, user.id, created.order.id);
    return reply.status(created.replayed ? 200 : 201).send(order);
  });

  app.get('/api/activity', async (req): Promise<{ items: ActivityDto[] }> => {
    const user = await authClient(ctx, req);
    const rows = await ctx.db
      .select()
      .from(userActivity)
      .where(eq(userActivity.userId, user.id))
      .orderBy(desc(userActivity.createdAt))
      .limit(50);
    return { items: rows.map(toActivityDto) };
  });
}
