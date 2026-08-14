<#
.SYNOPSIS
    Сборка MyQuestify в исполняемый файл Windows.

.DESCRIPTION
    Скрипт готовит виртуальное окружение, ставит зависимости, генерирует
    иконку и запускает PyInstaller по файлу MyQuestify.spec.

    Все проверки, способные сорвать сборку, выполняются до её начала:
    версия Python, наличие matter.min.js и WebView2 Runtime. Дешевле
    остановиться сразу, чем через десять минут получить .exe с пустым садом.

.PARAMETER NoLlm
    Собрать без llama-cpp-python. Результат легче на 100-300 МБ,
    приложение работает на резервных фразах.

.PARAMETER OneDir
    Собрать каталогом вместо одного файла. Запускается заметно быстрее:
    onefile при каждом старте распаковывает себя во временную папку.

.PARAMETER SkipInstall
    Пропустить установку зависимостей (повторная сборка).

.EXAMPLE
    .\build_windows.ps1
    .\build_windows.ps1 -NoLlm -OneDir
#>

[CmdletBinding()]
param(
    [switch]$NoLlm,
    [switch]$OneDir,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Write-Step  { param([string]$Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Warn  { param([string]$Text) Write-Host "  [!]  $Text" -ForegroundColor Yellow }

# --------------------------------------------------------------------------- #
# Проверки окружения
# --------------------------------------------------------------------------- #

Write-Step 'Проверка окружения'

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw 'Python не найден в PATH. Установи Python 3.10+ и повтори.'
}

$versionText = (& python -c "import sys; print('%d.%d' % sys.version_info[:2])").Trim()
$version = [version]$versionText
if ($version -lt [version]'3.10') {
    throw "Нужен Python 3.10 или новее, найден $versionText."
}
Write-Ok "Python $versionText"

$matterPath = Join-Path $PSScriptRoot 'static\js\vendor\matter.min.js'
if (-not (Test-Path $matterPath)) {
    Write-Warn 'static\js\vendor\matter.min.js отсутствует — в сборке не будет физики сада.'
    $answer = Read-Host '      Продолжить всё равно? (y/N)'
    if ($answer -notmatch '^[yY]') { throw 'Сборка отменена.' }
} else {
    Write-Ok 'matter.min.js на месте'
}

# WebView2 нужен не для сборки, а для запуска результата — предупреждаем заранее.
$webview2Keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
if ($webview2Keys | Where-Object { Test-Path $_ }) {
    Write-Ok 'WebView2 Runtime установлен'
} else {
    Write-Warn 'WebView2 Runtime не найден — собранный .exe откроет пустое окно на этой машине.'
}

# --------------------------------------------------------------------------- #
# Виртуальное окружение
# --------------------------------------------------------------------------- #

$venvPath = Join-Path $PSScriptRoot '.venv'
$venvPython = Join-Path $venvPath 'Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    Write-Step 'Создание виртуального окружения'
    & python -m venv $venvPath
    Write-Ok '.venv создано'
}

if (-not $SkipInstall) {
    Write-Step 'Установка зависимостей'
    & $venvPython -m pip install --upgrade pip --quiet
    & $venvPython -m pip install -r requirements.txt --quiet
    & $venvPython -m pip install pyinstaller pillow --quiet
    Write-Ok 'зависимости установлены'

    # llama-cpp-python намеренно не входит в requirements.txt: он собирается
    # из исходников и без MSVC Build Tools роняет установку всего остального.
    & $venvPython -c "import llama_cpp" 2>$null
    if ($LASTEXITCODE -eq 0 -and -not $NoLlm) {
        Write-Ok 'llama-cpp-python найден — войдёт в сборку'
    } elseif ($NoLlm) {
        Write-Warn 'llama-cpp-python исключён по флагу -NoLlm'
    } else {
        Write-Warn 'llama-cpp-python не установлен — сборка пойдёт с резервными фразами'
        Write-Host  '       Подключить: .\.venv\Scripts\pip install -r requirements-llm.txt'
    }
}

# --------------------------------------------------------------------------- #
# Иконка
# --------------------------------------------------------------------------- #

Write-Step 'Генерация иконки'
& $venvPython (Join-Path $PSScriptRoot 'tools\make_icon.py')

# --------------------------------------------------------------------------- #
# Сборка
# --------------------------------------------------------------------------- #

Write-Step 'Сборка PyInstaller'

$env:MYQUESTIFY_NO_LLM = if ($NoLlm)  { '1' } else { '' }
$env:MYQUESTIFY_ONEDIR = if ($OneDir) { '1' } else { '' }

foreach ($dir in @('build', 'dist')) {
    $full = Join-Path $PSScriptRoot $dir
    if (Test-Path $full) { Remove-Item $full -Recurse -Force }
}

& $venvPython -m PyInstaller MyQuestify.spec --noconfirm --clean

# --------------------------------------------------------------------------- #
# Результат
# --------------------------------------------------------------------------- #

$exePath = if ($OneDir) {
    Join-Path $PSScriptRoot 'dist\MyQuestify\MyQuestify.exe'
} else {
    Join-Path $PSScriptRoot 'dist\MyQuestify.exe'
}

if (-not (Test-Path $exePath)) {
    throw "Сборка завершилась, но файл не найден: $exePath"
}

$sizeMb = [math]::Round((Get-Item $exePath).Length / 1MB, 1)

Write-Step 'Готово'
Write-Host "  Файл:   $exePath"
Write-Host "  Размер: $sizeMb МБ"
Write-Host "  Данные: $env:LOCALAPPDATA\MyQuestify"
Write-Host ''
Write-Host '  Веса модели положить в: ' -NoNewline
Write-Host "$env:LOCALAPPDATA\MyQuestify\models\model.gguf" -ForegroundColor Yellow
Write-Host '  Каталог создаётся при первом запуске приложения.'
