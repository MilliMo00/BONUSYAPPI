import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { enqueueExpiryReminders, expireDueBonuses } from './services/bonuses.ts';
import { processBroadcasts } from './services/broadcasts.ts';
import { enqueueSpinReminders } from './services/spins.ts';
import { processNotifications } from './services/notifications.ts';
import { startPolling } from './telegram/bot.ts';
import { createTelegramClient } from './telegram/client.ts';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const telegram = createTelegramClient(config.BOT_TOKEN, config.TELEGRAM_API_BASE);
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

const app = await buildApp({ config, db, telegram, webDist });
const ctx = { db, config };
const log = app.log;

/** Запускает задачу по таймеру; следующий запуск начинается только после завершения предыдущего. */
function every(ms: number, name: string, task: () => Promise<unknown>): () => void {
  let timer: NodeJS.Timeout;
  let stopped = false;
  const tick = async () => {
    try {
      await task();
    } catch (err) {
      log.error({ err, job: name }, 'Ошибка фоновой задачи');
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const stoppers = [
  every(3_000, 'notifications', () =>
    processNotifications(db, config, telegram, (err, id) =>
      log.warn({ err: (err as Error).message, notificationId: id }, 'Уведомление не отправлено'),
    ),
  ),
  // Рассылки: порция раз в секунду укладывается в лимит Telegram.
  every(1_000, 'broadcasts', () => processBroadcasts(ctx, telegram)),
  every(5 * 60_000, 'expire-bonuses', () => expireDueBonuses(db)),
  every(60 * 60_000, 'expiry-reminders', () => enqueueExpiryReminders(ctx)),
  // Раз в 15 минут: напоминание приходит близко к выбранному в настройках сроку.
  every(15 * 60_000, 'spin-reminders', () => enqueueSpinReminders(ctx)),
];
if (config.TELEGRAM_UPDATES_MODE === 'polling') stoppers.push(startPolling(ctx, telegram, log));

async function shutdown(signal: string) {
  log.info({ signal }, 'Останавливаемся');
  stoppers.forEach((stop) => stop());
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
