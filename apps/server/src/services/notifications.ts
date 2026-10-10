import { and, eq, lte, sql } from 'drizzle-orm';
import { effectivePermissions } from '../contract/constants.ts';
import type { Permission } from '../contract/constants.ts';
import type { Config } from '../config.ts';
import type { Db, Executor } from '../db/client.ts';
import { notifications, staff, users } from '../db/schema.ts';
import type { User } from '../db/schema.ts';
import { TelegramError } from '../telegram/client.ts';
import type { TelegramClient } from '../telegram/client.ts';
import { localeOf, localizePrize } from './i18n.ts';
import { getSettings } from './settings.ts';
import { render } from './templates.ts';

const MAX_ATTEMPTS = 8;

/**
 * Ставит уведомление в очередь внутри бизнес-транзакции. Отправка происходит позже и отдельно:
 * сбой Telegram не откатывает заказ или бонус. dedupeKey исключает повторную постановку.
 */
export async function notifyUser(
  tx: Executor,
  user: Pick<User, 'telegramId' | 'locale' | 'languageCode'>,
  type: string,
  payload: Record<string, unknown>,
  dedupeKey: string,
  /** Бонус, о котором идёт речь: его название подставится на языке клиента */
  bonus?: Parameters<typeof localizePrize>[0],
  /** Отправить не раньше чем через столько секунд */
  delaySeconds = 0,
): Promise<void> {
  const locale = localeOf(user);
  await tx
    .insert(notifications)
    .values({
      recipientType: 'USER',
      recipientId: String(user.telegramId),
      notificationType: type,
      payload: {
        ...payload,
        ...(bonus ? { bonusName: localizePrize(bonus, locale).name } : {}),
        _locale: locale,
      },
      dedupeKey,
      nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
    })
    .onConflictDoNothing();
}

/** Уведомление команде: в рабочий чат, а если он не настроен — лично сотрудникам с доступом к заказам. */
export async function notifyTeam(
  tx: Executor,
  config: Config,
  type: string,
  payload: Record<string, unknown>,
  dedupeKey: string,
): Promise<void> {
  const settings = await getSettings(tx, config);
  const chatId = settings.teamChatId || config.TEAM_CHAT_ID;
  if (chatId) {
    await tx
      .insert(notifications)
      .values({ recipientType: 'TEAM_CHAT', recipientId: chatId, notificationType: type, payload, dedupeKey })
      .onConflictDoNothing();
    return;
  }
  const members = await tx.select().from(staff).where(eq(staff.isActive, true));
  const recipients = members.filter((m) =>
    effectivePermissions(m.role, m.permissions).includes('orders.view'),
  );
  if (recipients.length === 0) return;
  await tx
    .insert(notifications)
    .values(
      recipients.map((m) => ({
        recipientType: 'STAFF' as const,
        recipientId: String(m.telegramId),
        notificationType: type,
        payload,
        dedupeKey: `${dedupeKey}:${m.id}`,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Личное уведомление каждому активному сотруднику с указанным правом
 * (например, владельцу и тимлиду — о бонусе, который ждёт активации).
 */
export async function notifyStaffWith(
  tx: Executor,
  permission: Permission,
  type: string,
  payload: Record<string, unknown>,
  dedupeKey: string,
): Promise<number> {
  const members = await tx.select().from(staff).where(eq(staff.isActive, true));
  const recipients = members.filter((m) => effectivePermissions(m.role, m.permissions).includes(permission));
  if (recipients.length === 0) return 0;
  await tx
    .insert(notifications)
    .values(
      recipients.map((m) => ({
        recipientType: 'STAFF' as const,
        recipientId: String(m.telegramId),
        notificationType: type,
        payload,
        dedupeKey: `${dedupeKey}:${m.id}`,
      })),
    )
    .onConflictDoNothing();
  return recipients.length;
}

/**
 * Отправляет порцию уведомлений из очереди. Строки берутся с FOR UPDATE SKIP LOCKED,
 * поэтому несколько воркеров не отправят одно сообщение дважды.
 * Возвращает количество обработанных записей.
 */
export async function processNotifications(
  db: Db,
  config: Config,
  telegram: TelegramClient,
  onError: (err: unknown, id: string) => void = () => {},
  limit = 10,
): Promise<number> {
  return db.transaction(async (tx) => {
    const batch = await tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.status, 'PENDING'), lte(notifications.nextAttemptAt, sql`now()`)))
      .orderBy(notifications.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    for (const n of batch) {
      try {
        const message = render(n.notificationType, n.recipientType, n.payload, config);
        await telegram.sendMessage(n.recipientId, message.html, { buttons: message.buttons });
        await tx
          .update(notifications)
          .set({ status: 'SENT', sentAt: new Date(), attempts: n.attempts + 1, lastError: null })
          .where(eq(notifications.id, n.id));
      } catch (err) {
        onError(err, n.id);
        const attempts = n.attempts + 1;
        const permanent = err instanceof TelegramError ? err.permanent : false;
        // Клиент заблокировал бота: помечаем, чтобы рассылки и уведомления больше ему не уходили.
        if (err instanceof TelegramError && err.code === 403 && n.recipientType === 'USER') {
          await tx
            .update(users)
            .set({ botBlockedAt: new Date() })
            .where(eq(users.telegramId, Number(n.recipientId)));
        }
        const failed = permanent || attempts >= MAX_ATTEMPTS;
        const retryAfter = err instanceof TelegramError && err.retryAfter ? err.retryAfter : 0;
        const delaySeconds = Math.max(retryAfter, Math.min(30 * 2 ** (attempts - 1), 3600));
        await tx
          .update(notifications)
          .set({
            status: failed ? 'FAILED' : 'PENDING',
            attempts,
            lastError: String((err as Error)?.message ?? err).slice(0, 500),
            nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
          })
          .where(eq(notifications.id, n.id));
      }
    }
    return batch.length;
  });
}
