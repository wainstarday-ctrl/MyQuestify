"""Точка входа MyQuestify: десктопная оболочка PyWebView поверх FastAPI.

Схема запуска:

1. uvicorn поднимается в фоновом потоке-демоне на ``127.0.0.1``;
2. главный поток ждёт готовности сервера (PyWebView обязан жить в main thread);
3. открывается окно, которое загружает UI с локального сервера;
4. после закрытия окна серверу выставляется ``should_exit`` и поток
   дожидается корректного завершения (закрытие пула БД, выгрузка LLM).

Адаптация под Windows:

* ``freeze_support()`` — иначе собранный ``.exe`` при любом порождении
  процесса перезапускает сам себя и плодит окна;
* осведомлённость о DPI — без неё интерфейс в масштабе 125/150 % размывается;
* именованный мьютекс — вторая копия не поднимает второй сервер на том же
  каталоге данных, а активирует уже запущенное окно;
* явный бэкенд ``edgechromium`` и проверка наличия WebView2 Runtime, чтобы
  вместо пустого чёрного окна пользователь получил внятное сообщение;
* диагностика через ``MessageBoxW``: в windowed-сборке консоли нет, и
  ``print`` уходит в никуда.
"""

from __future__ import annotations

import logging
import multiprocessing
import socket
import sys
import threading
import time
from typing import Optional

# uvicorn — ASGI-сервер, необходимый для запуска FastAPI. Работает в
# фоновом потоке, поскольку главный поток занят циклом обработки событий
# графической оболочки.
import uvicorn

# PyWebView отображает интерфейс в системном компоненте просмотра веб-страниц
# (на Windows — Microsoft Edge WebView2). Альтернатива в виде Electron
# добавила бы к дистрибутиву около 150 МБ собственной сборки браузера,
# тогда как PyWebView использует уже установленный в системе компонент.
# Интерфейс при этом остаётся обычной веб-страницей, что упрощает
# последующий перенос на другие платформы.
import webview

from app.config import (
    APP_NAME,
    APP_VERSION,
    IS_MACOS,
    DATA_DIR,
    IS_FROZEN,
    IS_WINDOWS,
    LOG_FILE,
    SERVER_HOST,
    SERVER_PORT,
    ensure_runtime_dirs,
)
from app import notifier
from app.logging_setup import setup_logging
from app.main import app
from tray_icon import TrayController

logger = logging.getLogger("myquestify.run")

WINDOW_TITLE = APP_NAME
WINDOW_WIDTH = 1360
WINDOW_HEIGHT = 860
WINDOW_MIN_SIZE = (900, 620)
WINDOW_BACKGROUND = "#121212"

STARTUP_TIMEOUT_SEC = 30.0
SHUTDOWN_TIMEOUT_SEC = 10.0
POLL_INTERVAL_SEC = 0.05

MUTEX_NAME = f"Global\\{APP_NAME}-single-instance"
_ERROR_ALREADY_EXISTS = 183
_MB_ICON_ERROR = 0x10
_MB_ICON_WARNING = 0x30

_mutex_handle: Optional[int] = None


# --------------------------------------------------------------------------- #
# Windows-специфика
# --------------------------------------------------------------------------- #

def show_message(text: str, title: str = APP_NAME, warning: bool = False) -> None:
    """Показывает сообщение пользователю доступным способом.

    В собранном windowed-приложении нет ни консоли, ни stderr, поэтому на
    Windows используется системный диалог. На прочих платформах и при
    запуске из исходников сообщение уходит в лог и в поток вывода.

    Args:
        text: текст сообщения.
        title: заголовок окна.
        warning: показать значок предупреждения вместо ошибки.
    """
    logger.error("%s: %s", title, text)

    if IS_WINDOWS:
        try:
            import ctypes

            icon = _MB_ICON_WARNING if warning else _MB_ICON_ERROR
            ctypes.windll.user32.MessageBoxW(0, text, title, icon)
            return
        except Exception:  # noqa: BLE001 — диалог не критичен
            pass

    if sys.stderr is not None:
        print(f"{title}: {text}", file=sys.stderr)


def enable_dpi_awareness() -> None:
    """Включает поддержку масштабирования экрана на Windows.

    Без явного вызова система растягивает окно средствами DWM, и весь
    интерфейс — включая холст сада — выглядит размытым на мониторах
    с масштабом больше 100 %.
    """
    if not IS_WINDOWS:
        return

    try:
        import ctypes

        # PROCESS_PER_MONITOR_DPI_AWARE (Windows 8.1+).
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        try:
            import ctypes

            ctypes.windll.user32.SetProcessDPIAware()  # запасной путь для Windows 7
        except Exception:  # noqa: BLE001
            logger.debug("Не удалось включить DPI awareness.")


