// Рассылка подписчикам бота: текст с разметкой Telegram, фото или голосовое, кнопки.
import { and, asc, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BroadcastAudience, BroadcastDto, BroadcastInput } from '../contract/api.ts';
import { LOCALES } from '../contract/constants.ts';
import type { Locale } from '../contract/constants.ts';
import type { Executor } from '../db/client.ts';
import { broadcastRecipients, broadcasts, staff, users } from '../db/schema.ts';
import { badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import { TelegramError } from '../telegram/client.ts';
import type { InlineButton, TelegramClient } from '../telegram/client.ts';
import { audit, requirePermission } from './common.ts';
import type { Actor, Ctx } from './common.ts';

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
/** Теги HTML-разметки, которые понимает Telegram. */
const ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
  'blockquote',
  'tg-spoiler',
]);

/**
 * Проверяет разметку до отправки: только разрешённые теги, все закрыты в правильном порядке,
 * ссылки — http(s) или tg. Иначе Telegram отклонил бы сообщение уже в ходе рассылки.
 * Возвращает длину текста без тегов.
 */
export function validateTelegramHtml(html: string): number {
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g;
  // Любой «<», не являющийся началом корректного тега, должен быть записан как &lt;
  const stripped = html.replace(tagRe, '');
  if (stripped.includes('<') || stripped.includes('>')) {
    throw badRequest(
      'MARKUP',
      'В тексте есть символ < или > вне тега. Для самих знаков используйте &lt; и &gt;',
    );
  }
  for (const m of html.matchAll(tagRe)) {
    const [, closing, rawName, attrs = ''] = m;
    const name = rawName!.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) throw badRequest('MARKUP', `Тег <${name}> не поддерживается Telegram`);
    if (closing) {
      if (stack.pop() !== name) throw badRequest('MARKUP', `Тег </${name}> закрыт не по порядку`);
      continue;
    }
    if (name === 'a') {
      const href = /^\s+href="([^"]+)"\s*$/.exec(attrs)?.[1];
      if (!href || !/^(https?:\/\/|tg:\/\/)/i.test(href)) {
        throw badRequest('MARKUP', 'Ссылка должна иметь вид <a href="https://…">текст</a>');
      }
    } else if (attrs.trim() && !(name === 'blockquote' && attrs.trim() === 'expandable')) {
      throw badRequest('MARKUP', `У тега <${name}> не должно быть атрибутов`);
    }
    stack.push(name);
  }
  if (stack.length) throw badRequest('MARKUP', `Тег <${stack.at(-1)}> не закрыт`);
  return stripped.replace(/&(lt|gt|amp|quot);/g, 'x').length;
}

const buttonSchema = z.object({
  text: z.string().trim().min(1, 'у кнопки должен быть текст').max(40),
  url: z
    .string()
    .trim()
    .max(500)
    .refine(
      (v) => /^(https:\/\/|tg:\/\/)\S+$/i.test(v),
      'ссылка кнопки должна начинаться с https:// или tg://',
    )
    .nullable(),
});

const inputSchema = z
  .object({
    text: z.string().max(TEXT_LIMIT * 3),
    mediaKind: z.enum(['photo', 'voice']).nullable(),
    mediaFileId: z.string().min(10).max(300).nullable(),
    buttons: z.array(buttonSchema).max(8),
    locale: z.enum(LOCALES).nullable(),
  })
  .superRefine((v, ctx) => {
    if ((v.mediaKind === null) !== (v.mediaFileId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mediaFileId'],
        message: 'файл загружен не полностью — прикрепите его заново',
      });
    }
  });

