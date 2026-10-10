import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { effectivePermissions } from '../contract/constants.ts';
import { staff } from '../db/schema.ts';
import type { User } from '../db/schema.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import type { Actor, Ctx } from '../services/common.ts';
import { upsertUserFromTelegram } from '../services/users.ts';
import { verifyInitData, verifySession } from '../telegram/auth.ts';
import type { TelegramUser } from '../telegram/auth.ts';

export const SESSION_COOKIE = 'yappi_admin';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Достаёт подтверждённого пользователя Telegram из заголовка `Authorization: tma <initData>`. */
function telegramUserFromHeader(ctx: Ctx, req: FastifyRequest): TelegramUser | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('tma ')) return null;
  return verifyInitData(header.slice(4), ctx.config.BOT_TOKEN, ctx.config.INIT_DATA_MAX_AGE_SECONDS);
}

/**
 * Клиент определяется только по подписанным данным Telegram.
 * Идентификаторы пользователя из тела или параметров запроса не принимаются нигде.
 */
export async function authClient(ctx: Ctx, req: FastifyRequest): Promise<User> {
  const tg = telegramUserFromHeader(ctx, req);
  if (!tg) throw unauthorized('Откройте приложение через Telegram — данные входа не подтверждены');
  return upsertUserFromTelegram(ctx.db, ctx.config, tg);
}

export type StaffActor = Extract<Actor, { type: 'STAFF' }>;

/**
 * Сотрудник: подписанный initData (админка внутри Telegram) или подписанная cookie (браузер).
 * Роль и права каждый раз читаются из БД, поэтому отзыв доступа действует сразу.
 */
export async function authStaff(ctx: Ctx, req: FastifyRequest): Promise<StaffActor> {
  const telegramId =
    telegramUserFromHeader(ctx, req)?.id ??
    verifySession(req.cookies[SESSION_COOKIE], ctx.config.SESSION_SECRET);
  if (!telegramId) throw unauthorized();
  const [member] = await ctx.db.select().from(staff).where(eq(staff.telegramId, telegramId));
  if (!member?.isActive) throw forbidden('У вас нет доступа к админ-панели');
  return {
    type: 'STAFF',
    staff: member,
    permissions: new Set(effectivePermissions(member.role, member.permissions)),
  };
}

export async function isActiveStaff(ctx: Ctx, telegramId: number): Promise<boolean> {
  const [member] = await ctx.db
    .select({ isActive: staff.isActive })
    .from(staff)
    .where(eq(staff.telegramId, telegramId));
  return member?.isActive === true;
}