def acquire_single_instance_lock() -> bool:
    """Захватывает именованный мьютекс, разрешая только одну копию приложения.

    Две копии писали бы в одну SQLite-базу из разных процессов и открывали
    два окна на разных портах — состояние сада и баланс расходились бы.

    Returns:
        bool: ``True``, если копия единственная либо блокировка недоступна
        (на не-Windows платформах ограничение не применяется).
    """
    global _mutex_handle

    if not IS_WINDOWS:
        return True

    try:
        import ctypes

        handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if ctypes.windll.kernel32.GetLastError() == _ERROR_ALREADY_EXISTS:
            return False
        _mutex_handle = handle
        return True
    except Exception:  # noqa: BLE001 — лучше запустить, чем не запустить
        logger.debug("Проверка единственной копии недоступна.")
        return True


def release_single_instance_lock() -> None:
    """Освобождает мьютекс единственной копии."""
    global _mutex_handle

    if _mutex_handle is None or not IS_WINDOWS:
        return

    try:
        import ctypes

        ctypes.windll.kernel32.ReleaseMutex(_mutex_handle)
        ctypes.windll.kernel32.CloseHandle(_mutex_handle)
    except Exception:  # noqa: BLE001
        pass
    finally:
        _mutex_handle = None


def webview2_runtime_installed() -> bool:
    """Проверяет наличие Microsoft Edge WebView2 Runtime.

    PyWebView на Windows рендерит страницу движком WebView2. Если рантайм не
    установлен, окно открывается пустым и чёрным без каких-либо ошибок —
    самый неприятный вид отказа. Проверка идёт по ключу реестра, который
    установщик рантайма создаёт и для машинной, и для пользовательской установки.

    Returns:
        bool: ``True``, если рантайм найден или проверка неприменима.
    """
    if not IS_WINDOWS:
        return True

    try:
        import winreg
    except ImportError:
        return True

    key_path = (
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients"
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    candidates = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node" + key_path[len("SOFTWARE"):]),
        (winreg.HKEY_LOCAL_MACHINE, key_path),
        (winreg.HKEY_CURRENT_USER, key_path),
    ]

    for root, path in candidates:
        try:
            with winreg.OpenKey(root, path) as key:
                version, _ = winreg.QueryValueEx(key, "pv")
                if version and version != "0.0.0.0":
                    return True
        except OSError:
            continue

    return False


# --------------------------------------------------------------------------- #
# Локальный сервер
# --------------------------------------------------------------------------- #

def resolve_port(host: str, preferred: int) -> int:
    """Возвращает свободный TCP-порт.

    Сначала проверяется предпочитаемый порт; если он занят, ОС выдаёт
    произвольный свободный. Это позволяет запуститься, даже если порт
    удерживает посторонний процесс.

    Args:
        host: интерфейс для привязки.
        preferred: желаемый порт.

    Returns:
        int: порт, который гарантированно можно занять.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, preferred))
            return preferred
        except OSError:
            logger.warning("Порт %s занят, выбирается свободный.", preferred)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as fallback:
        fallback.bind((host, 0))
        return int(fallback.getsockname()[1])


class BackendThread(threading.Thread):
    """Фоновый поток с uvicorn.

    ``uvicorn.Server`` сам определяет, что находится не в главном потоке, и
    не устанавливает обработчики сигналов, поэтому обходных путей не нужно —
    остановка выполняется через ``should_exit``.

    Приложение передаётся объектом, а не строкой импорта: внутри собранного
    ``.exe`` пути импорта не совпадают с исходными, и строка ``app.main:app``
    не разрешилась бы.
    """

    def __init__(self, host: str, port: int) -> None:
        """Готовит конфигурацию сервера, не запуская его.

        Args:
            host: интерфейс привязки.
            port: свободный TCP-порт, полученный из resolve_port.
        """
        super().__init__(name="myquestify-backend", daemon=True)
        self._config = uvicorn.Config(
            app=app,
            host=host,
            port=port,
            log_level="info",
            access_log=False,
            loop="asyncio",
            # Собственная конфигурация логирования уже настроена: не даём
            # uvicorn перехватить её и попытаться писать в отсутствующий stdout.
            log_config=None,
        )
        self.server = uvicorn.Server(self._config)
        self.error: Optional[BaseException] = None

    def run(self) -> None:
        """Запускает сервер и перехватывает фатальные ошибки старта."""
        try:
            self.server.run()
        except BaseException as exc:  # noqa: BLE001 — пробрасывается в главный поток
            self.error = exc
            logger.exception("Backend завершился с ошибкой.")

    def wait_until_ready(self, timeout: float = STARTUP_TIMEOUT_SEC) -> bool:
        """Блокирует поток до готовности сервера принимать запросы.

        Args:
            timeout: максимальное время ожидания в секундах.

        Returns:
            bool: ``True``, если сервер поднялся; ``False`` при таймауте
            или падении потока.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.error is not None or not self.is_alive():
                return False
            if getattr(self.server, "started", False):
                return True
            time.sleep(POLL_INTERVAL_SEC)
        return False

    def shutdown(self, timeout: float = SHUTDOWN_TIMEOUT_SEC) -> None:
        """Просит сервер завершиться и ждёт отработки ``lifespan``-хуков."""
        self.server.should_exit = True
        self.join(timeout=timeout)
        if self.is_alive():
            logger.warning("Backend не остановился за %s с — принудительный выход.", timeout)