function checkInput(ctx: Ctx, input: unknown): BroadcastInput {
  const data = parse(inputSchema, input);
  const text = data.text.trim();
  if (!text && !data.mediaKind) throw badRequest('EMPTY', 'Добавьте текст, фото или голосовое сообщение');
  const length = text ? validateTelegramHtml(text) : 0;
  const limit = data.mediaKind ? CAPTION_LIMIT : TEXT_LIMIT;
  if (length > limit) {
    throw badRequest(
      'TOO_LONG',
      data.mediaKind
        ? `Подпись к фото или голосовому — до ${CAPTION_LIMIT} символов, сейчас ${length}`
        : `Текст — до ${TEXT_LIMIT} символов, сейчас ${length}`,
    );
  }
  if (data.buttons.some((b) => b.url === null) && !ctx.config.APP_URL?.startsWith('https://')) {
    throw badRequest('NO_APP_URL', 'Кнопка открытия приложения недоступна: на сервере не задан APP_URL');
  }
  return { ...data, text };
}

function keyboard(ctx: Ctx, input: BroadcastInput): InlineButton[][] | undefined {
  if (input.buttons.length === 0) return undefined;
  return input.buttons.map((b) => [
    b.url === null ? { text: b.text, web_app: { url: ctx.config.APP_URL! } } : { text: b.text, url: b.url },
  ]);
}

/** Отправляет одно сообщение рассылки в чат. */
async function deliver(
  ctx: Ctx,
  telegram: TelegramClient,
  chatId: number,
  input: BroadcastInput,
): Promise<void> {
  const buttons = keyboard(ctx, input);
  const markup = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
  if (input.mediaKind === 'photo') {
    await telegram.call('sendPhoto', {
      chat_id: chatId,
      photo: input.mediaFileId,
      caption: input.text || undefined,
      parse_mode: 'HTML',
      ...markup,
    });
  } else if (input.mediaKind === 'voice') {
    await telegram.call('sendVoice', {
      chat_id: chatId,
      voice: input.mediaFileId,
      caption: input.text || undefined,
      parse_mode: 'HTML',
      ...markup,
    });
  } else {
    await telegram.sendMessage(chatId, input.text, { buttons });
  }
}

const subscribed = (locale: Locale | null) =>
  and(
    isNotNull(users.botStartedAt),
    isNull(users.botBlockedAt),
    eq(users.accountStatus, 'ACTIVE'),
    locale ? eq(users.locale, locale) : undefined,
  );

/** Сколько человек получит рассылку: все, кто нажал /start и не заблокировал бота. */
export async function getAudience(ctx: Ctx, actor: Actor): Promise<BroadcastAudience> {
  requirePermission(actor, 'broadcast.send');
  const rows = await ctx.db
    .select({ locale: users.locale, n: count() })
    .from(users)
    .where(subscribed(null))
    .groupBy(users.locale);
  const byLocale = { ru: 0, en: 0, uk: 0, none: 0 };
  for (const r of rows) byLocale[r.locale ?? 'none'] += r.n;
  return { total: rows.reduce((sum, r) => sum + r.n, 0), byLocale };
}

/**
 * Загружает фото или голосовое: файл отправляется в личный чат сотрудника с ботом,
 * Telegram возвращает file_id — по нему файл потом рассылается всем без повторной загрузки.
 */
