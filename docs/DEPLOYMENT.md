# Развёртывание

Приложение размещается на отдельном поддомене существующего домена, например `app.yourdomain.com`. Основной сайт при этом не затрагивается: меняется только одна DNS-запись поддомена. Ниже `app.yourdomain.com` — пример, подставьте свой адрес.

Понадобится сервер (VPS) с публичным IP: 1 vCPU и 1 ГБ памяти достаточно. Обычный хостинг для статических сайтов и PHP не подойдёт — нужен постоянно работающий процесс Node.js и PostgreSQL.

## 1. Создать бота

Создаётся **новый** бот. Существующего бота агентства не трогаем.

1. В Telegram откройте [@BotFather](https://t.me/BotFather) → `/newbot`, задайте имя и username. Сохраните токен.
2. `/setdomain` → выберите бота → укажите `app.yourdomain.com`. Это нужно для входа в админ-панель из браузера.
3. По желанию: `/setdescription`, `/setuserpic`.

Токен — секрет: он хранится только в `.env` на сервере. Если токен попал в чужие руки, перевыпустите его командой `/revoke`.

### Запуск приложения без входа в чат

Чтобы приложение открывалось прямо из списка чатов и из профиля бота (кнопка «Открыть»), включите основное мини-приложение. Через Bot API это не настраивается — только в BotFather:

`/mybots` → выберите бота → **Bot Settings** → **Configure Mini App** → **Enable Mini App** → укажите адрес приложения (`APP_URL`).

После этого работает и прямая ссылка `https://t.me/<имя_бота>?startapp`. Клиент, открывший приложение так, не нажимал `/start`, поэтому при первом запуске приложение само спрашивает язык и разрешение боту присылать сообщения.

## 2. Настроить DNS

В панели управления доменом добавьте запись:

| Тип | Имя   | Значение         |
| --- | ----- | ---------------- |
| A   | `app` | IP-адрес сервера |

Записи основного сайта не меняйте. Проверка: `dig +short app.yourdomain.com` должен вернуть IP сервера.

## 3. Подготовить окружение

```bash
git clone <репозиторий> yappibot && cd yappibot
cp .env.example .env
```

Заполните `.env`:

| Переменная                | Значение                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| `APP_URL`                 | `https://app.yourdomain.com` (без слэша в конце)                                  |
| `BOT_TOKEN`               | токен от BotFather                                                                |
| `BOT_USERNAME`            | username бота без `@`                                                             |
| `TELEGRAM_UPDATES_MODE`   | `webhook`                                                                         |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32`                                                            |
| `SESSION_SECRET`          | `openssl rand -hex 32`                                                            |
| `DATABASE_URL`            | строка подключения к PostgreSQL (в варианте с Docker подставляется автоматически) |
| `TEAM_CHAT_ID`            | необязательно; ID рабочего чата можно задать и в админке                          |
| `DEFAULT_CURRENCY`        | `RUB` или другая валюта                                                           |

Файл `.env` не коммитится (он в `.gitignore`). Ограничьте доступ: `chmod 600 .env`.

## 4. Запустить

### Вариант A. Docker Compose

> Файлы `Dockerfile`, `docker-compose.yml` и `deploy/Caddyfile` подготовлены, но в среде разработки Docker не был установлен, поэтому **запуск через Docker не проверялся**. Вариант B проверен полностью.

Добавьте в `.env` две переменные для Compose:

```
APP_DOMAIN=app.yourdomain.com
POSTGRES_PASSWORD=<openssl rand -hex 24>
```

```bash
docker compose up -d --build
docker compose logs -f app
```

Caddy сам получит и будет продлевать сертификат Let's Encrypt. Порты 80 и 443 должны быть открыты. Миграции применяются при старте контейнера. CLI-команды запускаются так:

```bash
docker compose exec app node apps/server/src/cli/seed.ts
docker compose exec app node apps/server/src/cli/create-owner.ts --telegram-id 123456789 --name "Имя"
docker compose exec app node apps/server/src/cli/bot-setup.ts
```

### Вариант B. Без Docker

Нужны Node.js ≥ 22.18, PostgreSQL ≥ 14 и обратный прокси с HTTPS (Caddy или nginx + certbot).

```bash
sudo -u postgres createuser --pwprompt yappibot
sudo -u postgres createdb --owner yappibot yappibot

npm ci
npm run build
npm run db:migrate
npm run db:seed
```

Сервис systemd `/etc/systemd/system/yappibot.service`:

```ini
[Unit]
Description=Loyalty platform
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/yappibot
ExecStart=/usr/bin/npm start
Environment=NODE_ENV=production
Restart=always
User=yappibot

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now yappibot
```

Caddy (`/etc/caddy/Caddyfile`) — HTTPS настраивается автоматически:

```
app.yourdomain.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

Сервер слушает только локальный порт; наружу его публикует прокси. В production сервер доверяет заголовкам прокси (`X-Forwarded-For`) — не открывайте порт 3000 в интернет напрямую.

## 5. Создать первого владельца

Узнайте свой Telegram ID: откройте Mini App → «Профиль» (или спросите у [@userinfobot](https://t.me/userinfobot)).

```bash
npm run owner:create -- --telegram-id 123456789 --name "Имя Фамилия"
```

Команда безопасна для повторного запуска: существующему сотруднику она возвращает роль владельца и активный статус. Этим же способом восстанавливается доступ, если владелец его потерял. Остальных сотрудников владелец добавляет в админ-панели → «Сотрудники».

## 6. Подключить бота к приложению

```bash
npm run bot:setup
```

Команда ставит webhook на `APP_URL/api/telegram/webhook`, кнопку меню «Открыть» и команду `/start`.

## 7. Проверить

1. `curl https://app.yourdomain.com/api/health` → `{"ok":true}`.
2. Напишите боту `/start` — придёт приветствие с кнопкой «Открыть приложение».
3. Откройте приложение, прокрутите рулетку, оформите заявку с бонусом.
4. Откройте `https://app.yourdomain.com/admin`, войдите через Telegram, проведите заявку: стоимость → «Ожидает оплаты» → «Подтвердить оплату» → «Подтвердить использование бонуса».
5. Админ-панель → «Настройки»: укажите ссылку на менеджера и ID рабочего чата (бота нужно добавить в этот чат). Проверьте список услуг и призы в разделе «Рулетка».
6. Настройте резервное копирование — см. [OPERATIONS.md](OPERATIONS.md).

Чтобы получать уведомления лично (если рабочий чат не задан), каждый сотрудник должен один раз нажать `/start` в боте: Telegram не разрешает боту писать первым.

## Текущее боевое размещение (Windows Server + pm2)

Приложение установлено на общем сервере агентства (Windows Server 2022), где через один Caddy работают и другие сайты. Установка сделана так, чтобы их не затрагивать.

| Что             | Где                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Адрес           | `https://app.yappi-agency.com`                                                                                                             |
| Код             | `C:\Users\Administrator\yappibot`                                                                                                          |
| Секреты         | `C:\Users\Administrator\yappibot\.env` (доступ: Administrators, SYSTEM; чтение — LOCAL SERVICE)                                            |
| Процесс         | pm2, имя `yappibot`, слушает только `127.0.0.1:3020`                                                                                       |
| База            | отдельный экземпляр PostgreSQL 15: служба `postgresql-yappibot`, порт `5434`, только localhost, данные в `C:\ProgramData\yappibot-pg\data` |
| HTTPS           | блок `app.yappi-agency.com` в общем Caddyfile сервера                                                                                      |
| Резервные копии | задача планировщика `yappibot-db-backup`, ежедневно в 04:10 → `C:\backups\yappibot`, хранится 14 дней                                      |

Особенности этого сервера:

- pm2 работает от учётной записи `LOCAL SERVICE`. Папке проекта выдан доступ на чтение для неё; без этого процесс числится `online`, но не стартует и не пишет логов.
- Общий Caddyfile обслуживает все сайты сервера. Перед правкой делайте копию, проверяйте `caddy validate --config <файл> --adapter caddyfile` и применяйте через `caddy reload` — перезапускать Caddy не нужно. Копия до добавления нашего блока лежит рядом: `Caddyfile.bak-before-yappibot-*`.
- Существующие базы данных сервера не используются и не изменялись.

### Обновление: пуш в GitHub

Сервер обновляется сам. Задача планировщика `yappibot-auto-deploy` раз в две минуты запускает `scripts/deploy.ps1`: если в ветке `main` репозитория появились новые коммиты, скрипт

1. делает резервную копию базы;
2. подтягивает код (`git reset --hard origin/main`);
3. ставит зависимости и собирает проект;
4. применяет миграции и перезапускает процесс `yappibot`;
5. проверяет, что приложение отвечает.

Если сборка не прошла, возвращается прежняя версия, приложение не перезапускается. Журнал — `C:\ProgramData\yappibot-deploy\deploy.log`.

Что важно помнить:

- **Всё, что попало в `main`, через пару минут окажется на боевом сервере.** Перед пушем запускайте `npm test`, `npm run typecheck` и `npm run lint`.
- Правки делаются в репозитории, а не на сервере: при обновлении локальные изменения отслеживаемых файлов на сервере затираются. Файл `.env`, база и копии не затрагиваются.
- Миграции базы автоматически не откатываются. Если после обновления что-то сломалось, восстановите базу из копии, сделанной перед ним.
- Сервер читает репозиторий по HTTPS без ключа — это работает, пока репозиторий публичный. Если сделать его приватным, серверу понадобится ключ развёртывания (deploy key).

Обновить вручную, не дожидаясь задачи: `powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1`; с ключом `-Force` — пересобрать и перезапустить текущую версию.

Логи: `pm2 logs yappibot`. Проверка: `curl http://127.0.0.1:3020/api/health`.

Полное удаление, если понадобится: `pm2 delete yappibot; pm2 save`, убрать блок из Caddyfile и `caddy reload`, остановить и снять службу `postgresql-yappibot` (`pg_ctl unregister -N postgresql-yappibot`), удалить задачу `yappibot-db-backup` и папки проекта, данных и копий.
