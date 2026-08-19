<#
.SYNOPSIS
    Сборка выпусков MyQuestify для публикации.

.DESCRIPTION
    Готовит архивы, которые прикладываются к выпуску на GitHub. Собираются
    две разновидности, поскольку они решают разные задачи:

      * лёгкая  — только приложение, около 40 МБ. Подходит для быстрой
        загрузки; языковая модель подключается пользователем позже.
      * полная  — приложение вместе с весами модели, около 1.2 ГБ. Работает
        сразу после распаковки, без установки и без сети.

    Модель не встраивается в исполняемый файл, а кладётся рядом. Встраивание
    увеличило бы время запуска на распаковку гигабайта во временный каталог
    при каждом открытии приложения.

.PARAMETER WithModel
    Собрать также полный выпуск. Требует файла models\model.gguf.

.PARAMETER SkipBuild
    Не пересобирать приложение, использовать содержимое dist. Полезно, когда
    сборка уже выполнена, а требуется только переупаковать архивы.

.EXAMPLE
    .\tools\make_release.ps1
    .\tools\make_release.ps1 -WithModel
#>

[CmdletBinding()]
param(
    [switch]$WithModel,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step { param([string]$Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  [!]  $Text" -ForegroundColor Yellow }

# --------------------------------------------------------------------------- #
# Версия берётся из конфигурации: имя архива должно совпадать с тем, что
# приложение сообщает о себе в журнале, иначе при разборе жалоб непонятно,
# какая именно сборка запущена.
# --------------------------------------------------------------------------- #

Write-Step 'Определение версии'

$configText = Get-Content 'app\config.py' -Raw
if ($configText -notmatch 'APP_VERSION:\s*Final\[str\]\s*=\s*"([^"]+)"') {
    throw 'Не удалось прочитать APP_VERSION из app\config.py'
}
$version = $Matches[1]
Write-Ok "версия $version"

$releaseDir = Join-Path $root 'release'
if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force }
New-Item -ItemType Directory -Path $releaseDir | Out-Null

# --------------------------------------------------------------------------- #
# Проверки, невыполнение которых обесценивает готовый архив
# --------------------------------------------------------------------------- #

Write-Step 'Проверка исходного состояния'

$matter = 'static\js\vendor\matter.min.js'
if (-not (Test-Path $matter) -or (Get-Item $matter).Length -eq 0) {
    throw "Отсутствует $matter. Без него интерактивные сцены не работают, а обнаружится это только у пользователя."
}
Write-Ok 'matter.min.js на месте'

# Проверка запуска интерфейса: синтаксический контроль не находит ошибок
# времени выполнения, из-за которых приложение открывается и остаётся на
# экране загрузки.
if (Get-Command node -ErrorAction SilentlyContinue) {
    & node tools\smoke_test.js | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Проверка запуска интерфейса не пройдена. Запустите: node tools\smoke_test.js'
    }
    Write-Ok 'проверка запуска пройдена'
} else {
    Write-Warn 'Node.js не найден — проверка запуска пропущена'
}

# --------------------------------------------------------------------------- #
# Сборка приложения
# --------------------------------------------------------------------------- #

if (-not $SkipBuild) {
    Write-Step 'Сборка приложения'
    # Режим отдельного каталога выбран сознательно: сборка одним файлом при
    # каждом запуске распаковывает себя во временный каталог, и первый старт
    # занимает от пяти до десяти секунд.
    & "$root\build_windows.ps1" -OneDir
    if ($LASTEXITCODE -ne 0) { throw 'Сборка завершилась с ошибкой' }
}

$appDir = Join-Path $root 'dist\MyQuestify'
if (-not (Test-Path $appDir)) {
    throw "Каталог сборки не найден: $appDir"
}
Write-Ok 'приложение собрано'

# --------------------------------------------------------------------------- #
# Лёгкий выпуск
# --------------------------------------------------------------------------- #

Write-Step 'Лёгкий выпуск'

$liteDir = Join-Path $releaseDir "MyQuestify-$version-windows"
Copy-Item $appDir $liteDir -Recurse

# Краткая записка кладётся рядом с приложением: пользователь, распаковавший
# архив, не пойдёт читать репозиторий, а вопрос про WebView2 возникнет у
# каждого, у кого его нет.
@"
MyQuestify $version — версия для Windows 10 и 11

ЗАПУСК
  Откройте MyQuestify.exe

ЕСЛИ ОКНО ОТКРЫЛОСЬ ЧЁРНЫМ
  В системе нет компонента Microsoft Edge WebView2. Установите его:
  https://developer.microsoft.com/microsoft-edge/webview2/
  Выберите "Evergreen Standalone Installer".
  На Windows 11 компонент установлен изначально.

ЯЗЫКОВАЯ МОДЕЛЬ
  В этот выпуск веса модели не входят. Без них приложение работает
  полностью, а вместо генерации показывает заготовленные фразы.

  Чтобы подключить модель, скачайте файл GGUF и положите его как:
    %LOCALAPPDATA%\MyQuestify\models\model.gguf

  Проверялась модель Vikhr-Qwen-2.5-1.5B-Instruct, квантование Q4_K_M:
  https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF

  Каталог создаётся при первом запуске приложения.

ГДЕ ХРАНЯТСЯ ДАННЫЕ
  %LOCALAPPDATA%\MyQuestify
  Там же журнал работы: myquestify.log
"@ | Set-Content (Join-Path $liteDir 'ПРОЧТИ_МЕНЯ.txt') -Encoding UTF8

$liteZip = Join-Path $releaseDir "MyQuestify-$version-windows.zip"
Compress-Archive -Path "$liteDir\*" -DestinationPath $liteZip -CompressionLevel Optimal
Remove-Item $liteDir -Recurse -Force

$liteMb = [math]::Round((Get-Item $liteZip).Length / 1MB, 1)
Write-Ok "$([System.IO.Path]::GetFileName($liteZip)) — $liteMb МБ"

# --------------------------------------------------------------------------- #
# Полный выпуск
# --------------------------------------------------------------------------- #

if ($WithModel) {
    Write-Step 'Полный выпуск с моделью'

    $model = Join-Path $root 'models\model.gguf'
    if (-not (Test-Path $model)) {
        throw "Не найден models\model.gguf. Положите веса модели в каталог models."
    }

    $modelMb = [math]::Round((Get-Item $model).Length / 1MB, 0)
    Write-Ok "модель найдена — $modelMb МБ"

    $fullDir = Join-Path $releaseDir "MyQuestify-$version-windows-with-model"
    Copy-Item $appDir $fullDir -Recurse

    # Модель кладётся рядом с приложением, а не внутрь него: приложение
    # переносит её в каталог данных при первом запуске, и повторная
    # распаковка гигабайта при каждом старте не требуется.
    New-Item -ItemType Directory -Path (Join-Path $fullDir 'models') | Out-Null
    Copy-Item $model (Join-Path $fullDir 'models\model.gguf')

    @"
MyQuestify $version — версия для Windows 10 и 11, с языковой моделью

ЗАПУСК
  Откройте MyQuestify.exe

  При первом запуске приложение перенесёт файл models\model.gguf в свой
  каталог данных. Это занимает несколько секунд и происходит один раз.

ЕСЛИ ОКНО ОТКРЫЛОСЬ ЧЁРНЫМ
  В системе нет компонента Microsoft Edge WebView2. Установите его:
  https://developer.microsoft.com/microsoft-edge/webview2/
  Выберите "Evergreen Standalone Installer".

О МОДЕЛИ
  Vikhr-Qwen-2.5-1.5B-Instruct, квантование Q4_K_M.
  Работает на процессоре, сети не требует, данные никуда не передаёт.
  Первый ответ занимает несколько секунд: модель читается с диска.

  Условия использования модели: Apache License 2.0.
  https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF

ТРЕБОВАНИЯ
  Оперативная память: не менее 4 ГБ, из них около 2 ГБ занимает модель.

ГДЕ ХРАНЯТСЯ ДАННЫЕ
  %LOCALAPPDATA%\MyQuestify
"@ | Set-Content (Join-Path $fullDir 'ПРОЧТИ_МЕНЯ.txt') -Encoding UTF8

    $fullZip = Join-Path $releaseDir "MyQuestify-$version-windows-with-model.zip"
    Write-Host '  упаковка около гигабайта, это займёт несколько минут…'
    Compress-Archive -Path "$fullDir\*" -DestinationPath $fullZip -CompressionLevel Optimal
    Remove-Item $fullDir -Recurse -Force

    $fullMb = [math]::Round((Get-Item $fullZip).Length / 1MB, 0)
    Write-Ok "$([System.IO.Path]::GetFileName($fullZip)) — $fullMb МБ"

    if ($fullMb -gt 2000) {
        Write-Warn 'Архив превышает 2 ГБ — GitHub не примет его в выпуск.'
        Write-Warn 'Разделите архив или выложите модель отдельной ссылкой.'
    }
}

# --------------------------------------------------------------------------- #
# Итог
# --------------------------------------------------------------------------- #

Write-Step 'Готово'
Get-ChildItem $releaseDir -Filter *.zip | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 1)
    Write-Host ("  {0,-52} {1,8} МБ" -f $_.Name, $mb)
}

Write-Host "`n  Каталог: $releaseDir"
Write-Host '  Эти архивы прикладываются к выпуску на GitHub.'
Write-Host '  Перед публикацией проверьте архив на другом компьютере.'