export async function uploadMedia(
  ctx: Ctx,
  telegram: TelegramClient,
  actor: Actor,
  kind: string,
  file: Buffer,
  fileName: string,
): Promise<{ mediaKind: 'photo' | 'voice'; mediaFileId: string }> {
  requirePermission(actor, 'broadcast.send');
  if (actor.type !== 'STAFF') throw badRequest('ACTOR', 'Загружать файлы может только сотрудник');
  if (kind !== 'photo' && kind !== 'voice')
    throw badRequest('KIND', 'Можно прикрепить фото или голосовое сообщение');
  if (file.length === 0) throw badRequest('EMPTY_FILE', 'Файл пустой');
  if (file.length > (kind === 'photo' ? 10 : 20) * 1024 * 1024) {
    throw badRequest('FILE_TOO_BIG', kind === 'photo' ? 'Фото — до 10 МБ' : 'Голосовое — до 20 МБ');
  }
  const form = new FormData();
  form.set('chat_id', String(actor.staff.telegramId));
  form.set('disable_notification', 'true');
  form.set(kind, new Blob([new Uint8Array(file)]), fileName.replace(/[^\w.-]/g, '_') || `${kind}.bin`);
  form.set('caption', kind === 'photo' ? 'Фото для рассылки загружено' : 'Голосовое для рассылки загружено');
  try {
    const message = await telegram.upload<{
      photo?: { file_id: string }[];
      voice?: { file_id: string };
      audio?: { file_id: string };
    }>(kind === 'photo' ? 'sendPhoto' : 'sendVoice', form);
    const fileId =
      kind === 'photo' ? message.photo?.at(-1)?.file_id : (message.voice?.file_id ?? message.audio?.file_id);
    if (!fileId)
      throw badRequest('UPLOAD', 'Telegram не принял файл. Для голосового подойдёт .ogg, .mp3 или .m4a');
    return { mediaKind: kind, mediaFileId: fileId };
  } catch (err) {
    if (err instanceof TelegramError) {
      throw badRequest(
        'UPLOAD',
        err.code === 403 || /chat not found/i.test(err.message)
          ? 'Сначала нажмите /start в боте — файл загружается через ваш личный чат с ним'
          : `Telegram не принял файл: ${err.message}`,
      );
    }
    throw err;
  }
}

/** Пробная отправка себе: так видно, как сообщение выглядит в Telegram, до рассылки всем. */
export async function sendTest(
  ctx: Ctx,
  telegram: TelegramClient,
  actor: Actor,
  input: unknown,
): Promise<void> {
  requirePermission(actor, 'broadcast.send');
  if (actor.type !== 'STAFF') throw badRequest('ACTOR', 'Пробная отправка доступна только сотруднику');
  const data = checkInput(ctx, input);
  try {
    await deliver(ctx, telegram, actor.staff.telegramId, data);
  } catch (err) {
    if (err instanceof TelegramError) {
      throw badRequest(
        'TEST_FAILED',
        err.code === 403
          ? 'Сначала нажмите /start в боте, чтобы он мог вам написать'
          : `Telegram отклонил сообщение: ${err.message}`,
      );
    }
    throw err;
  }
}

/** Создаёт рассылку и фиксирует список получателей. Отправка идёт в фоне. */
export async function createBroadcast(ctx: Ctx, actor: Actor, input: unknown): Promise<BroadcastDto> {
  requirePermission(actor, 'broadcast.send');
  const data = checkInput(ctx, input);
  const id = await ctx.db.transaction(async (tx) => {
    const [active] = await tx
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(eq(broadcasts.status, 'SENDING'));
    if (active)
      throw conflict('BROADCAST_RUNNING', 'Предыдущая рассылка ещё отправляется — дождитесь её завершения');
    const [created] = await tx
      .insert(broadcasts)
      .values({ ...data, createdByStaffId: actor.type === 'STAFF' ? actor.staff.id : null })
      .returning();
    const inserted = await tx.execute(sql`
      INSERT INTO broadcast_recipients (broadcast_id, user_id)
      SELECT ${created!.id}, id FROM users WHERE ${subscribed(data.locale)}`);
    const total = inserted.rowCount ?? 0;
    if (total === 0)
      throw conflict('NO_RECIPIENTS', 'Получателей нет: пока никто не нажал /start или не выбрал этот язык');
    await tx.update(broadcasts).set({ total }).where(eq(broadcasts.id, created!.id));
    await audit(tx, actor, 'broadcast.create', 'broadcast', created!.id, {
      recipients: total,
      locale: data.locale,
      media: data.mediaKind,
      buttons: data.buttons.length,
      preview: data.text.replace(/<[^>]+>/g, '').slice(0, 200),
    });
    return created!.id;
  });
  return (await listBroadcasts(ctx, actor, id))[0]!;
}

