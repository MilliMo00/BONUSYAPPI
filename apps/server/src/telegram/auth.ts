import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function safeEqualHex(a: string, b: string): boolean {
  // Buffer.from(…, 'hex') молча отбрасывает невалидный хвост, поэтому формат проверяем явно.
  if (!SHA256_HEX.test(a) || !SHA256_HEX.test(b)) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

function isFresh(authDate: number, maxAgeSeconds: number, now: Date): boolean {
  const age = Math.floor(now.getTime() / 1000) - authDate;
  // Небольшой допуск на расхождение часов.
  return Number.isFinite(authDate) && age <= maxAgeSeconds && age >= -300;
}

/**
 * Проверяет подпись initData Telegram Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Возвращает пользователя либо null, если данные подделаны или устарели.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now = new Date(),
): TelegramUser | null {
  if (!initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(hash, expected)) return null;
  if (!isFresh(Number(params.get('auth_date')), maxAgeSeconds, now)) return null;

  try {
    const user = JSON.parse(params.get('user') ?? '') as TelegramUser;
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}

/** Подписывает initData так же, как Telegram. Нужен для тестов и локальной ссылки разработчика. */
export function signInitData(user: TelegramUser, botToken: string, authDate = new Date()): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(authDate.getTime() / 1000)),
    query_id: 'local',
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

/**
 * Проверяет данные Telegram Login Widget (вход в админ-панель из обычного браузера).
 * https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyLoginWidget(
  data: Record<string, string | number>,
  botToken: string,
  maxAgeSeconds: number,
  now = new Date(),
): TelegramUser | null {
  const { hash, ...rest } = data;
  if (typeof hash !== 'string') return null;
  const dataCheckString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(hash, expected)) return null;
  if (!isFresh(Number(rest.auth_date), maxAgeSeconds, now)) return null;
  const id = Number(rest.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    username: rest.username ? String(rest.username) : undefined,
    first_name: rest.first_name ? String(rest.first_name) : undefined,
    last_name: rest.last_name ? String(rest.last_name) : undefined,
  };
}

// ── Сессия админ-панели в браузере: подписанная cookie без состояния на сервере ──

export function signSession(
  telegramId: number,
  secret: string,
  ttlSeconds: number,
  now = new Date(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ tid: telegramId, exp: Math.floor(now.getTime() / 1000) + ttlSeconds }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined, secret: string, now = new Date()): number | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  if (!safeEqualHex(sig, expected)) return null;
  try {
    const { tid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      tid: number;
      exp: number;
    };
    if (!Number.isSafeInteger(tid) || exp < Math.floor(now.getTime() / 1000)) return null;
    return tid;
  } catch {
    return null;
  }
}
