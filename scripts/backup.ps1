# Резервная копия базы на Windows-сервере. Читает DATABASE_URL из .env в корне проекта.
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1 [-Dir C:\backups\yappibot] [-KeepDays 14]
param(
  [string]$Dir = "C:\backups\yappibot",
  [int]$KeepDays = 14,
  [string]$PgBin = "C:\Program Files\PostgreSQL\15\bin"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$line = Get-Content (Join-Path $root ".env") | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
if (-not $line) { throw "DATABASE_URL не найден в .env" }
$url = $line.Substring("DATABASE_URL=".Length)
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$file = Join-Path $Dir ("yappibot-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".dump")
& (Join-Path $PgBin "pg_dump.exe") --format=custom --no-owner --no-privileges "--file=$file" $url
if ($LASTEXITCODE -ne 0) { throw "pg_dump завершился с ошибкой" }
# Проверяем, что архив читается.
& (Join-Path $PgBin "pg_restore.exe") --list $file | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Резервная копия повреждена: $file" }
Get-ChildItem $Dir -Filter "yappibot-*.dump" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } | Remove-Item -Force
Write-Output "Резервная копия: $file"
