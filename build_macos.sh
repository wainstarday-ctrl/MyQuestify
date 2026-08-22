#!/usr/bin/env bash
#
# Сборка MyQuestify для macOS.
#
# Результат — MyQuestify.app в каталоге dist. В macOS приложение это не
# отдельный файл, а каталог определённой структуры, который система
# показывает как единый значок.
#
# Запуск из корня проекта:
#     chmod +x build_macos.sh
#     ./build_macos.sh
#
# Ключи:
#     --no-llm      собрать без пакета инференса (легче на 100–300 МБ)
#     --skip-deps   не переустанавливать зависимости
#     --dmg         дополнительно собрать образ диска для раздачи

set -euo pipefail

cd "$(dirname "$0")"

NO_LLM=0
SKIP_DEPS=0
MAKE_DMG=0

for arg in "$@"; do
    case "$arg" in
        --no-llm)    NO_LLM=1 ;;
        --skip-deps) SKIP_DEPS=1 ;;
        --dmg)       MAKE_DMG=1 ;;
        *) echo "Неизвестный ключ: $arg" >&2; exit 1 ;;
    esac
done

step() { printf '\n\033[36m=== %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m[ok]\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m[!]\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31m[x]\033[0m  %s\n' "$1" >&2; exit 1; }

# --------------------------------------------------------------------------- #
# Проверки, без которых собранное приложение окажется неработоспособным
# --------------------------------------------------------------------------- #

step 'Проверка окружения'

[[ "$(uname)" == "Darwin" ]] || fail 'Скрипт предназначен для macOS.'

command -v python3 >/dev/null || fail 'Python 3 не найден.'
PY_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
ok "Python $PY_VERSION"

# Готовые сборки пакета инференса существуют не для всех версий языка.
# Предупреждение выводится заранее: обнаружить это на этапе установки
# значит потратить время на скачивание впустую.
case "$PY_VERSION" in
    3.9|3.10|3.11|3.12) ;;
    *) warn "Для Python $PY_VERSION готовых сборок llama-cpp-python может не быть." ;;
esac

MATTER='static/js/vendor/matter.min.js'
[[ -s "$MATTER" ]] || fail "Отсутствует $MATTER. Без него интерактивные сцены не работают."
ok 'matter.min.js на месте'

if command -v node >/dev/null; then
    node tools/smoke_test.js >/dev/null || fail 'Проверка запуска интерфейса не пройдена.'
    ok 'проверка запуска пройдена'
else
    warn 'Node.js не найден — проверка запуска пропущена'
fi

# --------------------------------------------------------------------------- #
# Окружение и зависимости
# --------------------------------------------------------------------------- #

if [[ $SKIP_DEPS -eq 0 ]]; then
    step 'Зависимости'

    [[ -d .venv ]] || python3 -m venv .venv
    source .venv/bin/activate

    python3 -m pip install --upgrade pip --quiet
    pip install -r requirements.txt --quiet
    ok 'основные зависимости установлены'

    if [[ $NO_LLM -eq 0 ]]; then
        # Отдельная установка: неудача не должна отменять всё остальное.
        # На процессорах Apple готовые сборки собираются с поддержкой Metal,
        # но работают и без графического ускорителя.
        if pip install llama-cpp-python --only-binary=:all: --quiet; then
            ok 'llama-cpp-python установлен'
        else
            warn 'llama-cpp-python установить не удалось.'
            warn 'Приложение будет работать на резервных фразах.'
        fi
    fi

    pip install pyinstaller --quiet
    ok 'pyinstaller установлен'
else
    # Окружение активируется, только если оно есть. На машине сборки его не
    # создают: зависимости ставятся глобально отдельным шагом, и попытка
    # активации несуществующего каталога прерывала бы сборку.
    if [[ -f .venv/bin/activate ]]; then
        source .venv/bin/activate
        ok 'используется окружение .venv'
    else
        ok 'окружение не найдено, используется системный Python'
    fi
fi

# --------------------------------------------------------------------------- #
# Значок приложения
# --------------------------------------------------------------------------- #

step 'Значок'

