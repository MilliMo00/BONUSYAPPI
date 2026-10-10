#!/usr/bin/env bash
# Резервная копия базы данных. Запуск: DATABASE_URL=postgres://... ./scripts/backup.sh [папка]
# Хранит копии за последние KEEP_DAYS дней (по умолчанию 14).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL не задан}"
DIR="${1:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DIR"
FILE="$DIR/yappibot-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"
# Проверяем, что архив читается.
pg_restore --list "$FILE" > /dev/null
find "$DIR" -name 'yappibot-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "Резервная копия: $FILE"