export async function cancelBroadcast(ctx: Ctx, actor: Actor, id: string): Promise<BroadcastDto> {
  requirePermission(actor, 'broadcast.send');
  if (!z.uuid().safeParse(id).success) throw notFound('Рассылка не найдена');
  const updated = await ctx.db
    .update(broadcasts)
    .set({ status: 'CANCELLED', finishedAt: new Date() })
    .where(and(eq(broadcasts.id, id), eq(broadcasts.status, 'SENDING')))
    .returning({ id: broadcasts.id });
  if (updated.length) await audit(ctx.db, actor, 'broadcast.cancel', 'broadcast', id);
  const [dto] = await listBroadcasts(ctx, actor, id);
  if (!dto) throw notFound('Рассылка не найдена');
  return dto;
}

export async function listBroadcasts(ctx: Ctx, actor: Actor, onlyId?: string): Promise<BroadcastDto[]> {
  requirePermission(actor, 'broadcast.send');
  return queryBroadcasts(ctx.db, onlyId);
}

async function queryBroadcasts(db: Executor, onlyId?: string): Promise<BroadcastDto[]> {
  const rows = await db
    .select({
      b: broadcasts,
      createdBy: staff.displayName,
      sent: sql<number>`(SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = ${broadcasts.id} AND r.status = 'SENT')`,
      failed: sql<number>`(SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id = ${broadcasts.id} AND r.status = 'FAILED')`,
    })
    .from(broadcasts)
    .leftJoin(staff, eq(staff.id, broadcasts.createdByStaffId))
    .where(onlyId ? eq(broadcasts.id, onlyId) : undefined)
    .orderBy(desc(broadcasts.createdAt))
    .limit(30);
  return rows.map(({ b, createdBy, sent, failed }) => ({
    id: b.id,
    text: b.text,
    mediaKind: b.mediaKind,
    mediaFileId: b.mediaFileId,
    buttons: b.buttons,
    locale: b.locale,
    status: b.status,
    total: b.total,
    sent,
    failed,
    createdBy,
    createdAt: b.createdAt.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
  }));
}

/**
 * Отправляет очередную порцию активной рассылки. Вызывается раз в секунду, порция — до 25 сообщений:
 * это укладывается в ограничение Telegram (~30 сообщений в секунду). Строки получателей берутся
 * с FOR UPDATE SKIP LOCKED, поэтому повторный запуск не отправит сообщение дважды.
 * Возвращает число обработанных получателей.
 */
export async function processBroadcasts(ctx: Ctx, telegram: TelegramClient, batch = 25): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const [active] = await tx
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.status, 'SENDING'))
      .orderBy(asc(broadcasts.createdAt))
      .limit(1);
    if (!active) return 0;
    const pending = await tx
      .select({ userId: broadcastRecipients.userId, telegramId: users.telegramId })
      .from(broadcastRecipients)
      .innerJoin(users, eq(users.id, broadcastRecipients.userId))
      .where(and(eq(broadcastRecipients.broadcastId, active.id), eq(broadcastRecipients.status, 'PENDING')))
      .limit(batch)
      .for('update', { of: broadcastRecipients, skipLocked: true });

    if (pending.length === 0) {
      await tx
        .update(broadcasts)
        .set({ status: 'DONE', finishedAt: new Date() })
        .where(eq(broadcasts.id, active.id));
      return 0;
    }
    const mark = (userId: string, status: 'SENT' | 'FAILED', error: string | null) =>
      tx
        .update(broadcastRecipients)
        .set({ status, error, sentAt: new Date() })
        .where(and(eq(broadcastRecipients.broadcastId, active.id), eq(broadcastRecipients.userId, userId)));

    let processed = 0;
    for (const r of pending) {
      try {
        await deliver(ctx, telegram, r.telegramId, active);
        await mark(r.userId, 'SENT', null);
      } catch (err) {
        // Telegram просит притормозить — оставшихся получателей отправим в следующий заход.
        if (err instanceof TelegramError && err.code === 429) break;
        if (err instanceof TelegramError && err.code === 403) {
          await tx.update(users).set({ botBlockedAt: new Date() }).where(eq(users.id, r.userId));
        }
        await mark(r.userId, 'FAILED', String((err as Error)?.message ?? err).slice(0, 300));
      }
      processed++;
    }
    return processed;
  });
}
