<#
.SYNOPSIS
    Запускает все проверки проекта одной командой.

.DESCRIPTION
    Те же шесть наборов, что выполняются в каждой из трёх сборок на машине
    GitHub. Смысл отдельного скрипта — возможность прогнать их у себя за
    несколько секунд, не дожидаясь сборки и не вспоминая шесть команд.

    Проверки перечислены в том же порядке, что и в файлах сборок: от самых
    быстрых и общих к частным. Первая же неудача не прерывает остальные —
    отчёт выводится целиком, потому что чинить обычно приходится не одну
    вещь, и знать сразу обо всех полезнее.

    Возвращает 0, если прошли все, иначе число неудач.

.PARAMETER SkipPython
    Пропустить проверки на Python. Пригодится, если в окружении нет
    зависимостей сервера, а изменения касались только клиентской части.

.EXAMPLE
    .\tools\check_all.ps1

.EXAMPLE
    .\tools\check_all.ps1 -SkipPython
#>

[CmdletBinding()]
param(
    [switch]$SkipPython
)

Set-StrictMode -Version Latest

# Каталог проекта, а не текущий: скрипт должен работать при запуске
# как из корня, так и из tools.
$root = Split-Path -Parent $PSScriptRoot
Set-Location -Path $root

$checks = @(
    @{ Name = 'Правила экономики, каталог сцен, маршруты'
       Cmd  = 'python'; Args = @('-m', 'pytest', 'tests/', '-q'); Python = $true },

    @{ Name = 'Совпадение защитных фильтров двух версий'
       Cmd  = 'python'; Args = @('tools/check_safety_parity.py'); Python = $true },

    @{ Name = 'Запуск интерфейса без браузера'
       Cmd  = 'node'; Args = @('tools/smoke_test.js'); Python = $false },

    @{ Name = 'Нагрузка сцены на холст'
       Cmd  = 'node'; Args = @('tools/bench_clouds.js'); Python = $false },

    @{ Name = 'Профили отрисовки и останов цикла кадров'
       Cmd  = 'node'; Args = @('tools/check_stage_profile.js'); Python = $false },

    @{ Name = 'Записи мобильного хранилища'
       Cmd  = 'node'; Args = @('tools/check_local_api.js'); Python = $false }
)

$failed = @()
$skipped = 0

foreach ($check in $checks) {
    if ($SkipPython -and $check.Python) {
        Write-Host ('  ·  {0} — пропущено' -f $check.Name) -ForegroundColor DarkGray
        $skipped += 1
        continue
    }

    Write-Host ''
    Write-Host ('── {0}' -f $check.Name) -ForegroundColor Cyan

    & $check.Cmd @($check.Args)

    if ($LASTEXITCODE -ne 0) {
        $failed += $check.Name
        Write-Host ('  ✗ не прошло' -f $check.Name) -ForegroundColor Red
    } else {
        Write-Host '  ✓ прошло' -ForegroundColor Green
    }
}

Write-Host ''
Write-Host ('─' * 60)

if ($failed.Count -eq 0) {
    $done = $checks.Count - $skipped
    Write-Host ('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ({0} из {1})' -f $done, $checks.Count) `
        -ForegroundColor Green
    if ($skipped -gt 0) {
        Write-Host ('Пропущено по ключу -SkipPython: {0}' -f $skipped) -ForegroundColor DarkGray
    }
    exit 0
}

Write-Host ('НЕ ПРОШЛИ ПРОВЕРКИ: {0}' -f $failed.Count) -ForegroundColor Red
foreach ($name in $failed) {
    Write-Host ('  • {0}' -f $name) -ForegroundColor Red
}
exit $failed.Count
