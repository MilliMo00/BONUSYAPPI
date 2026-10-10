// Только для локальной разработки: печатает ссылку, которая открывает приложение в обычном
// браузере от имени указанного Telegram-пользователя. Данные входа подписываются настоящим
// токеном бота из .env, поэтому сервер проверяет их так же, как в Telegram, без обходов.
//   npm run dev:link -- --telegram-id 123456789 --name "Имя" [--username name] [--admin]
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { signInitData } from '../telegram/auth.ts';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('Команда недоступна в production.');
  process.exit(1);
}
const { values } = parseArgs({
  options: {
    'telegram-id': { type: 'string' },
    name: { type: 'string', default: 'Тестовый клиент' },
    username: { type: 'string' },
    admin: { type: 'boolean', default: false },
    base: { type: 'string', default: 'http://localhost:5173' },
  },
});
const id = Number(values['telegram-id']);
if (!Number.isSafeInteger(id) || id <= 0) {
  console.error('Укажите --telegram-id');
  process.exit(1);
}
const initData = signInitData({ id, first_name: values.name, username: values.username }, config.BOT_TOKEN);
console.log(
  `${values.base}${values.admin ? '/admin' : '/'}#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=web`,
);
