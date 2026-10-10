#!/usr/bin/env bash
# Восстановление базы из резервной копии В ПУСТУЮ базу.
# Запуск: DATABASE_URL=postgres://.../новая_пустая_база ./scripts/restore.sh backups/yappibot-....dump
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL не задан}"
FILE="${1:?Укажите файл резервной копии}"
TABLES=$(psql "$DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema in ('public','drizzle')")
if [ "$TABLES" != "0" ]; then
  echo "В базе уже есть таблицы ($TABLES). Восстанавливайте только в пустую базу, чтобы ничего не затереть." >&2
  exit 1
fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" "$FILE"
echo "База восстановлена из $FILE"
