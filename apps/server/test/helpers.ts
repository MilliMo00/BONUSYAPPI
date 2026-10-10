import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { RateLimits } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { PrizeRules } from '../src/contract/api.ts';
import type { Permission, Role } from '../src/contract/constants.ts';
import { createDb } from '../src/db/client.ts';
import type { Db } from '../src/db/client.ts';
import { prizes, staff } from '../src/db/schema.ts';
import type { Ctx } from '../src/services/common.ts';
import { signInitData } from '../src/telegram/auth.ts';
import { TelegramError } from '../src/telegram/client.ts';
import type { SendMessageOptions, TelegramClient } from '../src/telegram/client.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/yappibot_test';
export const BOT_TOKEN = '1234567890:TEST-token-for-automated-tests-only-000';

export interface SentMessage {
  chatId: string;
  html: string;
  buttons?: { text: string; callback_data?: string; url?: string }[][];
}

/** Подмена внешнего Telegram Bot API: записывает отправленное и умеет имитировать сбои. */
export class FakeTelegram implements TelegramClient {
  sent: SentMessage[] = [];
  failWith: Error | null = null;

  calls: { method: string; body: Record<string, unknown> }[] = [];

  /** Сбой для конкретного чата (например, клиент заблокировал бота) */
  failFor = new Map<string, Error>();
  uploads: { method: string; fields: Record<string, string>; fileBytes: number }[] = [];

  async upload<T>(method: string, form: FormData): Promise<T> {
    const fields: Record<string, string> = {};
    let fileBytes = 0;
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') fields[k] = v;
      else fileBytes = v.size;
    }
    this.uploads.push({ method, fields, fileBytes });
    return (
      method === 'sendPhoto'
        ? { photo: [{ file_id: 'small-photo-id-000' }, { file_id: 'big-photo-file-id-0001' }] }
        : { voice: { file_id: 'voice-file-id-0001' } }
    ) as T;
  }

  async sendMessage(chatId: string | number, html: string, options?: SendMessageOptions): Promise<void> {
    if (this.failWith) throw this.failWith;
    const failure = this.failFor.get(String(chatId));
    if (failure) throw failure;
    this.sent.push({ chatId: String(chatId), html, buttons: options?.buttons });
  }
  async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, body });
    const failure = this.failFor.get(String(body.chat_id));
    if (failure && method.startsWith('send')) throw failure;
    return undefined as T;
  }
  failTemporarily() {
    this.failWith = new TelegramError(502, 'Bad Gateway');
  }
}

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  ctx: Ctx;
  config: Config;
  telegram: FakeTelegram;
  close: () => Promise<void>;
}

export async function createTestEnv(
  overrides: Partial<NodeJS.ProcessEnv> = {},
  rateLimits: Partial<RateLimits> = { global: 100_000, spin: 100_000, order: 100_000 },
): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    BOT_TOKEN,
    BOT_USERNAME: 'test_loyalty_bot',
    APP_URL: 'https://app.example.test',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef-0123456789',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-0123456789abcdef',
    ...overrides,
  });
  const { db, pool } = createDb(config.DATABASE_URL);
  const telegram = new FakeTelegram();
  const app = await buildApp({ config, db, telegram, rateLimits });
  return {
    app,
    db,
    ctx: { db, config },
    config,
    telegram,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE users, staff, orders, prizes, bonuses, spin_grants, spins, payments,
    order_status_history, bonus_history, audit_logs, user_activity, notifications, settings,
    broadcasts, broadcast_recipients RESTART IDENTITY CASCADE`);
}

const rules: PrizeRules = { rounding: 'ROUND_UNIT', allowedServices: [], stackable: false, terms: '' };

/** Стартовый набор призов из ТЗ. */
export async function seedPrizes(db: Db) {
  return db
    .insert(prizes)
    .values([
      { name: 'Скидка 10%', type: 'PERCENT_DISCOUNT', value: '10', probability: '35', sortOrder: 0, rules },
      { name: 'Бесплатная правка', type: 'PRIVILEGE', value: null, probability: '25', sortOrder: 1, rules },
      { name: 'Скидка 15%', type: 'PERCENT_DISCOUNT', value: '15', probability: '20', sortOrder: 2, rules },
      { name: 'Приоритет в очереди', type: 'PRIVILEGE', value: null, probability: '15', sortOrder: 3, rules },
      { name: 'Скидка 25%', type: 'PERCENT_DISCOUNT', value: '25', probability: '5', sortOrder: 4, rules },
    ])
    .returning();
}

/** Заголовок входа: initData, подписанный так же, как это делает Telegram. */
export function tma(telegramId: number, name = `User ${telegramId}`, username?: string) {
  return { authorization: `tma ${signInitData({ id: telegramId, first_name: name, username }, BOT_TOKEN)}` };
}

export async function addStaff(
  db: Db,
  telegramId: number,
  role: Role,
  grant: Permission[] = [],
  revoke: Permission[] = [],
) {
  const [row] = await db
    .insert(staff)
    .values({ telegramId, displayName: `${role} ${telegramId}`, role, permissions: { grant, revoke } })
    .returning();
  return row!;
}

export const uuid = () => randomUUID();

export interface Call {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
): Promise<Call> {
  const res = await app.inject({ method, url, headers, payload: payload as object | undefined });
  let body: unknown = res.body;
  try {
    body = res.json();
  } catch {
    /* не JSON (например, CSV) */
  }
  return { status: res.statusCode, body };
}

export const orderInput = (extra: Record<string, unknown> = {}) => ({
  requestId: uuid(),
  serviceType: 'Баннер',
  description: 'Баннер для рекламной кампании',
  useBonus: false,
  ...extra,
});