# macOS требует значок в формате icns — набор изображений разного размера
# в одном файле. Система выбирает подходящее по месту показа: в Dock,
# в списке файлов, в окне сведений.
if [[ ! -f assets/icon.icns ]]; then
    if python3 -c 'import PIL' 2>/dev/null; then
        # Вывод не подавляется: при неудаче предупреждение «значок не создан»
        # само по себе ничего не объясняет, а причина остаётся невидимой.
        python3 tools/make_icon.py || warn 'скрипт значка завершился с ошибкой'

        if [[ -f assets/icon.png ]]; then
            ICONSET='assets/icon.iconset'
            rm -rf "$ICONSET"
            mkdir -p "$ICONSET"

            for size in 16 32 128 256 512; do
                sips -z $size $size assets/icon.png \
                    --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
                double=$((size * 2))
                sips -z $double $double assets/icon.png \
                    --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
            done

            iconutil -c icns "$ICONSET" -o assets/icon.icns
            rm -rf "$ICONSET"
            ok 'значок создан'
        else
            warn 'assets/icon.png не создан — приложение получит значок по умолчанию'
        fi
    else
        warn 'Pillow не установлен — приложение получит значок по умолчанию'
    fi
else
    ok 'значок уже существует'
fi

# --------------------------------------------------------------------------- #
# Сборка
# --------------------------------------------------------------------------- #

step 'Сборка приложения'

rm -rf build dist

# Ключ значка добавляется отдельной переменной, а не элементом массива.
# В macOS используется оболочка версии 3.2, где раскрытие пустого массива
# при включённой проверке необъявленных переменных считается обращением к
# необъявленной и прерывает выполнение.
ICON_ARG=''
[[ -f assets/icon.icns ]] && ICON_ARG='--icon assets/icon.icns'

# Ключ --windowed создаёт приложение без окна терминала. Сжатие UPX
# отключено: оно повреждает нативные библиотеки llama.cpp и вызывает
# ложные срабатывания средств защиты.
pyinstaller \
    --name MyQuestify \
    --windowed \
    --noconfirm \
    --clean \
    --noupx \
    $ICON_ARG \
    --add-data 'static:static' \
    --add-data 'templates:templates' \
    --osx-bundle-identifier com.myquestify.app \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan.on \
    --hidden-import aiosqlite \
    run.py

[[ -d dist/MyQuestify.app ]] || fail 'Приложение не собрано.'
ok 'dist/MyQuestify.app'

# --------------------------------------------------------------------------- #
# Сведения о приложении
# --------------------------------------------------------------------------- #

step 'Сведения о приложении'

PLIST='dist/MyQuestify.app/Contents/Info.plist'

# Название на русском в меню и в сведениях о файле.
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string MyQuestify' "$PLIST" 2>/dev/null || true

# Приложение хранит данные пользователя, поэтому запрет на резервное
# копирование не выставляется: потеря списка задач при переносе на новую
# машину была бы неприятной неожиданностью.
/usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$PLIST" 2>/dev/null || true

# Приложение работает только с локальным сервером на петлевом интерфейсе.
# Без этого разрешения система запретила бы соединение как незащищённое.
/usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity dict' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true' "$PLIST" 2>/dev/null || true

ok 'Info.plist дополнен'

# --------------------------------------------------------------------------- #
# Образ диска
# --------------------------------------------------------------------------- #

if [[ $MAKE_DMG -eq 1 ]]; then
    step 'Образ диска'

    VERSION="$(python3 -c 'import sys; sys.path.insert(0, "."); from app.config import APP_VERSION; print(APP_VERSION)')"
    DMG="dist/MyQuestify-${VERSION}-macos.dmg"
    STAGE='dist/dmg'

    rm -rf "$STAGE"
    mkdir -p "$STAGE"
    cp -R dist/MyQuestify.app "$STAGE/"

    # Ссылка на каталог программ: принятый способ установки в macOS —
    # перетаскивание значка на неё.
    ln -s /Applications "$STAGE/Applications"

    hdiutil create -volname 'MyQuestify' -srcfolder "$STAGE" \
        -ov -format UDZO "$DMG" >/dev/null
    rm -rf "$STAGE"

    ok "$DMG ($(du -h "$DMG" | cut -f1))"
fi

# --------------------------------------------------------------------------- #
# Итог
# --------------------------------------------------------------------------- #

step 'Готово'

SIZE="$(du -sh dist/MyQuestify.app | cut -f1)"
echo "  dist/MyQuestify.app — $SIZE"
echo
echo '  Запуск: open dist/MyQuestify.app'
echo
warn 'Приложение не подписано сертификатом разработчика.'
warn 'При первом открытии система сообщит, что автор не подтверждён.'
warn 'Обход: правая кнопка по значку → «Открыть» → «Открыть» в диалоге.'
warn 'Подтверждение требуется один раз.'
