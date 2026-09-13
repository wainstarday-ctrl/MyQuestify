#!/usr/bin/env bash
#
# Проверка разрешений собранного приложения.
#
#   bash tools/check_permissions.sh путь/к/приложению.apk
#
# Зачем это нужно. Приложение заявляет, что не обращается к внешним службам.
# Утверждение проверяемое: приложение без доступа в сеть попросту не может
# её использовать, и в карточке каталога это видно каждому. Но набор
# разрешений в готовом файле складывается не только из нашего манифеста —
# в него вливаются манифесты всех подключённых библиотек. Достаточно
# обновить дополнение к оболочке, чтобы доступ в сеть появился сам собой,
# молча, и заметить это по исходным текстам было бы нельзя.
#
# Поэтому набор не вырезается, а сверяется: сборка обрывается и при лишнем
# разрешении, и при пропаже нужного. Второе не менее важно — исчезновение
# SCHEDULE_EXACT_ALARM не ломает приложение, а лишь переводит напоминания в
# неточный режим с задержкой до десятков минут. Такое не замечают месяцами.
#
# Проверка идёт по готовому файлу, а не по исходному манифесту: слияние
# выполняет Gradle, и его итог отличается от того, что написано у нас.

set -euo pipefail

APK="${1:?не указан файл приложения}"

if [ ! -s "$APK" ]; then
    echo "::error::Нет файла приложения: $APK"
    exit 1
fi

# --- Утверждённый набор ----------------------------------------------------
#
# Каждое разрешение здесь — осознанное решение, а не наследство сборки.
#
# POST_NOTIFICATIONS       напоминания о сроках; с Android 13 без него
#                          уведомления не показываются вовсе
# SCHEDULE_EXACT_ALARM     напоминание приходит в назначенную минуту; без
#                          него система доставляет его когда сочтёт нужным
# RECEIVE_BOOT_COMPLETED   назначенные напоминания система забывает при
#                          перезагрузке; плагин восстанавливает их сам
# WAKE_LOCK                разбудить устройство в момент напоминания
#
# Доступа в сеть в перечне нет намеренно: страница отдаётся перехватчиком
# оболочки из файлов приложения, обращаться наружу не к кому и незачем.
ALLOWED=(
    android.permission.POST_NOTIFICATIONS
    android.permission.SCHEDULE_EXACT_ALARM
    android.permission.RECEIVE_BOOT_COMPLETED
    android.permission.WAKE_LOCK
)

# --- Средство чтения манифеста --------------------------------------------

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

# aapt2 входит в состав средств сборки начиная с версии 26; старое aapt
# оставлено запасным путём на случай урезанного образа машины сборки.
if [ -x "$BUILD_TOOLS/aapt2" ]; then
    DUMP=$("$BUILD_TOOLS/aapt2" dump permissions "$APK")
elif [ -x "$BUILD_TOOLS/aapt" ]; then
    DUMP=$("$BUILD_TOOLS/aapt" dump permissions "$APK")
else
    echo "::error::В $BUILD_TOOLS нет ни aapt2, ни aapt."
    exit 1
fi

# Обе программы печатают строки вида:
#   uses-permission: name='android.permission.WAKE_LOCK'
# Кавычки у них расставлены по-разному, поэтому имя вырезается по образцу
# самого разрешения, а не по положению в строке.
FOUND=$(printf '%s\n' "$DUMP" \
    | grep -o "android\.permission\.[A-Z_0-9]*" \
    | sort -u)

echo "— разрешения в сборке —"
if [ -z "$FOUND" ]; then
    echo "(ни одного)"
else
    printf '%s\n' "$FOUND" | sed 's/^/  /'
fi

# --- Сверка ----------------------------------------------------------------

STATUS=0

is_allowed() {
    local NAME="$1"
    local ITEM
    for ITEM in "${ALLOWED[@]}"; do
        [ "$ITEM" = "$NAME" ] && return 0
    done
    return 1
}

while IFS= read -r NAME; do
    [ -z "$NAME" ] && continue
    if ! is_allowed "$NAME"; then
        echo "::error::Лишнее разрешение: $NAME"
        echo "::error::Его нет в утверждённом перечне tools/check_permissions.sh."
        echo "::error::Оно пришло из манифеста одной из библиотек при слиянии."
        echo "::error::Найти источник: mobile/android/app/build/outputs/logs/manifest-merger-*.txt"
        STATUS=1
    fi
done <<< "$FOUND"

for NAME in "${ALLOWED[@]}"; do
    if ! printf '%s\n' "$FOUND" | grep -qx "$NAME"; then
        echo "::error::Пропало разрешение: $NAME"
        echo "::error::Приложение соберётся и запустится, но напоминания"
        echo "::error::перестанут работать как задумано — отказ тихий."
        STATUS=1
    fi
done

if [ "$STATUS" -eq 0 ]; then
    echo "Набор разрешений совпадает с утверждённым: ${#ALLOWED[@]} шт., доступа в сеть нет."
fi

exit "$STATUS"
