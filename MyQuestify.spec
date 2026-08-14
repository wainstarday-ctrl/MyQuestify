# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller-спецификация MyQuestify (Windows, onefile).

Сборка::

    pyinstaller MyQuestify.spec --noconfirm

Что здесь решается и почему:

* **datas** — статика, шаблон и иконка кладутся внутрь архива. Без них
  ``.exe`` запустится, но отдаст 404 на главной странице.
* **hiddenimports** — uvicorn, SQLAlchemy и python-multipart подгружают
  часть модулей строкой во время выполнения. Статический анализ их не
  видит, и без явного перечисления приложение падает уже после старта:
  на первом запросе или при инициализации БД.
* **llama-cpp-python** — опционален и тянет за собой нативные DLL. Он
  включается автоматически, если установлен; иначе сборка идёт без него,
  а приложение работает на резервных фразах.
* **console=False** — окно консоли не мигает при запуске. Из-за этого
  ``sys.stdout``/``sys.stderr`` равны ``None``, что уже учтено в
  ``app.logging_setup``.

Переменные окружения:

* ``MYQUESTIFY_NO_LLM=1`` — принудительно собрать без llama-cpp-python
  (сборка становится примерно на 100–300 МБ легче).
* ``MYQUESTIFY_ONEDIR=1`` — собрать каталогом вместо одного файла:
  запуск быстрее, потому что нет распаковки во временную папку.
"""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

PROJECT_ROOT = Path(SPECPATH).resolve()

ONEDIR = os.environ.get("MYQUESTIFY_ONEDIR") == "1"
SKIP_LLM = os.environ.get("MYQUESTIFY_NO_LLM") == "1"

# --------------------------------------------------------------------------- #
# Проверки, которые дешевле сделать до сборки
# --------------------------------------------------------------------------- #

matter_js = PROJECT_ROOT / "static" / "js" / "vendor" / "matter.min.js"
if not matter_js.is_file():
    print(
        "\n[MyQuestify] ВНИМАНИЕ: static/js/vendor/matter.min.js отсутствует.\n"
        "              Сборка продолжится, но в .exe не будет физического движка,\n"
        "              и Сад Вдохновения покажет заглушку.\n",
        file=sys.stderr,
    )

icon_file = PROJECT_ROOT / "assets" / "icon.ico"
if not icon_file.is_file():
    print(
        "[MyQuestify] Иконка не найдена — выполни `python tools/make_icon.py`.",
        file=sys.stderr,
    )

# --------------------------------------------------------------------------- #
# Ресурсы
# --------------------------------------------------------------------------- #

datas = [
    ("static", "static"),
    ("templates", "templates"),
]

if icon_file.is_file():
    datas.append(("assets", "assets"))

binaries = []

# --------------------------------------------------------------------------- #
# Скрытые импорты
# --------------------------------------------------------------------------- #

hiddenimports = [
    # uvicorn выбирает реализации по строкам в рантайме.
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # Диалект SQLite подключается по имени из строки соединения.
    "aiosqlite",
    "sqlalchemy.dialects.sqlite",
    "sqlalchemy.dialects.sqlite.aiosqlite",
    # python-multipart ставится под другим именем, чем импортируется.
    "multipart",
    "python_multipart",
    # Бэкенд PyWebView на Windows.
    "webview.platforms.edgechromium",
    # Трей: pystray выбирает бэкенд по строке в рантайме.
    "pystray._win32",
    "PIL._tkinter_finder",
    "clr_loader",
    "clr_loader.netfx",
]

if sys.platform.startswith("win"):
    hiddenimports.append("winreg")

# --------------------------------------------------------------------------- #
# Опциональная локальная модель
# --------------------------------------------------------------------------- #

llm_bundled = False
if not SKIP_LLM:
    try:
        import llama_cpp  # noqa: F401

        binaries += collect_dynamic_libs("llama_cpp")
        datas += collect_data_files("llama_cpp")
        hiddenimports.append("llama_cpp")
        llm_bundled = True
    except ImportError:
        print(
            "[MyQuestify] llama-cpp-python не установлен — сборка без локальной модели.",
            file=sys.stderr,
        )

excludes = [
    "tkinter",
    "matplotlib",
    "pytest",
]
if not llm_bundled:
    excludes += ["numpy", "scipy"]

# --------------------------------------------------------------------------- #
# Сборка
# --------------------------------------------------------------------------- #

a = Analysis(
    ["run.py"],
    pathex=[str(PROJECT_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe_kwargs = dict(
    name="MyQuestify",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,               # UPX ломает нативные DLL llama.cpp и триггерит антивирусы
    console=False,           # windowed-режим: см. app/logging_setup.py
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(icon_file) if icon_file.is_file() else None,
)

if ONEDIR:
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, **exe_kwargs)
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name="MyQuestify",
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        runtime_tmpdir=None,
        **exe_kwargs,
    )
