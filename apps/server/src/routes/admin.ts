import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminMeDto } from '../contract/api.ts';
import type { Permission } from '../contract/constants.ts';
import { badRequest, conflict, forbidden, notFound, parse, unauthorized } from '../lib/errors.ts';
import * as admin from '../services/admin.ts';
import * as broadcasts from '../services/broadcasts.ts';
import {
  activateBonus,
  cancelBonus,
  correctBonus,
  grantBonusManually,
  returnBonus,
} from '../services/bonuses.ts';
import { requirePermission } from '../services/common.ts';
import type { Ctx } from '../services/common.ts';
import * as orders from '../services/orders.ts';
import { listPrizes, savePrizes, toPrizeDto } from '../services/roulette.ts';
import { getSettings, updateSettings } from '../services/settings.ts';
import * as spins from '../services/spins.ts';
import { signSession, verifyLoginWidget } from '../telegram/auth.ts';
import type { TelegramClient } from '../telegram/client.ts';
import { authStaff, isActiveStaff, SESSION_COOKIE, SESSION_TTL_SECONDS } from './auth.ts';

type IdParams = { Params: { id: string } };

export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx, telegram: TelegramClient) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  const staffWith = async (req: FastifyRequest, permission?: Permission) => {
    const actor = await authStaff(ctx, req);
    if (permission) requirePermission(actor, permission);
    return actor;
  };

  // ── Вход из браузера через Telegram Login Widget ──
  app.post(
    '/api/admin/auth/widget',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const data = parse(z.record(z.string(), z.union([z.string(), z.number()])), req.body);
      const tg = verifyLoginWidget(data, ctx.config.BOT_TOKEN, 24 * 60 * 60);
      if (!tg) throw unauthorized('Не удалось подтвердить вход через Telegram');
      if (!(await isActiveStaff(ctx, tg.id))) throw forbidden('У вас нет доступа к админ-панели');
      reply.setCookie(SESSION_COOKIE, signSession(tg.id, ctx.config.SESSION_SECRET, SESSION_TTL_SECONDS), {
        httpOnly: true,
        secure: ctx.config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/admin',
        maxAge: SESSION_TTL_SECONDS,
      });
      return { ok: true };
    },
  );

  app.post('/api/admin/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/api/admin' });
    return { ok: true };
  });

  app.get('/api/admin/me', async (req): Promise<AdminMeDto> => {
    const actor = await staffWith(req);
    return {
      staff: admin.toStaffDto(actor.staff),
      settings: await getSettings(ctx.db, ctx.config),
      botUsername: ctx.config.BOT_USERNAME ?? null,
    };
  });

  app.get('/api/admin/dashboard', async (req) => admin.getDashboard(ctx, await staffWith(req), req.query));
  app.get('/api/admin/stats', async (req) => admin.getStats(ctx, await staffWith(req), req.query));

  // ── Клиенты ──
  app.get('/api/admin/clients', async (req) => admin.listClients(ctx, await staffWith(req), req.query));
  app.get<IdParams>('/api/admin/clients/:id', async (req) =>
    admin.getClientCard(ctx, await staffWith(req), req.params.id),
  );
  app.post<IdParams>('/api/admin/clients/:id/status', async (req) => {
    const actor = await staffWith(req);
    await admin.setClientStatus(ctx, actor, req.params.id, req.body);
    return admin.getClientCard(ctx, actor, req.params.id);
  });
  // ── Вращения: поиск клиента по @username или Telegram ID и начисление одного вращения ──
  app.get('/api/admin/spins/lookup', async (req) => spins.lookupClient(ctx, await staffWith(req), req.query));
  app.post('/api/admin/spins/grant', async (req) => spins.grantSpin(ctx, await staffWith(req), req.body));

  // ── Заказы ──
  app.get('/api/admin/orders', async (req) => admin.listOrders(ctx, await staffWith(req), req.query));
  app.get<IdParams>('/api/admin/orders/:id', async (req) =>
    admin.getOrderCard(ctx, await staffWith(req), req.params.id),
  );
  app.post('/api/admin/orders', async (req, reply) => {
    const actor = await staffWith(req, 'orders.create');
    const { userId, ...input } = parse(z.object({ userId: z.uuid() }).loose(), req.body);
    const created = await orders.createOrder(ctx, userId, input, actor);
    return reply
      .status(created.replayed ? 200 : 201)
      .send(await admin.getOrderCard(ctx, actor, created.order.id));
  });

  const orderAction = (
    path: string,
    run: (actor: Awaited<ReturnType<typeof authStaff>>, id: string, body: unknown) => Promise<unknown>,
  ) =>
    app.post<IdParams>(`/api/admin/orders/:id/${path}`, async (req) => {
      const actor = await staffWith(req, 'orders.view');
      if (!z.uuid().safeParse(req.params.id).success) throw notFound('Заказ не найден');
      await run(actor, req.params.id, req.body);
      return admin.getOrderCard(ctx, actor, req.params.id);
    });

  orderAction('status', (actor, id, body) => orders.changeOrderStatus(ctx, actor, id, body));
  orderAction('price', (actor, id, body) => orders.setOrderPrice(ctx, actor, id, body));
  orderAction('assign', (actor, id, body) => orders.assignOrder(ctx, actor, id, body));
  orderAction('confirm-payment', (actor, id, body) => orders.confirmPayment(ctx, actor, id, body));
  orderAction('redeem-bonus', (actor, id) => orders.redeemOrderBonus(ctx, actor, id));
  orderAction('cancel', (actor, id, body) => orders.cancelOrder(ctx, actor, id, body));
  orderAction('release-bonus', (actor, id, body) => orders.releaseOrderBonus(ctx, actor, id, body));
  orderAction('attach-bonus', (actor, id) => orders.attachBonusToOrder(ctx, actor, id));

  // ── Бонусы ──
  app.get('/api/admin/bonuses', async (req) => admin.listBonuses(ctx, await staffWith(req), req.query));
  app.get<IdParams>('/api/admin/bonuses/:id', async (req) =>
    admin.getBonusCard(ctx, await staffWith(req), req.params.id),
  );
  app.post('/api/admin/bonuses/grant', async (req, reply) => {
    const actor = await staffWith(req);
    const bonus = await grantBonusManually(ctx, actor, req.body);
    return reply.status(201).send(await admin.getBonusCard(ctx, actor, bonus.id));
  });
  app.post<IdParams>('/api/admin/bonuses/:id/activate', async (req) => {
    const actor = await staffWith(req, 'bonuses.view');
    if (!z.uuid().safeParse(req.params.id).success) throw notFound('Бонус не найден');
    const result = await activateBonus(ctx, actor, req.params.id);
    if (result.bonus.status === 'EXPIRED')
      throw conflict('BONUS_EXPIRED', 'Срок действия бонуса истёк — активировать его нельзя');
    return admin.getBonusCard(ctx, actor, req.params.id);
  });
  app.post<IdParams>('/api/admin/bonuses/:id/return', async (req) => {
    const actor = await staffWith(req, 'bonuses.view');
    if (!z.uuid().safeParse(req.params.id).success) throw notFound('Бонус не найден');
    await returnBonus(ctx, actor, req.params.id, req.body);
    return admin.getBonusCard(ctx, actor, req.params.id);
  });
  app.post<IdParams>('/api/admin/bonuses/:id/cancel', async (req) => {
    const actor = await staffWith(req, 'bonuses.view');
    if (!z.uuid().safeParse(req.params.id).success) throw notFound('Бонус не найден');
    await cancelBonus(ctx, actor, req.params.id, req.body);
    return admin.getBonusCard(ctx, actor, req.params.id);
  });
  app.post<IdParams>('/api/admin/bonuses/:id/correct', async (req) => {
    const actor = await staffWith(req, 'bonuses.view');
    if (!z.uuid().safeParse(req.params.id).success) throw notFound('Бонус не найден');
    await correctBonus(ctx, actor, req.params.id, req.body);
    return admin.getBonusCard(ctx, actor, req.params.id);
  });

  // ── Рулетка ──
  app.get('/api/admin/prizes', async (req) => {
    const actor = await staffWith(req);
    // Список призов нужен и для ручной выдачи бонуса.
    if (!actor.permissions.has('roulette.manage')) requirePermission(actor, 'bonuses.grant');
    return { items: (await listPrizes(ctx.db)).map(toPrizeDto) };
  });
  app.put('/api/admin/prizes', async (req) => ({
    items: (await savePrizes(ctx, await staffWith(req), req.body)).map(toPrizeDto),
  }));

  // ── Рассылки ──
  app.get('/api/admin/broadcasts', async (req) => {
    const actor = await staffWith(req);
    return {
      items: await broadcasts.listBroadcasts(ctx, actor),
      audience: await broadcasts.getAudience(ctx, actor),
    };
  });
  app.post('/api/admin/broadcasts/test', async (req) => {
    await broadcasts.sendTest(ctx, telegram, await staffWith(req), req.body);
    return { ok: true };
  });
  app.post('/api/admin/broadcasts', async (req, reply) =>
    reply.status(201).send(await broadcasts.createBroadcast(ctx, await staffWith(req), req.body)),
  );
  app.post<IdParams>('/api/admin/broadcasts/:id/cancel', async (req) =>
    broadcasts.cancelBroadcast(ctx, await staffWith(req), req.params.id),
  );
  // Файл приходит телом запроса как есть (application/octet-stream), вид — в параметре kind.
  app.post<{ Querystring: { kind?: string; name?: string } }>(
    '/api/admin/broadcasts/media',
    { bodyLimit: 21 * 1024 * 1024 },
    async (req) => {
      const actor = await staffWith(req);
      if (!Buffer.isBuffer(req.body)) throw badRequest('BODY', 'Файл не получен');
      return broadcasts.uploadMedia(
        ctx,
        telegram,
        actor,
        req.query.kind ?? '',
        req.body,
        req.query.name ?? 'file',
      );
    },
  );

  // ── Настройки, сотрудники, аудит ──
  app.put('/api/admin/settings', async (req) =>
    updateSettings(ctx.db, ctx.config, await staffWith(req), req.body),
  );
  app.get('/api/admin/staff', async (req) => ({ items: await admin.listStaff(ctx, await staffWith(req)) }));
  app.post('/api/admin/staff', async (req, reply) =>
    reply.status(201).send(await admin.createStaff(ctx, await staffWith(req), req.body)),
  );
  app.patch<IdParams>('/api/admin/staff/:id', async (req) =>
    admin.updateStaff(ctx, await staffWith(req), req.params.id, req.body),
  );
  app.get('/api/admin/audit', async (req) => admin.listAudit(ctx, await staffWith(req), req.query));

  // ── Экспорт ──
  app.get<{ Params: { table: string } }>('/api/admin/export/:table', async (req, reply) => {
    const actor = await staffWith(req);
    const table = req.params.table.replace(/\.csv$/, '');
    const csv = await admin.exportCsv(ctx, actor, table, req.query);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${table}-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .send(csv);
  });
}
