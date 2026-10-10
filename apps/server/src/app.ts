import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ApiError, PublicConfig } from './contract/api.ts';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { AppError } from './lib/errors.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerClientRoutes } from './routes/client.ts';
import type { Ctx } from './services/common.ts';
import { getSettings } from './services/settings.ts';
import { handleUpdate } from './telegram/bot.ts';
import type { TelegramClient, TelegramUpdate } from './telegram/client.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  telegram: TelegramClient;
  /** Папка с собранным веб-клиентом; если её нет, сервер отдаёт только API */
  webDist?: string;
  /** Лимиты запросов в минуту; по умолчанию — DEFAULT_RATE_LIMITS */
  rateLimits?: Partial<RateLimits>;
}

export interface RateLimits {
  /** Все запросы к API с одного IP */
  global: number;
  /** Вращения рулетки одного клиента */
  spin: number;
  /** Создание заявок одним клиентом */
  order: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { global: 240, spin: 10, order: 10 };

export async function buildApp({
  config,
  db,
  telegram,
  webDist,
  rateLimits,
}: AppDeps): Promise<FastifyInstance> {
  const limits = { ...DEFAULT_RATE_LIMITS, ...rateLimits };
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Данные входа и cookie не попадают в логи.
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-telegram-bot-api-secret-token"]',
            ],
          },
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 64 * 1024,
  });
  const ctx: Ctx = { db, config };

  await app.register(helmet, {
    // Mini App открывается во фрейме веб-версии Telegram, поэтому X-Frame-Options не подходит —
    // разрешённых родителей задаёт frame-ancestors.
    frameguard: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://telegram.org'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://t.me', 'https://telegram.org'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ['https://oauth.telegram.org'],
        frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: limits.global,
    timeWindow: '1 minute',
    allowList: (req) => !req.url.startsWith('/api/'),
    errorResponseBuilder: () =>
      new AppError(429, 'RATE_LIMITED', 'Слишком много запросов. Подождите немного и попробуйте снова.'),
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    let status = 500;
    let body: ApiError = { error: { code: 'INTERNAL', message: 'Что-то пошло не так. Попробуйте ещё раз.' } };
    if (err instanceof AppError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, details: err.details } };
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      status = err.statusCode;
      body = { error: { code: 'BAD_REQUEST', message: 'Некорректный запрос' } };
    }
    if (status >= 500) req.log.error({ err }, 'Необработанная ошибка');
    return reply.status(status).send(body);
  });

  app.get('/api/health', async () => {
    await db.execute('select 1');
    return { ok: true };
  });

  app.get('/api/public/config', async (): Promise<PublicConfig> => {
    const settings = await getSettings(db, config);
    return { brandName: settings.brandName, botUsername: config.BOT_USERNAME ?? null };
  });

  // Webhook Telegram. Подлинность запроса подтверждается секретом в заголовке.
  app.post('/api/telegram/webhook', async (req, reply) => {
    const expected = config.TELEGRAM_WEBHOOK_SECRET;
    const got = req.headers['x-telegram-bot-api-secret-token'];
    const ok =
      expected !== undefined &&
      typeof got === 'string' &&
      got.length === expected.length &&
      timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if (!ok) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Неверный секрет' } });
    // Ошибку обработки логируем, но отвечаем 200: иначе Telegram будет бесконечно повторять доставку.
    await handleUpdate(ctx, telegram, req.body as TelegramUpdate).catch((err) =>
      req.log.error({ err }, 'Ошибка обработки обновления Telegram'),
    );
    return { ok: true };
  });

  registerClientRoutes(app, ctx, telegram, limits);
  registerAdminRoutes(app, ctx, telegram);

  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, maxAge: '1h', immutable: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Не найдено' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Не найдено' } }),
    );
  }

  return app;
}
