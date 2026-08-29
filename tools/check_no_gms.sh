#!/usr/bin/env bash
#
# Проверка отсутствия служб Google в мобильной сборке.
#
# Приложение объявлено полностью офлайновым, и это утверждение должно
# проверяться, а не повторяться в описании. Служба уведомлений или сбора
# сведений о сбоях приходит не из кода, а зависимостью дополнения к
# оболочке: достаточно поставить один пакет, чтобы в приложении оказалась
# библиотека, обращающаяся к сети при запуске. По исходникам это не видно.
#
# Проверка нужна и для стороннего распространения: репозитории свободных
# приложений отказывают приложениям с несвободными зависимостями, и узнать
# об этом лучше на своей сборке, чем в ответе на заявку.

set -euo pipefail

PROJECT=mobile/android

if [ ! -d "$PROJECT" ]; then
    echo "::error::Нет каталога $PROJECT — проект Android не создан."
    exit 1
fi

# Перечень намеренно грубый. Ложное срабатывание стоит одной правки в этом
# файле, пропуск — несвободной зависимости в выпуске, который уже раздан.
PATTERN='play-services|com\.google\.android\.gms|firebase|crashlytics|com\.google\.mlkit|billingclient'

FOUND=0

echo "— дерево зависимостей —"

DEPS=$(mktemp)
(
    cd "$PROJECT"
    chmod +x gradlew
    ./gradlew --no-daemon -q :app:dependencies \
        --configuration releaseRuntimeClasspath
) > "$DEPS"

if grep -Eiq "$PATTERN" "$DEPS"; then
    echo "::error::В зависимостях выпуска найдены службы Google:"
    grep -Ei "$PATTERN" "$DEPS" | sed 's/^/  /' | sort -u
    FOUND=1
else
    echo "чисто"
fi

echo "— файлы сборки —"

# Подключение может быть записано и прямо, минуя дерево: строкой в
# build.gradle или дополнением, которое само правит файлы проекта.
if grep -REiq "$PATTERN" "$PROJECT"/build.gradle "$PROJECT"/app/build.gradle \
        "$PROJECT"/app/src/main/AndroidManifest.xml 2>/dev/null; then
    echo "::error::В файлах проекта найдены упоминания служб Google:"
    grep -REin "$PATTERN" "$PROJECT"/build.gradle "$PROJECT"/app/build.gradle \
        "$PROJECT"/app/src/main/AndroidManifest.xml 2>/dev/null | sed 's/^/  /'
    FOUND=1
else
    echo "чисто"
fi

echo "— файл служб —"

# google-services.json появляется при подключении Firebase через мастер
# Android Studio и тянет за собой дополнение к сборке.
if find "$PROJECT" -name 'google-services.json' -print -quit | grep -q .; then
    echo "::error::Найден google-services.json."
    FOUND=1
else
    echo "чисто"
fi

rm -f "$DEPS"

if [ "$FOUND" -ne 0 ]; then
    echo "::error::Проверка не пройдена: приложение перестало быть офлайновым."
    exit 1
fi

echo "Служб Google в сборке нет"
