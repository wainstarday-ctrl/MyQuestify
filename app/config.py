"""Централизованная конфигурация MyQuestify.

Ключевое разделение — **ресурсы** и **данные**:

* ``RESOURCE_DIR`` — только для чтения: HTML, CSS, JS, вендорные библиотеки.
  В режиме разработки это корень репозитория, внутри собранного ``.exe`` —
  временный каталог распаковки PyInstaller (``sys._MEIPASS``), который
  очищается при выходе из приложения.
* ``DATA_DIR`` — запись разрешена: база, загруженные фоны, веса модели, лог.
  В разработке совпадает с корнем проекта (поэтому путь к модели остаётся
  ``./models/model.gguf``, как требует ТЗ), в собранной версии уезжает в
  ``%LOCALAPPDATA%\\MyQuestify``.

Без этого разделения приложение падало бы при первой же записи в БД после
упаковки: SQLite не может открыть файл в каталоге распаковки на запись, а
даже если бы смог — данные исчезали бы после закрытия окна.

Модуль намеренно не импортирует ничего из проекта: его читают и ``app.main``,
и ``run.py``, и spec-файл сборки.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Final

APP_NAME: Final[str] = "MyQuestify"

# Версия сборки. Выводится в журнал при запуске и доступна в /api/health,
# что позволяет убедиться, какая именно копия приложения запущена.
APP_VERSION: Final[str] = "1.7.0"

# --------------------------------------------------------------------------- #
# Определение режима запуска
# --------------------------------------------------------------------------- #

IS_FROZEN: Final[bool] = bool(getattr(sys, "frozen", False))
IS_WINDOWS: Final[bool] = sys.platform.startswith("win")
IS_MACOS: Final[bool] = sys.platform == "darwin"
IS_LINUX: Final[bool] = sys.platform.startswith("linux")


def _resolve_resource_dir() -> Path:
    """Возвращает каталог с неизменяемыми ресурсами приложения."""
    if IS_FROZEN:
        # onefile: PyInstaller распаковывает данные в sys._MEIPASS.
        # onedir: _MEIPASS отсутствует, ресурсы лежат рядом с исполняемым файлом.
        meipass = getattr(sys, "_MEIPASS", None)
        return Path(meipass) if meipass else Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _resolve_data_dir() -> Path:
    """Возвращает каталог для пользовательских данных с правом записи.

    В собранной версии используется профиль пользователя — это единственное
    место, куда приложение гарантированно может писать и при установке в
    ``Program Files``, и при запуске без прав администратора.
    """
    if not IS_FROZEN:
        return Path(__file__).resolve().parent.parent

    if IS_WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        root = Path(base) if base else Path.home() / "AppData" / "Local"
    elif IS_MACOS:
        # Принятое в macOS место для данных приложения. Каталог не скрыт и
        # попадает в резервные копии Time Machine, в отличие от скрытых
        # путей, куда система резервирование не распространяет.
        root = Path.home() / "Library" / "Application Support"
    else:
        # Linux и прочие: путь по соглашению XDG.
        root = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))

    return root / APP_NAME


RESOURCE_DIR: Final[Path] = _resolve_resource_dir()
DATA_DIR: Final[Path] = _resolve_data_dir()

# Совместимость с прежним именем — используется в скриптах сборки.
BASE_DIR: Final[Path] = RESOURCE_DIR

# --------------------------------------------------------------------------- #
# Ресурсы (только чтение)
# --------------------------------------------------------------------------- #

STATIC_DIR: Final[Path] = RESOURCE_DIR / "static"
TEMPLATES_DIR: Final[Path] = RESOURCE_DIR / "templates"
ASSETS_DIR: Final[Path] = RESOURCE_DIR / "assets"

INDEX_FILE: Final[Path] = TEMPLATES_DIR / "index.html"
ICON_FILE: Final[Path] = ASSETS_DIR / "icon.ico"

# --------------------------------------------------------------------------- #
# Данные (чтение и запись)
# --------------------------------------------------------------------------- #

UPLOADS_DIR: Final[Path] = DATA_DIR / "uploads"
MODELS_DIR: Final[Path] = DATA_DIR / "models"
LOG_FILE: Final[Path] = DATA_DIR / "myquestify.log"

DB_PATH: Final[Path] = DATA_DIR / "myquestify.db"
# as_posix() обязателен: в URL SQLAlchemy обратные слэши Windows ломают парсинг.
DATABASE_URL: Final[str] = f"sqlite+aiosqlite:///{DB_PATH.as_posix()}"

# URL-префикс для загруженных фонов. Отдельный от /static, потому что каталог
# загрузок физически лежит вне ресурсов приложения.
MEDIA_URL_PREFIX: Final[str] = "/media"

# --------------------------------------------------------------------------- #
# Локальная языковая модель (llama-cpp-python)
# --------------------------------------------------------------------------- #

LLM_MODEL_PATH: Final[Path] = MODELS_DIR / "model.gguf"

# Формат промпта. Разные семейства моделей размечают диалог по-разному, и
# промпт в чужом формате модель понимает как обычный текст: она отвечает
# невпопад, дописывает реплики за пользователя или уходит в повтор.
#
# "auto" — определить по имени файла и метаданным GGUF (см. app.prompt_formats).
# Явное значение задаётся, если автоопределение ошиблось.
LLM_PROMPT_FORMAT: Final[str] = "auto"

# Модель, на которой проект разрабатывался и проверялся.
# Vikhr-Qwen-2.5-1.5B-Instruct, квантование Q4_K_M (~1.1 ГБ):
# https://huggingface.co/Vikhrmodels/Vikhr-Qwen-2.5-1.5B-Instruct-GGUF
REFERENCE_MODEL: Final[dict] = {
    "name": "Vikhr-Qwen-2.5-1.5B-Instruct",
    "file": "Vikhr-Qwen-2.5-1.5b-Instruct-Q4_K_M.gguf",
    "format": "chatml",
    "url": (
        "https://huggingface.co/Vikhrmodels/"
        "Vikhr-Qwen-2.5-1.5B-Instruct-GGUF"
    ),
    "note": (
        "Дообучена под русский язык на базе Qwen2.5. Авторы рекомендуют "
        "температуру около 0.3."
    ),
}
LLM_N_CTX: Final[int] = 512
LLM_N_BATCH: Final[int] = 64
LLM_N_GPU_LAYERS: Final[int] = 0  # строго CPU-инференс
LLM_N_THREADS: Final[int] = max(1, (os.cpu_count() or 2) // 2)
LLM_MAX_TOKENS: Final[int] = 48
LLM_TEMPERATURE: Final[float] = 0.8

# --------------------------------------------------------------------------- #
# Игровая экономика
# --------------------------------------------------------------------------- #

DEFAULT_USER_ID: Final[int] = 1
TOKENS_PER_HOUR: Final[int] = 10          # база: reward = estimated_hours * 10

# Приоритет задаёт множитель награды. На штраф он влияет косвенно: штраф
# считается долей от награды, поэтому у срочного квеста он выше в тех же
# полтора раза. Отдельный множитель штрафа делал бы разницу
# четырёхкратной и подталкивал занижать приоритет ради безопасности.
PRIORITIES: Final[dict] = {
    "low": {
        "title": {"ru": "Спокойно", "en": "Easy"},
        "reward_multiplier": 0.8, "order": 3,
    },
    "normal": {
        "title": {"ru": "Обычно", "en": "Normal"},
        "reward_multiplier": 1.0, "order": 2,
    },
    "high": {
        "title": {"ru": "Срочно", "en": "Urgent"},
        "reward_multiplier": 1.5, "order": 1,
    },
}

DEFAULT_PRIORITY: Final[str] = "normal"

# Доля награды, снимаемая при истечении срока: ровно половина того, что
# пользователь получил бы, выполнив квест вовремя.
#
# Просроченный квест разрешается завершить и после срока — тогда награда
# начисляется полностью, и с учётом уже удержанного штрафа опоздавший
# получает половину. Запрет на завершение наказывал бы за попытку
# доделать работу, то есть за ровно то поведение, к которому приложение
# должно подталкивать.
PENALTY_RATE: Final[float] = 0.5

# Сколько минут после дедлайна ждать, прежде чем засчитать провал. Запас
# спасает от штрафа за минуту опоздания, пока пользователь дожимает задачу.
PENALTY_GRACE_MINUTES: Final[int] = 15
BACKGROUND_PRICE: Final[int] = 100        # стоимость смены фона Сада
TASKS_PER_TREE_LEVEL: Final[int] = 3      # задач на один уровень дерева
MAX_TREE_LEVEL: Final[int] = 10

# --------------------------------------------------------------------------- #
# Каталог интерактивных сцен
# --------------------------------------------------------------------------- #

# Ключ сцены хранится в БД, поэтому переименовывать ключи нельзя — только
# добавлять новые. Порядок словаря задаёт порядок вкладок в интерфейсе.
# Поддерживаемые языки интерфейса. Ключ хранится в настройках и передаётся
# в каждый ответ, где есть переводимый текст.
LANGUAGES: Final[tuple] = ("ru", "en")
DEFAULT_LANGUAGE: Final[str] = "ru"


def localize(value, language: str) -> str:
    """Возвращает строку на нужном языке.

    Переводимые поля хранятся словарём ``{"ru": ..., "en": ...}``. Функция
    допускает и обычную строку: часть значений перевода не требует, и
    оборачивать их в словарь ради единообразия значило бы усложнить
    конфигурацию без выигрыша.

    Args:
        value: строка либо словарь переводов.
        language: код языка.

    Returns:
        str: текст на запрошенном языке, при его отсутствии — на русском.
    """
    if isinstance(value, dict):
        return value.get(language) or value.get(DEFAULT_LANGUAGE) or ""
    return value


SCENES: Final[dict] = {
    "garden": {
        "title": {"ru": "Сад Вдумчивости", "en": "Garden of Reflection"},
        "tagline": {"ru": "Дерево растёт вместе с тобой", "en": "The tree grows along with you"},
        "description": {"ru": "Нажми на крону — посыплются плоды. Их можно ловить и бросать.", "en": "Tap the crown and fruit will fall. You can catch and throw it."},
        "price": 0,
    },
    "volcano": {
        "title": {"ru": "Жерло Решимости", "en": "Crater of Resolve"},
        "tagline": {"ru": "Держи нажатие — пойдёт лава", "en": "Hold the press and lava flows"},
        "description": {"ru": "Долгое нажатие на кратер запускает поток лавы, который стекает по склону и остывает.", "en": "A long press on the crater starts a lava flow that runs down the slope and cools."},
        "price": 300,
    },
    "clockwork": {
        "title": {"ru": "Механизм Времени", "en": "Clockwork of Time"},
        "tagline": {"ru": "Малое колесо движет большое", "en": "A small wheel drives a large one"},
        "description": {"ru": "Сцепленные шестерни часовой башни. Крутани маленькую — большие пойдут тяжело и медленно; раскрути большую — мелкие завертятся вихрем.", "en": "Meshed gears of a clock tower. Spin the small one and the large ones turn slowly; spin the large one and the small ones race."},
        "price": 450,
    },
    "cosmos": {
        "title": {"ru": "Орбиты Замысла", "en": "Orbits of Intent"},
        "tagline": {"ru": "Планеты держат орбиту", "en": "Planets keep their orbits"},
        "description": {"ru": "Планеты можно перетаскивать и менять местами, но каждая возвращается на свою орбиту.", "en": "Planets can be dragged and swapped, but each returns to its own orbit."},
        "price": 600,
    },
    "pond": {
        "title": {"ru": "Пруд Безмолвия", "en": "Pond of Silence"},
        "tagline": {"ru": "Вода помнит каждое касание", "en": "Water remembers every touch"},
        "description": {"ru": "Кувшинки покачиваются на воде. Проведи по глади рукой — волны разойдутся кругами и оттолкнут листья к берегам.", "en": "Lily pads drift on the surface. Sweep your hand across the water and ripples push the leaves toward the banks."},
        "price": 750,
    },
    "desk": {
        "title": {"ru": "Стол Черновиков", "en": "Desk of Drafts"},
        "tagline": {"ru": "Чем выше уровень, тем больше вещей", "en": "The higher the level, the more objects"},
        "description": {"ru": "На столе лежат предметы: их можно расшвыривать, ронять и складывать обратно.", "en": "Objects lie on the desk: scatter them, drop them and pile them back up."},
        "price": 900,
    },
    "weave": {
        "title": {"ru": "Плетение Смыслов", "en": "Weave of Meanings"},
        "tagline": {"ru": "Потяни за нить — отзовётся вся сеть", "en": "Pull one thread and the whole net answers"},
        "description": {"ru": "Светящиеся узлы связаны упругими нитями и дрейфуют в невесомости. Потяни за один — сеть растянется, воспротивится и спружинит обратно в равновесие.", "en": "Glowing nodes are linked by elastic threads and drift weightlessly. Pull one and the net stretches, resists and springs back into balance."},
        "price": 1200,
    },
    "campfire": {
        "title": {"ru": "Лагерь Уединения", "en": "Camp of Solitude"},
        "tagline": {"ru": "Искры летят вверх", "en": "Sparks rise upward"},
        "description": {"ru": "Костёр в темноте: искры рождаются внизу и уходят вверх, закручиваясь вихрем за курсором. Подбрасывай поленья — пламя разгорается сильнее.", "en": "A fire in the dark: sparks are born below and drift up, swirling after the cursor. Toss in logs and the flame grows."},
        "price": 1500,
    },
    "lab": {
        "title": {"ru": "Лаборатория Идей", "en": "Laboratory of Ideas"},
        "tagline": {"ru": "Смешивай — получится третье", "en": "Mix two and get a third"},
        "description": {"ru": "Колбы с растворами на лабораторном столе. Возьми любую, наклони клавишами поворота — жидкость польётся. Попадёт в другую колбу — цвета смешаются.", "en": "Flasks of reagents on a lab bench. Pick one up, tilt it with the rotation keys and pour. Hit another flask and the reagents react."},
        "price": 2000,
    },
}

DEFAULT_SCENE: Final[str] = "garden"

# --------------------------------------------------------------------------- #
# Ограничения загрузки файлов
# --------------------------------------------------------------------------- #

ALLOWED_IMAGE_SUFFIXES: Final[frozenset] = frozenset({".png", ".jpg", ".jpeg", ".webp"})
ALLOWED_IMAGE_MIME: Final[frozenset] = frozenset({"image/png", "image/jpeg", "image/webp"})
MAX_UPLOAD_BYTES: Final[int] = 8 * 1024 * 1024  # 8 МиБ
UPLOAD_CHUNK_SIZE: Final[int] = 64 * 1024

# --------------------------------------------------------------------------- #
# Локальный сервер
# --------------------------------------------------------------------------- #

SERVER_HOST: Final[str] = "127.0.0.1"
SERVER_PORT: Final[int] = 8731
SERVER_URL: Final[str] = f"http://{SERVER_HOST}:{SERVER_PORT}"


def _bundled_model_candidates() -> list:
    """Перечисляет места, где могут лежать веса, вложенные в поставку.

    Мест несколько, потому что PyInstaller размещает ресурсы по-разному в
    зависимости от режима сборки. В режиме одного файла они распаковываются
    во временный каталог, путь к которому лежит в ``sys._MEIPASS``. В режиме
    отдельного каталога ресурсы попадают во вложенную папку ``_internal``,
    тогда как файлы, добавленные к выпуску вручную, оказываются рядом с
    исполняемым файлом — то есть на уровень выше.

    Перечисление всех вариантов надёжнее выбора одного: ошибка в
    предположении о раскладке проявляется как «модель не найдена» при
    физически присутствующем файле, и причина неочевидна.

    Returns:
        list: пути-кандидаты в порядке проверки.
    """
    candidates = [RESOURCE_DIR / "models" / "model.gguf"]

    if IS_FROZEN:
        # Рядом с исполняемым файлом: сюда веса кладёт скрипт сборки выпуска.
        executable_dir = Path(sys.executable).resolve().parent
        candidates.append(executable_dir / "models" / "model.gguf")
        # На уровень выше каталога ресурсов — вариант раскладки _internal.
        candidates.append(RESOURCE_DIR.parent / "models" / "model.gguf")

    # Порядок сохраняется, повторы отбрасываются: один и тот же путь может
    # получиться разными способами при совпадении каталогов.
    unique = []
    for path in candidates:
        if path not in unique:
            unique.append(path)
    return unique


def adopt_bundled_model() -> bool:
    """Переносит веса модели из поставки в каталог данных.

    В полном выпуске файл ``model.gguf`` лежит рядом с приложением, тогда
    как читается он из каталога данных пользователя. Перенос выполняется
    один раз при первом запуске.

    Копирование, а не чтение по месту, выбрано по двум причинам. Каталог
    установки может быть доступен только для чтения — например, при
    установке в ``Program Files``. И при обновлении приложения прежний
    каталог удаляется целиком, а веса, скачанные пользователем отдельно,
    остались бы в каталоге данных нетронутыми.

    Returns:
        bool: ``True``, если файл был перенесён в этот раз.
    """
    if LLM_MODEL_PATH.exists():
        return False

    for bundled in _bundled_model_candidates():
        if not bundled.is_file():
            continue
        try:
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bundled, LLM_MODEL_PATH)
            return True
        except OSError:
            # Нехватка места или запрет записи не должны мешать запуску:
            # приложение продолжит работу на резервных фразах.
            return False

    # В обычной сборке модель не поставляется — это не ошибка.
    return False


def ensure_runtime_dirs() -> None:
    """Создаёт каталоги данных, необходимые для работы приложения.

    Трогает только ``DATA_DIR``: каталоги ресурсов приходят из сборки и в
    frozen-режиме доступны лишь на чтение. Идемпотентна.
    """
    for directory in (DATA_DIR, UPLOADS_DIR, MODELS_DIR):
        directory.mkdir(parents=True, exist_ok=True)
