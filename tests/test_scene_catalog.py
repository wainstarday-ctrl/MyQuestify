"""Сверка каталога сцен между настольной и мобильной версиями.

Каталог сцен существует в двух видах. Настольная версия читает его из
``app/config.py``: там Python, и словарь доступен прямо во время работы.
Мобильная версия Python не содержит — вместо сервера в ней работает
``static/js/local-api.js``, и каталог продублирован там вручную.

Дублирование само по себе допустимо: записи меняются редко, а генератор
одного файла из другого усложнил бы сборку сильнее, чем экономит. Опасно
другое — расхождение не проявляет себя. Сцена, добавленная только в
``config.py``, на телефоне просто отсутствует в перечне вкладок: ошибки нет,
предупреждения нет, приложение работает. Именно так десятая сцена
(«Облака Вдохновения») попала в выпуск 2.0.0 на настольные системы и не
попала на Android.

Проверки здесь закрывают этот разрыв и соседний с ним: сцена может значиться
в обоих каталогах, но её код не подключён к странице — тогда вкладка
появится, а холст останется пустым.

Запуск::

    python -m pytest tests/test_scene_catalog.py -v
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import SCENES  # noqa: E402  — путь добавляется выше

LOCAL_API = ROOT / "static" / "js" / "local-api.js"
INDEX_HTML = ROOT / "templates" / "index.html"
JS_DIR = ROOT / "static" / "js"


def unescape(value: str) -> str:
    """Снимает экранирование строкового литерала JavaScript.

    Проверяются тексты, а не их запись в файле: апостроф в английском
    описании хранится как ``\\'`` и до сравнения должен стать обычным.
    """
    return value.replace("\\'", "'").replace("\\\\", "\\")


def parse_mobile_catalog() -> list[dict]:
    """Разбирает каталог сцен из ``local-api.js``.

    Разбор текстом, а не выполнением JavaScript: узел не нужен для запуска
    тестов, а формат записи в файле стабилен и проверяется этим же тестом —
    если запись перестанет ему соответствовать, тест упадёт, а не пропустит
    сцену молча.

    Returns:
        list[dict]: записи в порядке следования в файле, каждая с ключами
        ``key``, ``price`` и по два языка для названия, подзаголовка и
        описания.
    """
    source = LOCAL_API.read_text(encoding="utf-8")

    start = source.find("var SCENES = [")
    assert start != -1, "в local-api.js не найден массив SCENES"
    end = source.find("\n  ];", start)
    assert end != -1, "не найден конец массива SCENES"
    block = source[start:end]

    # Строка может содержать экранированный апостроф, поэтому содержимое
    # набирается как «любой знак, кроме апострофа, либо апостроф с обратной
    # косой чертой». Простое [^\']* оборвало бы разбор на первом же
    # апострофе внутри английского текста.
    text = r"((?:[^'\\]|\\.)*)"
    pair = r"\{\s*ru:\s*'" + text + r"',\s*en:\s*'" + text + r"'\s*\}"

    pattern = (
        r"\{\s*key:\s*'([a-z]+)',\s*price:\s*(\d+),\s*"
        r"title:\s*" + pair + r",\s*"
        r"tagline:\s*" + pair + r",\s*"
        r"description:\s*" + pair
    )

    entries = []
    for match in re.finditer(pattern, block):
        fields = [unescape(value) for value in match.groups()[2:]]
        entries.append(
            {
                "key": match.group(1),
                "price": int(match.group(2)),
                "title": {"ru": fields[0], "en": fields[1]},
                "tagline": {"ru": fields[2], "en": fields[3]},
                "description": {"ru": fields[4], "en": fields[5]},
            }
        )

    assert entries, "каталог сцен в local-api.js разобрать не удалось"
    assert len(entries) == block.count("{ key:"), (
        "часть записей каталога не разобралась — проверьте формат записи"
    )
    return entries


@pytest.fixture(scope="module")
def mobile() -> list[dict]:
    return parse_mobile_catalog()


def test_scene_keys_match(mobile: list[dict]) -> None:
    """Наборы ключей совпадают.

    Отдельно перечисляются пропущенные и лишние: сообщение об ошибке должно
    называть сцену, а не только сообщать о несовпадении длин.
    """
    desktop_keys = set(SCENES)
    mobile_keys = {entry["key"] for entry in mobile}

    missing = sorted(desktop_keys - mobile_keys)
    extra = sorted(mobile_keys - desktop_keys)

    assert not missing, f"нет в мобильном каталоге: {missing}"
    assert not extra, f"нет в app/config.py: {extra}"


def test_scene_order_matches(mobile: list[dict]) -> None:
    """Порядок следования одинаков.

    Перечень вкладок строится по порядку записей, и различие порядка на двух
    платформах — расхождение интерфейса, пусть и не такое заметное, как
    пропавшая сцена.
    """
    assert [entry["key"] for entry in mobile] == list(SCENES)


def test_scene_prices_match(mobile: list[dict]) -> None:
    """Цены совпадают.

    Расхождение здесь означало бы, что одна и та же сцена стоит разное число
    токенов на телефоне и на компьютере.
    """
    for entry in mobile:
        expected = SCENES[entry["key"]]["price"]
        assert entry["price"] == expected, (
            f"сцена {entry['key']}: цена {entry['price']} против {expected}"
        )


@pytest.mark.parametrize("field", ["title", "tagline", "description"])
def test_scene_texts_match(mobile: list[dict], field: str) -> None:
    """Названия, подзаголовки и описания совпадают на обоих языках.

    Проверка описаний добавлена не для полноты: в выпуске 2.0.0 пять сцен
    несли на телефоне укороченный текст — вторая фраза, объясняющая способ
    взаимодействия, была потеряна при переносе. Ошибка тихая: карточка
    выглядит целой, просто половина объяснения отсутствует.
    """
    for entry in mobile:
        expected = SCENES[entry["key"]][field]
        for lang in ("ru", "en"):
            assert entry[field][lang] == expected[lang], (
                f"сцена {entry['key']}, {field}.{lang}:\n"
                f"  config.py:    {expected[lang]}\n"
                f"  local-api.js: {entry[field][lang]}"
            )


def test_scene_prices_ascending() -> None:
    """Каталог отсортирован по возрастанию цены.

    Перечень выводится в порядке записей, и бесплатная сцена должна стоять
    первой, а самая дорогая — последней.
    """
    prices = [scene["price"] for scene in SCENES.values()]
    assert prices == sorted(prices), prices


def test_every_scene_has_code() -> None:
    """Каждой сцене каталога отвечает зарегистрированный обработчик.

    Сцена может значиться в обоих каталогах и всё же не работать: вкладка
    появится, а холст останется пустым, потому что файл с кодом сцены не
    подключён к странице. Проверяется и наличие вызова регистрации, и
    подключение файла, в котором он находится.
    """
    sources = {path: path.read_text(encoding="utf-8") for path in JS_DIR.glob("*.js")}
    html = INDEX_HTML.read_text(encoding="utf-8")

    for key in SCENES:
        holders = [
            path
            for path, text in sources.items()
            if f"Stage.register('{key}'" in text or f'Stage.register("{key}"' in text
        ]
        assert holders, f"сцена {key}: нет вызова Stage.register"

        for path in holders:
            tag = f'src="/static/js/{path.name}"'
            assert tag in html, (
                f"сцена {key}: файл {path.name} не подключён в index.html"
            )
