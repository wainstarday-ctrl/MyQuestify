#!/usr/bin/env bash
#
# Запускает все проверки проекта одной командой.
#
# Тот же набор и тот же порядок, что в tools/check_all.ps1 и в файлах
# сборок: от общих проверок к частным. Два скрипта вместо одного, потому
# что PowerShell не входит в поставку macOS, а разработка ведётся на
# Windows — держать один вариант означало бы, что на одной из систем
# проверки запускаются вручную по строчке.
#
# Первая неудача не прерывает остальные: отчёт выводится целиком, потому
# что чинить обычно приходится не одну вещь.
#
# Использование:
#     ./tools/check_all.sh
#     ./tools/check_all.sh --skip-python   # только клиентская часть
#
# Код возврата — число не прошедших проверок.

set -uo pipefail

SKIP_PYTHON=0
for arg in "$@"; do
    case "$arg" in
        --skip-python) SKIP_PYTHON=1 ;;
        -h|--help)
            sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *)
            echo "Неизвестный ключ: $arg" >&2
            exit 2 ;;
    esac
done

# Каталог проекта, а не текущий: скрипт должен работать при запуске как из
# корня, так и из tools.
cd "$(dirname "$0")/.."

GREEN=$'\033[32m'; RED=$'\033[31m'; CYAN=$'\033[36m'; DIM=$'\033[2m'; OFF=$'\033[0m'

FAILED=()
SKIPPED=0
TOTAL=0

run_check() {
    local needs_python="$1"; shift
    local name="$1"; shift

    TOTAL=$(( TOTAL + 1 ))

    if [[ $needs_python -eq 1 && $SKIP_PYTHON -eq 1 ]]; then
        printf '  %s·  %s — пропущено%s\n' "$DIM" "$name" "$OFF"
        SKIPPED=$(( SKIPPED + 1 ))
        return
    fi

    printf '\n%s── %s%s\n' "$CYAN" "$name" "$OFF"

    if "$@"; then
        printf '  %s✓ прошло%s\n' "$GREEN" "$OFF"
    else
        printf '  %s✗ не прошло%s\n' "$RED" "$OFF"
        FAILED+=("$name")
    fi
}

run_check 1 'Правила экономики, каталог сцен, маршруты' \
    python3 -m pytest tests/ -q
run_check 1 'Совпадение защитных фильтров двух версий' \
    python3 tools/check_safety_parity.py
run_check 0 'Запуск интерфейса без браузера' \
    node tools/smoke_test.js
run_check 0 'Нагрузка сцены на холст' \
    node tools/bench_clouds.js
run_check 0 'Профили отрисовки и останов цикла кадров' \
    node tools/check_stage_profile.js
run_check 0 'Записи мобильного хранилища' \
    node tools/check_local_api.js

echo
printf '%s\n' '────────────────────────────────────────────────────────────'

if [[ ${#FAILED[@]} -eq 0 ]]; then
    printf '%sВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (%d из %d)%s\n' \
        "$GREEN" "$(( TOTAL - SKIPPED ))" "$TOTAL" "$OFF"
    [[ $SKIPPED -gt 0 ]] && printf '%sПропущено по ключу --skip-python: %d%s\n' \
        "$DIM" "$SKIPPED" "$OFF"
    exit 0
fi

printf '%sНЕ ПРОШЛИ ПРОВЕРКИ: %d%s\n' "$RED" "${#FAILED[@]}" "$OFF"
for name in "${FAILED[@]}"; do
    printf '%s  • %s%s\n' "$RED" "$name" "$OFF"
done
exit "${#FAILED[@]}"
