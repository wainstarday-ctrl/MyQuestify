#!/usr/bin/env bash
#
# Подключение FreeDroidWarn к созданному проекту Android.
#
# Библиотека показывает пользователю однократное предупреждение о том, что
# Google вводит обязательную проверку личности разработчика для всех
# приложений на сертифицированных устройствах, включая устанавливаемые
# в обход магазина. Это позиция автора проекта, а не техническая
# необходимость: приложение работает и без неё.
#
# Скрипт выполняется на машине сборки после создания проекта оболочкой.
# Каталог mobile/android в репозитории не хранится — он создаётся заново
# при каждом запуске, поэтому правки вносятся здесь, а не руками.

set -euo pipefail

PROJECT=mobile/android
SETTINGS="$PROJECT/settings.gradle"
ROOT_GRADLE="$PROJECT/build.gradle"
APP_GRADLE="$PROJECT/app/build.gradle"

# Версия задана образцом, как в описании библиотеки. После первой сборки
# точный номер виден в журнале Gradle, и его стоит закрепить: подвижная
# версия означает, что две сборки одной метки могут получить разный код,
# а воспроизводимость сборки — требование сторонних репозиториев.
LIBRARY='com.github.woheller69:FreeDroidWarn:V1.+'

if [ ! -d "$PROJECT" ]; then
    echo "::error::Нет каталога $PROJECT — проект Android не создан."
    exit 1
fi

# --- Источник библиотеки -----------------------------------------------
#
# Где объявляются репозитории, зависит от версии оболочки: раньше это был
# блок allprojects в корневом build.gradle, теперь чаще
# dependencyResolutionManagement в settings.gradle. Второй вариант
# запрещает объявлять репозитории по проектам, поэтому определяется, какой
# из них действует, а не выбирается наугад.

if grep -q 'dependencyResolutionManagement' "$SETTINGS" 2>/dev/null; then
    echo "Репозитории объявлены в settings.gradle"

    awk '
        /dependencyResolutionManagement/ { inblock = 1 }
        inblock && !done && /repositories[[:space:]]*\{/ {
            print
            print "        maven { url \"https://jitpack.io\" }"
            done = 1
            next
        }
        { print }
    ' "$SETTINGS" > "$SETTINGS.new"

    mv "$SETTINGS.new" "$SETTINGS"
    TARGET="$SETTINGS"
else
    echo "Репозитории объявлены в build.gradle"

    cat >> "$ROOT_GRADLE" <<'GRADLE'

// Источник FreeDroidWarn. JitPack входит в перечень репозиториев, из
// которых F-Droid принимает готовые сборки, поэтому подключение здесь
// не мешает попаданию в сторонние хранилища.
allprojects {
    repositories {
        maven { url "https://jitpack.io" }
    }
}
GRADLE
    TARGET="$ROOT_GRADLE"
fi

grep -q 'jitpack.io' "$TARGET" \
    || { echo "::error::Не удалось добавить источник библиотеки"; exit 1; }

# --- Зависимость -------------------------------------------------------

awk -v lib="$LIBRARY" '
    /^dependencies[[:space:]]*\{/ && !done {
        print
        print "    implementation \"" lib "\""
        done = 1
        next
    }
    { print }
' "$APP_GRADLE" > "$APP_GRADLE.new"

mv "$APP_GRADLE.new" "$APP_GRADLE"

grep -q 'FreeDroidWarn' "$APP_GRADLE" \
    || { echo "::error::Не удалось добавить зависимость в $APP_GRADLE"; exit 1; }

# --- Вызов при запуске -------------------------------------------------
#
# Оболочка создаёт MainActivity пустым классом без onCreate. Файл
# переписывается целиком, а не правится: вставка метода в пустое тело
# выражением даёт сборку, которая компилируется и молча ничего не делает,
# и заметить это можно только на устройстве.

MAIN=$(find "$PROJECT/app/src/main/java" -name 'MainActivity.java' | head -1)

if [ -z "$MAIN" ]; then
    echo "::error::Не найден MainActivity.java."
    exit 1
fi

PACKAGE=$(grep -m1 '^package ' "$MAIN" | sed -E 's/^package[[:space:]]+(.*);/\1/')

if [ -z "$PACKAGE" ]; then
    echo "::error::Не удалось определить пакет в $MAIN"
    exit 1
fi

echo "Пакет приложения: $PACKAGE"

cat > "$MAIN" <<JAVA
package $PACKAGE;

import android.content.pm.PackageManager;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import org.woheller69.freeDroidWarn.FreeDroidWarn;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Номер сборки читается у системы, а не берётся из BuildConfig.
        // Начиная с восьмой версии средств сборки этот класс создаётся
        // только при явно включённой возможности, и её отсутствие
        // прерывало бы сборку на компиляции — с ошибкой, по которой
        // причина не читается.
        int versionCode = 0;
        try {
            versionCode = getPackageManager()
                    .getPackageInfo(getPackageName(), 0).versionCode;
        } catch (PackageManager.NameNotFoundException ignored) {
            // Собственный пакет находится всегда; ветка нужна компилятору.
        }

        // Предупреждение показывается один раз на выпуск, а не при каждом
        // запуске: библиотека сама помнит последний показанный номер.
        FreeDroidWarn.showWarningOnUpgrade(this, versionCode);
    }
}
JAVA

grep -q 'FreeDroidWarn.showWarningOnUpgrade' "$MAIN" \
    || { echo "::error::Не удалось записать вызов в $MAIN"; exit 1; }

echo "FreeDroidWarn подключён"