# --------------------------------------------------------------------------- #
# Сборка приложения
# --------------------------------------------------------------------------- #

def main() -> int:
    """Собирает и запускает десктопное приложение.

    Returns:
        int: код возврата процесса (0 — штатное завершение).
    """
    ensure_runtime_dirs()
    setup_logging()
    enable_dpi_awareness()

    logger.info("Старт %s %s (frozen=%s). Данные: %s",
                APP_NAME, APP_VERSION, IS_FROZEN, DATA_DIR)

    if not acquire_single_instance_lock():
        show_message(
            f"{APP_NAME} уже запущен. Найди окно приложения на панели задач.",
            warning=True,
        )
        return 0

    if not webview2_runtime_installed():
        show_message(
            "Не найден Microsoft Edge WebView2 Runtime — без него окно останется пустым.\n\n"
            "Установи «Evergreen Standalone Installer» со страницы\n"
            "Microsoft Edge WebView2 и запусти приложение снова.",
            warning=True,
        )
        release_single_instance_lock()
        return 1

    port = resolve_port(SERVER_HOST, SERVER_PORT)
    backend = BackendThread(SERVER_HOST, port)
    backend.start()

    if not backend.wait_until_ready():
        backend.shutdown()
        release_single_instance_lock()
        show_message(
            "Не удалось запустить локальный сервер MyQuestify.\n\n"
            f"Подробности в журнале:\n{LOG_FILE}"
        )
        return 1

    url = f"http://{SERVER_HOST}:{port}"
    logger.info("UI доступен по адресу %s", url)

    window = webview.create_window(
        title=WINDOW_TITLE,
        url=url,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=WINDOW_MIN_SIZE,
        background_color=WINDOW_BACKGROUND,
        text_select=False,
        confirm_close=False,
    )

    # Флаг отличает «свернуть в трей» от настоящего выхода: обработчик
    # закрытия срабатывает в обоих случаях и сам различить их не может.
    quitting = {"value": False}

    def request_quit() -> None:
        """Пункт «Выход» из меню трея."""
        quitting["value"] = True
        try:
            window.destroy()
        except Exception:  # noqa: BLE001 — окно могло уже закрыться
            logger.debug("Окно уже разрушено.")

    def request_show() -> None:
        """Пункт «Открыть окно» из меню трея."""
        try:
            window.show()
            window.restore()
        except Exception:  # noqa: BLE001
            logger.debug("Не удалось показать окно.")

    tray = TrayController(on_show=request_show, on_quit=request_quit)
    tray.start()

    if tray.available:
        notifier.register_sink(tray.notify)

        def on_closing() -> bool:
            """Прячет окно вместо выхода, пока жив значок в трее.

            Возврат ``False`` отменяет закрытие. Именно это делает
            «напоминания при закрытом окне» возможными: процесс продолжает
            жить, планировщик работает.
            """
            if quitting["value"]:
                return True
            window.hide()
            tray.notify(
                APP_NAME,
                "Приложение свёрнуто в трей и продолжит напоминать о сроках."
            )
            return False

        try:
            window.events.closing += on_closing
        except Exception:  # noqa: BLE001 — старая версия PyWebView без событий
            logger.info("События окна недоступны: закрытие завершает приложение.")

    # На Windows бэкенд задаётся явно: автоопределение может выбрать устаревший
    # MSHTML, в котором backdrop-filter и Matter.js работать не будут.
    # Компонент просмотра задаётся явно там, где автоматический выбор
    # ненадёжен. На Windows он может подставить устаревший MSHTML, где не
    # работают ни backdrop-filter, ни физический движок. На macOS выбирать
    # не из чего: WebKit входит в систему и всегда достаточно свеж.
    if IS_WINDOWS:
        gui_backend = "edgechromium"
    elif IS_MACOS:
        gui_backend = None
    else:
        gui_backend = "gtk"

    try:
        # Блокирующий вызов: возвращает управление после закрытия окна.
        webview.start(gui=gui_backend, debug=not IS_FROZEN)
    except KeyboardInterrupt:
        logger.info("Прервано пользователем.")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Не удалось открыть окно приложения.")
        show_message(f"Окно приложения не открылось: {exc}\n\nЖурнал: {LOG_FILE}")
        return 1
    finally:
        notifier.register_sink(None)
        tray.stop()
        backend.shutdown()
        release_single_instance_lock()

    return 0


if __name__ == "__main__":
    # Обязательно первой строкой: без этого собранный .exe при создании
    # дочернего процесса запускает копию самого себя вместо воркера.
    multiprocessing.freeze_support()
    sys.exit(main())
