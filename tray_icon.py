"""Значок в области уведомлений Windows и показ всплывающих сообщений.

Зачем это нужно. Напоминания о дедлайнах приходят из планировщика внутри
серверного процесса. Если закрытие окна завершает процесс, никаких
напоминаний «после закрытия» быть не может в принципе. Поэтому закрытие окна
сворачивает приложение в трей: процесс продолжает жить, планировщик работает,
уведомления приходят. Выход — только через меню значка.

Честная граница возможностей: пока процесс не запущен вообще (компьютер
перезагрузили, пользователь вышел через меню), напоминаний не будет.
Доставка, независимая от процесса, требует задачи в «Планировщике заданий»
Windows — это отдельная установка, а не часть приложения.

Модуль опционален: если ``pystray`` или ``Pillow`` не установлены, класс
сообщает :attr:`TrayController.available` = ``False``, и оболочка возвращается
к обычному поведению «закрыл окно — вышел».
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

from app.config import APP_NAME, ICON_FILE

logger = logging.getLogger("myquestify.tray")

TOOLTIP = f"{APP_NAME} — напоминания включены"


class TrayController:
    """Обёртка над значком в трее.

    Args:
        on_show: вызывается при выборе «Открыть окно».
        on_quit: вызывается при выборе «Выход».
    """

    def __init__(self, on_show: Callable[[], None], on_quit: Callable[[], None]) -> None:
        """Создаёт значок, если необходимые пакеты доступны.

        Отсутствие pystray или Pillow не считается ошибкой: приложение
        работает без значка, о чём сообщает поле :attr:`available`.

        Args:
            on_show: обработчик пункта «Открыть окно».
            on_quit: обработчик пункта «Выход».
        """
        self._on_show = on_show
        self._on_quit = on_quit
        self._icon = None
        self._thread: Optional[threading.Thread] = None
        self.available = False

        try:
            import pystray
            from PIL import Image
        except ImportError:
            logger.info("pystray или Pillow не установлены — трей недоступен.")
            return

        try:
            image = (
                Image.open(ICON_FILE)
                if ICON_FILE.is_file()
                else Image.new("RGB", (64, 64), (18, 18, 18))
            )
            # ICO хранит несколько размеров; трею нужен один конкретный.
            image = image.convert("RGBA").resize((64, 64))

            self._icon = pystray.Icon(
                name=APP_NAME,
                icon=image,
                title=TOOLTIP,
                menu=pystray.Menu(
                    pystray.MenuItem("Открыть окно", self._handle_show, default=True),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Выход", self._handle_quit),
                ),
            )
            self.available = True
        except Exception:  # noqa: BLE001 — без трея приложение всё равно работает
            logger.exception("Не удалось создать значок в трее.")
            self._icon = None

    # ------------------------------------------------------------- обработчики

    def _handle_show(self, *_args) -> None:
        """Пункт меню «Открыть окно»."""
        try:
            self._on_show()
        except Exception:  # noqa: BLE001
            logger.exception("Ошибка при показе окна из трея.")

    def _handle_quit(self, *_args) -> None:
        """Пункт меню «Выход»."""
        try:
            self._on_quit()
        finally:
            self.stop()

    # ------------------------------------------------------------------- API

    def start(self) -> None:
        """Запускает значок в отдельном потоке.

        Главный поток занят циклом PyWebView, поэтому значок работает
        параллельно. ``run_detached`` на Windows поддерживается; при отказе
        поднимается обычный поток с ``run``.
        """
        if not self.available or self._icon is None:
            return

        try:
            self._icon.run_detached()
            logger.info("Значок в трее запущен.")
            return
        except (NotImplementedError, RuntimeError):
            logger.debug("run_detached недоступен, используется отдельный поток.")

        self._thread = threading.Thread(
            target=self._icon.run, name="myquestify-tray", daemon=True
        )
        self._thread.start()
        logger.info("Значок в трее запущен в отдельном потоке.")

    def notify(self, title: str, message: str) -> None:
        """Показывает всплывающее уведомление.

        Args:
            title: заголовок.
            message: текст.
        """
        if not self.available or self._icon is None:
            logger.info("Уведомление без трея: %s — %s", title, message)
            return
        try:
            # Windows обрезает длинный текст молча — режем сами, чтобы фраза
            # не обрывалась на середине слова.
            self._icon.notify(message[:240], title[:64])
        except Exception:  # noqa: BLE001
            logger.exception("Не удалось показать уведомление.")

    def stop(self) -> None:
        """Убирает значок из трея."""
        if self._icon is None:
            return
        try:
            self._icon.stop()
        except Exception:  # noqa: BLE001
            logger.debug("Значок уже остановлен.")
        finally:
            self._icon = None
            self.available = False
