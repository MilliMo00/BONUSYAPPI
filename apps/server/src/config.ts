import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  APP_URL: optional,
  BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/, 'BOT_TOKEN должен быть токеном от @BotFather'),
  BOT_USERNAME: optional,
  TELEGRAM_UPDATES_MODE: z.enum(['webhook', 'polling', 'off']).default('off'),
  TELEGRAM_WEBHOOK_SECRET: optional,
  TELEGRAM_API_BASE: z.string().default('https://api.telegram.org'),
  TEAM_CHAT_ID: optional,
  INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86400),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET должен быть не короче 32 символов'),
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Некорректные переменные окружения:\n${lines.join('\n')}`);
  }
  const config = parsed.data;
  if (config.TELEGRAM_UPDATES_MODE === 'webhook') {
    if (!config.APP_URL?.startsWith('https://'))
      throw new Error('Для режима webhook нужен APP_URL с https://');
    if (!config.TELEGRAM_WEBHOOK_SECRET || config.TELEGRAM_WEBHOOK_SECRET.length < 32) {
      throw new Error('Для режима webhook нужен TELEGRAM_WEBHOOK_SECRET (32+ символов)');
    }
  }
  return config;
}
