#!/usr/bin/env bash
#
# Добавляет MyQuestify в меню приложений.
#
# Приложение работает и без этого: файл MyQuestify в этом каталоге
# запускается двойным щелчком или из терминала. Скрипт нужен лишь для того,
# чтобы значок появился в меню и в поиске по приложениям.
#
# Установка выполняется в домашний каталог пользователя, поэтому права
# администратора не требуются. Удаление — файлом uninstall, который скрипт
# создаёт рядом с собой.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="$APP_DIR/MyQuestify"
ICON="$APP_DIR/icon.png"

DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$DESKTOP_DIR/myquestify.desktop"

if [ ! -x "$BINARY" ]; then
    echo "Не найден запускаемый файл: $BINARY" >&2
    echo "Скрипт должен лежать рядом с приложением." >&2
    exit 1
fi

mkdir -p "$DESKTOP_DIR"

# Путь записывается полный и текущий: ярлык перестаёт работать, если
# каталог с приложением переместить, — тогда скрипт достаточно запустить
# заново с нового места.
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=MyQuestify
Comment=Задачи как приключение
Exec=$BINARY
Icon=$ICON
Terminal=false
Categories=Utility;Office;
StartupWMClass=MyQuestify
EOF

chmod +x "$DESKTOP_FILE"

# Часть окружений рабочего стола читает список приложений один раз при
# входе в систему. Обновление указателя избавляет от необходимости
# перезаходить, если такая команда в системе есть.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

cat > "$APP_DIR/uninstall.sh" <<EOF
#!/usr/bin/env bash
# Убирает MyQuestify из меню приложений. Сами файлы приложения и данные
# пользователя остаются на месте: каталог достаточно удалить вручную,
# данные лежат в \${XDG_DATA_HOME:-\$HOME/.local/share}/MyQuestify.
rm -f "$DESKTOP_FILE"
echo "Ярлык удалён."
EOF
chmod +x "$APP_DIR/uninstall.sh"

echo "Готово: MyQuestify добавлен в меню приложений."
echo "Данные приложения: ${XDG_DATA_HOME:-$HOME/.local/share}/MyQuestify"
