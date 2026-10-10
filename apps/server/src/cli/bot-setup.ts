// Настраивает бота: webhook (или его снятие для polling), кнопку меню и команды.
import { loadConfig } from '../config.ts';
import { LOCALES } from '../contract/constants.ts';
import { BOT } from '../services/i18n.ts';
import { createTelegramClient } from '../telegram/client.ts';

const config = loadConfig();
const telegram = createTelegramClient(config.BOT_TOKEN, config.TELEGRAM_API_BASE);

const me = await telegram.call<{ username: string }>('getMe');
console.log(`Бот: @${me.username}`);
if (config.BOT_USERNAME && config.BOT_USERNAME !== me.username) {
  console.warn(`Внимание: BOT_USERNAME=${config.BOT_USERNAME} не совпадает с именем бота @${me.username}`);
}

if (config.TELEGRAM_UPDATES_MODE === 'webhook') {
  await telegram.call('setWebhook', {
    url: `${config.APP_URL}/api/telegram/webhook`,
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log(`Webhook: ${config.APP_URL}/api/telegram/webhook`);
} else {
  await telegram.call('deleteWebhook');
  console.log('Webhook снят (режим polling/off).');
}

// Команды по умолчанию — на трёх языках (по языку приложения Telegram). После выбора языка
// в боте клиент получает свой набор команд и кнопку меню на выбранном языке.
for (const locale of LOCALES) {
  await telegram.call('setMyCommands', {
    ...(locale === 'ru' ? {} : { language_code: locale }),
    commands: [
      { command: 'start', description: BOT[locale].commandStart },
      { command: 'lang', description: BOT[locale].commandLang },
    ],
  });
}
if (config.APP_URL?.startsWith('https://')) {
  await telegram.call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: config.APP_URL } },
  });
  console.log(`Кнопка меню открывает ${config.APP_URL}`);
} else {
  console.log('APP_URL с https:// не задан — кнопка меню не настроена.');
}
