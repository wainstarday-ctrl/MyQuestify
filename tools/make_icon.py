"""Генерация иконки приложения ``assets/icon.ico``.

Иконка рисуется кодом, а не хранится как бинарный ассет: так она остаётся
воспроизводимой, а палитра берётся из тех же констант, что и интерфейс.
Мотив повторяет знак в шапке UI — ядро награды в кольце-циферблате
из изумруда и фиолетового.

Запуск::

    python tools/make_icon.py

Требуется Pillow. Скрипт нужен только при сборке; на работу приложения он
не влияет.
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
TARGET = ROOT / "assets" / "icon.ico"

# Палитра из static/css/style.css
BG = (18, 18, 18, 255)          # --bg
EMERALD = (16, 185, 129)        # --emerald
VIOLET = (139, 92, 246)         # --violet
REWARD = (245, 158, 11)          # --ember

# Рисуем крупно и уменьшаем — дешёвое сглаживание без внешних зависимостей.
CANVAS = 1024
ICON_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]


def _lerp(a: tuple, b: tuple, t: float) -> tuple:
    """Линейная интерполяция между двумя RGB-цветами."""
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _ring_color(angle_deg: float) -> tuple:
    """Цвет кольца: изумруд → фиолетовый → изумруд по кругу."""
    t = (angle_deg % 360) / 360.0
    # Треугольная волна: 0 → 1 → 0, чтобы стык на 360° был бесшовным.
    wave = 1 - abs(t * 2 - 1)
    return _lerp(EMERALD, VIOLET, wave)


def build_image() -> Image.Image:
    """Собирает изображение иконки в высоком разрешении."""
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    center = CANVAS / 2

    # Тёмная подложка со скруглением — читается и на светлой панели задач.
    draw.rounded_rectangle(
        [(0, 0), (CANVAS - 1, CANVAS - 1)], radius=int(CANVAS * 0.22), fill=BG
    )

    # Градиентное кольцо: набирается короткими дугами.
    ring_box = [
        (CANVAS * 0.16, CANVAS * 0.16),
        (CANVAS * 0.84, CANVAS * 0.84),
    ]
    ring_width = int(CANVAS * 0.055)
    for angle in range(0, 360, 2):
        draw.arc(ring_box, angle - 1, angle + 2, fill=_ring_color(angle), width=ring_width)

    # Метки часов — отсылка к хронометру. Полупрозрачные штрихи рисуются на
    # отдельном слое: ImageDraw не смешивает альфу, а перезаписывает её, и
    # рисование прямо по подложке выбило бы в ней дыры.
    ticks = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ticks_draw = ImageDraw.Draw(ticks)
    tick_outer = CANVAS * 0.305
    tick_inner = CANVAS * 0.255
    for hour in range(12):
        rad = math.radians(hour * 30 - 90)
        major = hour % 3 == 0
        ticks_draw.line(
            [
                (center + math.cos(rad) * tick_inner, center + math.sin(rad) * tick_inner),
                (center + math.cos(rad) * tick_outer, center + math.sin(rad) * tick_outer),
            ],
            fill=(255, 255, 255, 150 if major else 70),
            width=int(CANVAS * (0.019 if major else 0.012)),
        )
    image = Image.alpha_composite(image, ticks)

    # Ядро награды: слабый ореол плюс плотный центр. Каждый слой ореола
    # накладывается отдельно, иначе прозрачности не складываются.
    core = CANVAS * 0.105
    halo_steps = 22
    for step in range(halo_steps, 0, -1):
        radius = core * (1 + step * 0.082)
        halo = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        ImageDraw.Draw(halo).ellipse(
            [(center - radius, center - radius), (center + radius, center + radius)],
            fill=REWARD + (5,),
        )
        image = Image.alpha_composite(image, halo)

    ImageDraw.Draw(image).ellipse(
        [(center - core, center - core), (center + core, center + core)],
        fill=REWARD + (255,),
    )

    return image


def main() -> None:
    """Сохраняет многоразмерный ICO рядом с ресурсами приложения."""
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    image = build_image()
    image.save(TARGET, format="ICO", sizes=ICON_SIZES)
    print(f"Иконка сохранена: {TARGET}")


if __name__ == "__main__":
    main()
