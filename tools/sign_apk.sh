#!/usr/bin/env bash
#
# Выравнивание и подпись собранного приложения ключом выпуска.
#
# Вынесено в отдельный файл, потому что подписывать приходится дважды —
# базовый выпуск и выпуск с моделью. Повтор блока в описании сборки означал
# бы, что однажды правку внесут в одно место из двух, и два выпуска одной
# версии окажутся подписаны по-разному.
#
#   bash tools/sign_apk.sh вход.apk выход.apk
#
# Ключ и пароли берутся из окружения и в файлах не хранятся.

set -euo pipefail

IN="${1:?не указан входной файл}"
OUT="${2:?не указан выходной файл}"

: "${MYQUESTIFY_KEYSTORE:?путь к хранилищу ключей не задан}"
: "${MYQUESTIFY_STORE_PASSWORD:?пароль хранилища не задан}"
: "${MYQUESTIFY_KEY_ALIAS:?имя ключа не задано}"
: "${MYQUESTIFY_KEY_PASSWORD:?пароль ключа не задан}"

if [ ! -s "$IN" ]; then
    echo "::error::Нет файла для подписи: $IN"
    exit 1
fi

# Средства подписи лежат в наборе Android SDK, версий которого на машине
# сборки может оказаться несколько. Берётся старшая: младшие остаются от
# предыдущих образов и не знают новых схем подписи.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ]; then
    echo "::error::Не найден Android SDK: ANDROID_HOME не задан."
    exit 1
fi

BUILD_TOOLS=$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
BUILD_TOOLS="${BUILD_TOOLS%/}"

if [ -z "$BUILD_TOOLS" ]; then
    echo "::error::В $SDK нет каталога build-tools."
    exit 1
fi

echo "Средства сборки: $BUILD_TOOLS"

# Выравнивание выполняется до подписи, а не после. Схема подписи со второй
# версии охватывает файл целиком, и всякое изменение содержимого после
# подписи её ломает: приложение установится на старых устройствах и будет
# отвергнуто новыми.
"$BUILD_TOOLS/zipalign" -p -f 4 "$IN" "$IN.aligned"

"$BUILD_TOOLS/apksigner" sign \
    --ks "$MYQUESTIFY_KEYSTORE" \
    --ks-pass env:MYQUESTIFY_STORE_PASSWORD \
    --ks-key-alias "$MYQUESTIFY_KEY_ALIAS" \
    --key-pass env:MYQUESTIFY_KEY_PASSWORD \
    --out "$OUT" \
    "$IN.aligned"

rm -f "$IN.aligned"

# Подпись проверяется на месте. Отказ на устройстве выглядит как
# «Приложение не установлено» без указания причины, и разбираться с этим
# у пользователя нечем.
"$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$OUT"

FINGERPRINT=$("$BUILD_TOOLS/apksigner" verify --print-certs "$OUT" \
    | grep -i 'SHA-256 digest' | head -1 | awk '{print $NF}')

echo "Отпечаток ключа: $FINGERPRINT"

# Сверка с ожидаемым отпечатком. Смысл в том, что смена ключа между
# выпусками необратима: обновиться поверх установленного приложения будет
# нельзя, а прогресс пользователя лежит в хранилище приложения и уйдёт
# вместе с ним. Секрет RELEASE_CERT_SHA256 заполняется после первой
# успешной сборки — тем значением, которое напечатано выше.
if [ -n "${MYQUESTIFY_EXPECTED_CERT:-}" ]; then
    EXPECTED=$(echo "$MYQUESTIFY_EXPECTED_CERT" | tr 'A-Z' 'a-z' | tr -d ': ')
    ACTUAL=$(echo "$FINGERPRINT" | tr 'A-Z' 'a-z' | tr -d ': ')

    if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "::error::Подпись не совпадает с ожидаемой."
        echo "::error::Ожидался $EXPECTED, получен $ACTUAL."
        echo "::error::Выпуск с этим ключом не установится поверх прежнего."
        exit 1
    fi
    echo "Подпись совпадает с ожидаемой"
else
    echo "::warning::Секрет RELEASE_CERT_SHA256 не задан, сверка пропущена."
fi

echo "Подписано: $OUT"
