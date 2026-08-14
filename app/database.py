"""Асинхронный слой доступа к SQLite (SQLAlchemy 2.0 + aiosqlite).

Модуль предоставляет:

* сконфигурированный ``engine`` и фабрику сессий;
* FastAPI-зависимость :func:`get_session`;
* :func:`init_db` — создание схемы и бутстрап однопользовательских записей.
"""

from __future__ import annotations

import logging
from typing import AsyncGenerator

# SQLite выбрана как встраиваемая СУБД: она не требует отдельного сервера,
# хранит базу в одном файле и входит в стандартную поставку Python. Для
# однопользовательского настольного приложения это устраняет установку и
# настройку СУБД со стороны пользователя.
#
# aiosqlite добавляет асинхронный интерфейс поверх стандартного модуля
# sqlite3: обращения к диску выполняются в отдельном потоке и не
# останавливают цикл событий, обслуживающий HTTP-запросы.
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import DATABASE_URL, DEFAULT_SCENE, DEFAULT_USER_ID
from app.models import Base, Garden, SceneUnlock, Settings, User

logger = logging.getLogger(__name__)

engine: AsyncEngine = create_async_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    # SQLite в связке с asyncio использует пул из одного соединения на задачу;
    # check_same_thread отключаем, т.к. PyWebView запускает сервер в отдельном потоке.
    connect_args={"check_same_thread": False, "timeout": 15},
)

AsyncSessionFactory: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


@event.listens_for(engine.sync_engine, "connect")
def _configure_sqlite_connection(dbapi_connection, connection_record) -> None:  # noqa: ANN001
    """Включает контроль внешних ключей и WAL-режим для каждого соединения.

    SQLite по умолчанию игнорирует ``FOREIGN KEY``-ограничения, поэтому
    PRAGMA выставляется явно. WAL снижает вероятность блокировок при
    одновременном чтении из UI и записи из обработчиков API.
    """
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
    finally:
        cursor.close()


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI-зависимость: выдаёт сессию и гарантирует её закрытие.

    Транзакцией управляют сами обработчики (``await session.commit()``),
    что позволяет явно откатывать частично применённые изменения —
    например, при неудачной записи файла фона.

    Yields:
        AsyncSession: открытая сессия SQLAlchemy.
    """
    async with AsyncSessionFactory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


# Колонки, добавленные после первого релиза. ``create_all`` создаёт только
# отсутствующие таблицы и не трогает существующие, поэтому у пользователя со
# старой базой новых колонок не появилось бы — приложение падало бы на первом
# же запросе. Полноценная Alembic-миграция для одного файла SQLite избыточна.
_LIGHTWEIGHT_MIGRATIONS: tuple = (
    ("garden", "active_scene", "TEXT NOT NULL DEFAULT 'garden'"),
    ("tasks", "notified_at", "DATETIME"),
    ("tasks", "priority", "TEXT NOT NULL DEFAULT 'normal'"),
    ("tasks", "penalty", "INTEGER NOT NULL DEFAULT 0"),
    ("tasks", "failed_at", "DATETIME"),
    ("settings", "language", "TEXT NOT NULL DEFAULT 'ru'"),
    ("settings", "show_hints", "INTEGER NOT NULL DEFAULT 1"),
    ("settings", "rotate_ccw_key", "TEXT NOT NULL DEFAULT 'KeyQ'"),
    ("settings", "rotate_cw_key", "TEXT NOT NULL DEFAULT 'KeyE'"),
)


async def _normalize_defaults(conn) -> None:
    """Переносит настройки, чьё значение по умолчанию изменилось в коде.

    Колонка ``rotate_cw_key`` создавалась со значением ``KeyR``. После смены
    раскладки на ``Q``/``E`` у пользователей со старой базой осталась бы
    прежняя клавиша, причём молча: приложение работало бы, но подпись в
    настройках расходилась бы с фактическим поведением. Обновляем только
    записи, где значение совпадает со старым умолчанием — осознанный выбор
    пользователя не трогаем.

    Args:
        conn: активное соединение внутри транзакции.
    """
    result = await conn.execute(text("PRAGMA table_info(settings)"))
    columns = {row[1] for row in result.fetchall()}
    if "rotate_cw_key" not in columns:
        return

    await conn.execute(
        text("UPDATE settings SET rotate_cw_key = 'KeyE' WHERE rotate_cw_key = 'KeyR'")
    )


async def _apply_migrations(conn) -> None:
    """Добавляет недостающие колонки в уже существующие таблицы.

    Args:
        conn: активное соединение внутри транзакции.
    """
    for table, column, definition in _LIGHTWEIGHT_MIGRATIONS:
        result = await conn.execute(text(f"PRAGMA table_info({table})"))
        existing = {row[1] for row in result.fetchall()}
        if not existing:
            continue  # таблицы ещё нет — её создаст create_all
        if column not in existing:
            await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))
            logger.info("Миграция: %s.%s добавлена", table, column)


async def init_db() -> None:
    """Создаёт таблицы, применяет миграции и готовит стартовые записи.

    Приложение однопользовательское: запись ``users``, строка ``garden`` и
    разблокировка стартовой сцены создаются при первом запуске.
    Функция идемпотентна.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _apply_migrations(conn)
        await _normalize_defaults(conn)

    async with AsyncSessionFactory() as session:
        user = await session.get(User, DEFAULT_USER_ID)
        if user is None:
            user = User(id=DEFAULT_USER_ID, focus_tokens=0)
            session.add(user)
            # Пользователя нужно материализовать до зависимых строк: обе
            # таблицы ниже ссылаются на users.id внешним ключом, а SQLite
            # проверяет его сразу на INSERT, а не в конце транзакции.
            await session.flush()
            logger.info("Создан пользователь по умолчанию id=%s", DEFAULT_USER_ID)

        garden = await session.get(Garden, DEFAULT_USER_ID)
        if garden is None:
            session.add(Garden(
                user_id=DEFAULT_USER_ID,
                bg_image_path=None,
                tree_level=1,
                active_scene=DEFAULT_SCENE,
            ))
            logger.info("Инициализирован сад для пользователя id=%s", DEFAULT_USER_ID)

        # Стартовая сцена бесплатна и должна быть доступна всегда, включая
        # базы, созданные до появления магазина.
        starter = await session.get(SceneUnlock, (DEFAULT_USER_ID, DEFAULT_SCENE))
        if starter is None:
            session.add(SceneUnlock(
                user_id=DEFAULT_USER_ID, scene_key=DEFAULT_SCENE, price_paid=0
            ))

        settings = await session.get(Settings, DEFAULT_USER_ID)
        if settings is None:
            session.add(Settings(user_id=DEFAULT_USER_ID))
            logger.info("Созданы настройки по умолчанию для id=%s", DEFAULT_USER_ID)

        await session.commit()


async def dispose_db() -> None:
    """Закрывает пул соединений при остановке приложения."""
    await engine.dispose()


async def get_default_user(session: AsyncSession) -> User:
    """Возвращает пользователя по умолчанию.

    Args:
        session: активная сессия SQLAlchemy.

    Returns:
        User: запись пользователя.

    Raises:
        RuntimeError: если БД не была инициализирована через :func:`init_db`.
    """
    user = await session.scalar(select(User).where(User.id == DEFAULT_USER_ID))
    if user is None:
        raise RuntimeError(
            "Пользователь по умолчанию отсутствует: init_db() не был вызван."
        )
    return user
