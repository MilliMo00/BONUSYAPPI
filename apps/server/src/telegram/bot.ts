import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { effectivePermissions, LOCALES } from '../contract/constants.ts';
import type { Locale } from '../contract/constants.ts';
import { bonuses, staff, users } from '../db/schema.ts';
import { AppError } from '../lib/errors.ts';
import { activateBonus, returnBonus } from '../services/bonuses.ts';
import type { Actor, Ctx } from '../services/common.ts';
import { BOT, LANGUAGE_BUTTONS, LANGUAGE_PROMPT } from '../services/i18n.ts';
import { getSettings } from '../services/settings.ts';
import { grantSpin } from '../services/spins.ts';
import { CALLBACK } from '../services/templates.ts';
import { upsertUserFromTelegram } from '../services/users.ts';
import { escapeHtml, TelegramError } from './client.ts';
import type { TelegramClient, TelegramUpdate } from './client.ts';

/** Обработка входящего обновления. Бот — только точка входа: вся логика живёт в Mini App. */
export async function handleUpdate(
  ctx: Ctx,
  telegram: TelegramClient,
  update: TelegramUpdate,
): Promise<void> {
  if (update.callback_query) {
    const data = update.callback_query.data ?? '';
    if (data.startsWith(LANG_CALLBACK)) await handleLanguageChoice(ctx, telegram, update.callback_query);
    else await handleCallback(ctx, telegram, update.callback_query);
    return;
  }
  const message = update.message;
  if (!message?.text || !message.from || message.chat.type !== 'private') return;
  const command = message.text.split(/[\s@]/)[0];
  if (!['/start', '/help', '/lang', '/language'].includes(command!)) return;

  // /start регистрирует клиента и отмечает, что боту можно ему писать (нужно для рассылок).
  const user = await upsertUserFromTelegram(ctx.db, ctx.config, message.from);
  await ctx.db
    .update(users)
    .set({ botStartedAt: user.botStartedAt ?? new Date(), botBlockedAt: null })
    .where(eq(users.id, user.id));

  // Язык ещё не выбран (или клиент просит его сменить) — сначала спрашиваем язык.
  if (!user.locale || command === '/lang' || command === '/language') {
    await telegram.sendMessage(message.chat.id, LANGUAGE_PROMPT, {
      buttons: [
        LANGUAGE_BUTTONS.map((b) => ({ text: b.text, callback_data: `${LANG_CALLBACK}${b.locale}` })),
      ],
    });
    return;
  }
  const welcome = await welcomeMessage(ctx, user.locale, message.from.first_name);
  await telegram.sendMessage(message.chat.id, welcome.html, { buttons: welcome.buttons });
}

const LANG_CALLBACK = 'lang:';

async function welcomeMessage(ctx: Ctx, locale: Locale, firstName?: string) {
  const { brandName } = await getSettings(ctx.db, ctx.config);
  const appUrl = ctx.config.APP_URL?.startsWith('https://') ? ctx.config.APP_URL : null;
  const t = BOT[locale];
  const name = firstName ? `, ${escapeHtml(firstName)}` : '';
  return {
    html: [...t.welcome(name, escapeHtml(brandName)), '', appUrl ? t.appReady : t.appNotReady].join('\n'),
    buttons: appUrl ? [[{ text: t.openApp, web_app: { url: appUrl } }]] : undefined,
  };
}

/**
 * Настраивает чат клиента под выбранный язык: кнопку меню и подсказки команд.
 * Вызывается при выборе языка в боте и при его смене в приложении.
 */
export async function applyChatLocale(ctx: Ctx, telegram: TelegramClient, chatId: number, locale: Locale) {
  const t = BOT[locale];
  await telegram.call('setMyCommands', {
    scope: { type: 'chat', chat_id: chatId },
    commands: [
      { command: 'start', description: t.commandStart },
      { command: 'lang', description: t.commandLang },
    ],
  });
  if (ctx.config.APP_URL?.startsWith('https://')) {
    await telegram.call('setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'web_app', text: t.menuButton, web_app: { url: ctx.config.APP_URL } },
    });
  }
}

