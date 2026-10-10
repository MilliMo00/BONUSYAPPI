import { sql } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { User } from '../db/schema.ts';
import type { TelegramUser } from '../telegram/auth.ts';
import { logActivity } from './common.ts';
import { getSettings } from './settings.ts';
import { createSpinGrant } from './spins.ts';

export function displayNameOf(tg: TelegramUser): string {
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim();
  return (name || tg.username || `Клиент ${tg.id}`).slice(0, 120);
}

/**
 * Находит клиента по подтверждённому Telegram ID либо создаёт профиль при первом входе.
 * Username и имя обновляются при каждом входе — ключом остаётся только Telegram ID.
 */
export async function upsertUserFromTelegram(db: Db, config: Config, tg: TelegramUser): Promise<User> {
  return db.transaction(async (tx) => {
    const displayName = displayNameOf(tg);
    const username = tg.username ?? null;
    const [row] = await tx
      .insert(users)
      .values({ telegramId: tg.id, username, displayName, languageCode: tg.language_code ?? null })
      .onConflictDoUpdate({
        target: users.telegramId,
        set: { username, displayName, lastActiveAt: new Date(), updatedAt: new Date() },
      })
      // xmax = 0 только у только что вставленной строки: так отличаем первый вход от повторного.
      .returning({ id: users.id, inserted: sql<boolean>`(xmax = 0)` });
    const user = (await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, row!.id) }))!;

    if (row!.inserted) {
      await logActivity(tx, user.id, 'REGISTERED', 'Регистрация в программе лояльности');
      const { welcomeSpins } = await getSettings(tx, config);
      for (let i = 0; i < welcomeSpins; i++) {
        await createSpinGrant(tx, config, { userId: user.id, source: 'WELCOME' });
      }
    }
    return user;
  });
}
