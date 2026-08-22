"""Генерация значков приложения для Android.

Android требует значок в шести плотностях экрана и, начиная с восьмой
версии, в двух слоях — подложке и переднем плане, из которых система сама
собирает форму (круг, квадрат со скруглением, каплю). Одна картинка на все
случаи приведёт к обрезанному изображению на части устройств.

Дополнительно создаётся однотонный значок для строки состояния: цветное
изображение там отображается силуэтом, и мелкие детали превращаются в
кляксу.

Мотив повторяет значок настольной версии — ядро награды в кольце-циферблате.
Значки рисуются кодом, а не хранятся картинками: палитра берётся из тех же
констант, что и оформление интерфейса, и результат воспроизводим.

Запуск из корня проекта::

    python tools/make_android_icons.py

Требуется Pillow. На работу приложения скрипт не влияет — он готовит файлы
для сборки.
"""

from __future__ import annotations

import sys

# Консоль машины сборки под Windows работает в однобайтовой кодировке и
# отвергает кириллицу в выводе, прерывая скрипт ошибкой. Перенастройка
# потока избавляет от этого, сохраняя сообщения читаемыми там, где
# кодировка их принимает.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "mobile" / "android-icons"

# Палитра из static/css/style.css
BG = (18, 18, 18, 255)
EMERALD = (16, 185, 129)
VIOLET = (139, 92, 246)
REWARD = (245, 158, 11)

#: Плотности экрана и размер обычного значка для каждой.
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

#: Размер адаптивного значка. Система обрезает его до формы, оставляя
#: видимой лишь центральную часть, поэтому рисунок занимает не всё поле.
ADAPTIVE = 432
ADAPTIVE_SAFE = 0.62

CANVAS = 1024


def _lerp(a: tuple, b: tuple, t: float) -> tuple:
    """Линейная интерполяция между двумя цветами RGB."""
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _ring_color(angle_deg: float) -> tuple:
    """Цвет кольца: изумруд переходит в фиолетовый и обратно."""
    t = (angle_deg % 360) / 360.0
    wave = 1 - abs(t * 2 - 1)
    return _lerp(EMERALD, VIOLET, wave)


def draw_mark(size: int, scale: float = 1.0, background: bool = True) -> Image.Image:
    """Рисует знак приложения.

    Args:
        size: сторона изображения в точках.
        scale: доля поля, занимаемая рисунком. Для адаптивного значка меньше
            единицы: система обрезает края под выбранную форму.
        background: рисовать ли тёмную подложку. Для переднего слоя
            адаптивного значка подложка не нужна — её задаёт отдельный файл.

    Returns:
        Image.Image: изображение с прозрачным фоном там, где его нет.
    """
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    center = CANVAS / 2
    radius = CANVAS * 0.34 * scale

    if background:
        draw.rounded_rectangle(
            [(0, 0), (CANVAS - 1, CANVAS - 1)], radius=int(CANVAS * 0.22), fill=BG
        )

    # Кольцо набирается короткими дугами: градиент по окружности иначе
    # средствами Pillow не строится.
    ring_box = [(center - radius, center - radius), (center + radius, center + radius)]
    ring_width = int(radius * 0.16)
    for angle in range(0, 360, 2):
        draw.arc(ring_box, angle - 1, angle + 2, fill=_ring_color(angle), width=ring_width)

    # Метки часов: полупрозрачные штрихи на отдельном слое, поскольку
    # ImageDraw не смешивает альфу, а перезаписывает её.
    ticks = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ticks_draw = ImageDraw.Draw(ticks)
    for hour in range(12):
        rad = math.radians(hour * 30 - 90)
        major = hour % 3 == 0
        outer = radius * 0.88
        inner = radius * (0.70 if major else 0.76)
        ticks_draw.line(
            [
                (center + math.cos(rad) * inner, center + math.sin(rad) * inner),
                (center + math.cos(rad) * outer, center + math.sin(rad) * outer),
            ],
            fill=(255, 255, 255, 150 if major else 70),
            width=int(radius * (0.055 if major else 0.035)),
        )
    image = Image.alpha_composite(image, ticks)

    # Ореол ядра: множество слабых слоёв вместо нескольких плотных, иначе
    # видны концентрические уступы.
    core = radius * 0.31
    for step in range(22, 0, -1):
        halo_radius = core * (1 + step * 0.082)
        halo = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        ImageDraw.Draw(halo).ellipse(
            [
                (center - halo_radius, center - halo_radius),
                (center + halo_radius, center + halo_radius),
            ],
            fill=REWARD + (5,),
        )
        image = Image.alpha_composite(image, halo)

    ImageDraw.Draw(image).ellipse(
        [(center - core, center - core), (center + core, center + core)],
        fill=REWARD + (255,),
    )

    return image.resize((size, size), Image.LANCZOS)


def draw_background(size: int) -> Image.Image:
    """Рисует подложку адаптивного значка.

    Подложка обязана заполнять поле целиком: система обрезает её под форму, и
    прозрачные края дали бы рваный контур.
    """
    image = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(image)

    # Лёгкое свечение из центра, чтобы подложка не выглядела плашкой.
    for step in range(30, 0, -1):
        radius = size * 0.5 * (step / 30)
        draw.ellipse(
            [(size / 2 - radius, size / 2 - radius), (size / 2 + radius, size / 2 + radius)],
            fill=(24 + step, 22 + step, 34 + step, 255),
        )
    return image


def draw_status_icon(size: int) -> Image.Image:
    """Рисует однотонный значок для строки состояния.

    Android отображает такой значок силуэтом: учитывается только альфа-канал,
    цвет задаётся системой. Поэтому рисунок упрощён до кольца и точки —
    циферблатные метки на высоте 24 точки слились бы в пятно.
    """
    canvas = 192
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    center = canvas / 2
    radius = canvas * 0.36

    draw.ellipse(
        [(center - radius, center - radius), (center + radius, center + radius)],
        outline=(255, 255, 255, 255),
        width=int(canvas * 0.09),
    )
    core = radius * 0.34
    draw.ellipse(
        [(center - core, center - core), (center + core, center + core)],
        fill=(255, 255, 255, 255),
    )
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    """Создаёт полный набор значков в mobile/android-icons."""
    TARGET.mkdir(parents=True, exist_ok=True)
    created = 0

    for density, size in DENSITIES.items():
        folder = TARGET / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)

        # Обычный значок для устройств до восьмой версии Android.
        draw_mark(size).save(folder / "ic_launcher.png")

        # Круглый вариант: часть оболочек запрашивает именно его.
        draw_mark(size).save(folder / "ic_launcher_round.png")

        # Слои адаптивного значка. Размер общий для всех плотностей —
        # система масштабирует их сама.
        adaptive = round(ADAPTIVE * size / DENSITIES["xxxhdpi"] * 4)
        draw_mark(adaptive, scale=ADAPTIVE_SAFE, background=False).save(
            folder / "ic_launcher_foreground.png"
        )
        draw_background(adaptive).save(folder / "ic_launcher_background.png")

        # Значок строки состояния: только силуэт.
        status_size = max(24, round(size * 0.5))
        draw_status_icon(status_size).save(folder / "ic_stat_icon.png")

        created += 5

    # Изображение для магазина приложений и для оформления страницы проекта.
    draw_mark(512).save(TARGET / "play-store-512.png")
    created += 1

    print(f"Создано файлов: {created}")
    print(f"Каталог: {TARGET}")
    print("\nПеренести в проект Android после `npx cap add android`:")
    print("  mobile/android-icons/mipmap-*  →  mobile/android/app/src/main/res/")


if __name__ == "__main__":
    main()