/** Клиент выбрал язык: сохраняем, заменяем вопрос приветствием и перенастраиваем чат. */
async function handleLanguageChoice(ctx: Ctx, telegram: TelegramClient, query: CallbackQuery): Promise<void> {
  const locale = (query.data ?? '').slice(LANG_CALLBACK.length);
  const answer = (text: string) =>
    telegram.call('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => {});
  if (!LOCALES.includes(locale as Locale)) return void (await answer('…'));
  const chosen = locale as Locale;

  const user = await upsertUserFromTelegram(ctx.db, ctx.config, query.from);
  await ctx.db
    .update(users)
    .set({
      locale: chosen,
      botStartedAt: user.botStartedAt ?? new Date(),
      botBlockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  await answer(BOT[chosen].languageSaved);

  const welcome = await welcomeMessage(ctx, chosen, query.from.first_name);
  if (query.message) {
    await telegram
      .call('editMessageText', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: welcome.html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(welcome.buttons ? { reply_markup: { inline_keyboard: welcome.buttons } } : {}),
      })
      .catch(() => telegram.sendMessage(query.from.id, welcome.html, { buttons: welcome.buttons }));
  } else {
    await telegram.sendMessage(query.from.id, welcome.html, { buttons: welcome.buttons });
  }
  await applyChatLocale(ctx, telegram, query.from.id, chosen).catch(() => {});
}

type CallbackQuery = NonNullable<TelegramUpdate['callback_query']>;

/**
 * Кнопки «Активировать» и «Вернуть клиенту» под уведомлением о применённом бонусе.
 * Нажавший определяется по Telegram ID из обновления (подлинность webhook подтверждена секретом),
 * его роль и права каждый раз читаются из БД — как и в админ-панели.
 */
async function handleCallback(ctx: Ctx, telegram: TelegramClient, query: CallbackQuery): Promise<void> {
  const answer = (text: string, alert = false) =>
    telegram
      .call('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: alert })
      .catch(() => {});
  const data = query.data ?? '';
  const action = data.startsWith(CALLBACK.activate)
    ? 'activate'
    : data.startsWith(CALLBACK.giveBack)
      ? 'return'
      : data.startsWith(CALLBACK.grantSpin)
        ? 'spin'
        : null;
  const bonusId = data.slice(3);
  if (!action || !/^[0-9a-f-]{36}$/.test(bonusId)) return void (await answer('Кнопка устарела'));

  const [member] = await ctx.db.select().from(staff).where(eq(staff.telegramId, query.from.id));
  if (!member?.isActive) return void (await answer('У вас нет доступа к этому действию', true));
  const actor: Actor = {
    type: 'STAFF',
    staff: member,
    permissions: new Set(effectivePermissions(member.role, member.permissions)),
  };

  let result: string;
  // После активации под сообщением остаётся одна кнопка — начислить клиенту вращение за этот заказ.
  let nextButton: { text: string; callback_data: string } | null = null;
  try {
    if (action === 'spin') {
      // Клиент определяется по бонусу из кнопки: начислить вращение «кому-то другому» отсюда нельзя.
      const [bonus] = await ctx.db
        .select({ userId: bonuses.userId })
        .from(bonuses)
        .where(eq(bonuses.id, bonusId));
      if (!bonus) return void (await answer('Бонус не найден', true));
      await grantSpin(ctx, actor, { userId: bonus.userId });
      result = `🎡 Вращение начислено · ${member.displayName}`;
    } else if (action === 'activate') {
      const { bonus, changed } = await activateBonus(ctx, actor, bonusId);
      result =
        bonus.status === 'EXPIRED'
          ? '⌛ Срок действия бонуса истёк — активировать нельзя'
          : changed
            ? `✅ Активирован · ${member.displayName}`
            : '✅ Бонус уже был активирован';
      if (bonus.status === 'REDEEMED' && actor.permissions.has('spins.grant')) {
        nextButton = { text: '🎡 Начислить вращение', callback_data: `${CALLBACK.grantSpin}${bonusId}` };
      }
    } else {
      const { bonus, changed } = await returnBonus(ctx, actor, bonusId, {});
      result = changed
        ? bonus.status === 'EXPIRED'
          ? '⌛ Срок действия истёк — бонус закрыт'
          : `↩️ Возвращён клиенту · ${member.displayName}`
        : '↩️ Бонус уже у клиента';
    }
  } catch (err) {
    if (err instanceof AppError) return void (await answer(err.message, true));
    throw err;
  }

  await answer(result.replace(/ · .*/, ''));
  // Убираем кнопки и дописываем итог, чтобы по сообщению было видно, что с бонусом сделано.
  if (query.message) {
    await telegram
      .call('editMessageText', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: `${escapeHtml(query.message.text ?? 'Бонус')}\n\n<b>${escapeHtml(result)}</b>`,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(nextButton ? { reply_markup: { inline_keyboard: [[nextButton]] } } : {}),
      })
      .catch(() => {});
  }
}

/** Long polling для локальной разработки. В production используется webhook. */
export function startPolling(ctx: Ctx, telegram: TelegramClient, log: FastifyBaseLogger): () => void {
  let stopped = false;
  let offset = 0;
  void (async () => {
    while (!stopped) {
      try {
        const updates = await telegram.call<TelegramUpdate[]>(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          35_000,
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          await handleUpdate(ctx, telegram, update).catch((err) =>
            log.error({ err }, 'Ошибка обработки обновления'),
          );
        }
      } catch (err) {
        if (stopped) break;
        const conflict = err instanceof TelegramError && err.code === 409;
        log.error(
          { err },
          conflict
            ? 'У бота включён webhook — polling невозможен. Выполните npm run bot:setup'
            : 'Ошибка getUpdates',
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
