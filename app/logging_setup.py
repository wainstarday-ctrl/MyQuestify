"""Настройка логирования, устойчивая к отсутствию консоли.

В собранном windowed-приложении (``console=False`` в PyInstaller) поток
``sys.stderr`` равен ``None``. Стандартный ``logging.basicConfig()`` в такой
ситуации создаёт ``StreamHandler`` без потока, и первая же запись в лог
роняет процесс с ``AttributeError``. Поэтому обработчики подбираются по
факту наличия потоков, а основной журнал всегда пишется в файл внутри
каталога данных пользователя.
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from typing import Optional

from app.config import LOG_FILE, ensure_runtime_dirs

LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
MAX_LOG_BYTES = 1_000_000
LOG_BACKUPS = 2

_configured = False


def setup_logging(level: int = logging.INFO) -> logging.Logger:
    """Конфигурирует корневой логгер приложения.

    Args:
        level: минимальный уровень записи.

    Returns:
        logging.Logger: логгер приложения ``myquestify``.
    """
    global _configured

    logger = logging.getLogger("myquestify")
    if _configured:
        return logger

    ensure_runtime_dirs()

    root = logging.getLogger()
    root.setLevel(level)
    formatter = logging.Formatter(LOG_FORMAT)

    file_handler: Optional[logging.Handler] = None
    try:
        file_handler = RotatingFileHandler(
            LOG_FILE, maxBytes=MAX_LOG_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8"
        )
    except OSError:
        # Каталог данных недоступен — не повод падать; останется консоль, если есть.
        file_handler = None

    if file_handler is not None:
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

    # Консольный обработчик добавляется только при реально существующем потоке.
    if sys.stderr is not None and getattr(sys.stderr, "write", None) is not None:
        stream_handler = logging.StreamHandler(sys.stderr)
        stream_handler.setFormatter(formatter)
        root.addHandler(stream_handler)

    if not root.handlers:
        root.addHandler(logging.NullHandler())

    _configured = True
    return logger
