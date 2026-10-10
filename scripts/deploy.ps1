# Автообновление боевого сервера из GitHub. Запускается планировщиком раз в пару минут:
# если в ветке появились новые коммиты — делает копию базы, подтягивает код, собирает,
# применяет миграции и перезапускает приложение. Если сборка не прошла, возвращает
# прежнюю версию и приложение не трогает.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 [-Branch main] [-Force]
param(
  [string]$Branch = "main",
  # Собрать и перезапустить, даже если новых коммитов нет
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$state = "C:\ProgramData\yappibot-deploy"
$log = Join-Path $state "deploy.log"
$lock = Join-Path $state "deploy.lock"
New-Item -ItemType Directory -Force -Path $state | Out-Null
Set-Location $root

function Log([string]$message) { "$(Get-Date -Format s) $message" | Add-Content -Path $log -Encoding UTF8 }

# Запускает команду и останавливает обновление, если она завершилась с ошибкой.
function Run([string]$command) {
  $output = cmd /c "$command 2>&1"
  if ($LASTEXITCODE -ne 0) {
    throw "$command -> код $LASTEXITCODE`n$(($output | Select-Object -Last 15) -join "`n")"
  }
}

function Build {
  Run "npm ci --no-audit --no-fund"
  Run "npm run build"
}

# Два обновления одновременно не идут; зависшая блокировка старше получаса снимается.
if (Test-Path $lock) {
  if ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-30)) { exit 0 }
  Remove-Item $lock -Force
}
New-Item -ItemType File -Path $lock | Out-Null

try {
  Run "git fetch --quiet origin $Branch"
  $current = (git rev-parse HEAD).Trim()
  $target = (git rev-parse "origin/$Branch").Trim()
  if ($current -eq $target -and -not $Force) { exit 0 }

  Log "Обновление $($current.Substring(0, 7)) -> $($target.Substring(0, 7))"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "backup.ps1") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Не удалось сделать резервную копию базы — обновление отменено" }

  Run "git reset --hard --quiet $target"
  try {
    Build
  } catch {
    Log "ОШИБКА сборки, возвращаю версию $($current.Substring(0, 7)): $($_.Exception.Message)"
    Run "git reset --hard --quiet $current"
    Build
    exit 1
  }
  # Миграции применяются после успешной сборки. Откатить их автоматически нельзя —
  # на этот случай перед обновлением сделана копия базы.
  Run "npm run -s db:migrate"

  # pm2 на этом сервере работает от LOCAL SERVICE: новым файлам нужен доступ на чтение.
  icacls $root /grant "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX" /T /Q | Out-Null
  icacls (Join-Path $root ".env") /grant "NT AUTHORITY\LOCAL SERVICE:R" /Q | Out-Null
  Run "pm2 restart yappibot"

  Start-Sleep -Seconds 6
  $port = ((Get-Content (Join-Path $root ".env") | Where-Object { $_ -match "^PORT=" }) -replace "^PORT=", "")
  try {
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/health" -TimeoutSec 15 | Out-Null
    Log "Готово: работает версия $($target.Substring(0, 7))"
  } catch {
    Log "ВНИМАНИЕ: версия $($target.Substring(0, 7)) установлена, но приложение не отвечает: $($_.Exception.Message)"
    exit 1
  }
} catch {
  Log "ОШИБКА: $($_.Exception.Message)"
  exit 1
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
