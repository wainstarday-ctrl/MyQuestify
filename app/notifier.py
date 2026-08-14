"""Фоновые напоминания о приближающихся дедлайнах.

Планировщик живёт внутри серверного процесса и просыпается раз в минуту.
Для каждого квеста, срок которого входит в окно предупреждения, он просит
модель сочинить короткую фразу и передаёт её «приёмнику» — функции, которую
регистрирует оболочка (``run.py``). Сам модуль ничего не знает ни о значке в
трее, ни о всплывающих окнах Windows: так его можно проверить без GUI и
переиспользовать при переносе на другую платформу.

Ключевое ограничение, о котором стоит помнить: пока процесс не запущен,
напоминаний нет. Уведомления после закрытия окна работают потому, что окно
сворачивается в трей, а не завершает приложение. Полностью независимая от
процесса доставка потребовала бы задачи в «Планировщике заданий» Windows —
это отдельная установка, а не часть приложения.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Callable, List, Optional

from sqlalchemy import select

from app import ai_module
from app.config import DEFAULT_LANGUAGE, DEFAULT_USER_ID
from app.database import AsyncSessionFactory
from app.models import Settings, Task, TaskStatus, ensure_utc, utcnow

logger = logging.getLogger("myquestify.notifier")

#: Как часто планировщик просыпается.
TICK_SECONDS: float = 60.0

#: Сколько напоминаний максимум за один проход. Ограничение защищает от
#: лавины окон, если пользователь завёл десяток квестов с одним сроком.
MAX_PER_TICK: int = 3

#: Тип приёмника уведомлений: (заголовок, текст) -> None.
NotificationSink = Callable[[str, str], None]

_sink: Optional[NotificationSink] = None
_task: Optional[asyncio.Task] = None


def register_sink(sink: Optional[NotificationSink]) -> None:
    """Назначает приёмник уведомлений.

    Args:
        sink: функция показа уведомления либо ``None``, чтобы отключить.
    """
    global _sink
    _sink = sink
    logger.info("Приёмник уведомлений %s", "подключён" if sink else "отключён")


def _dispatch(title: str, message: str) -> None:
    """Передаёт уведомление приёмнику, не давая его ошибке уронить цикл."""
    if _sink is None:
        logger.info("Уведомление (приёмник не подключён): %s — %s", title, message)
        return
    try:
        _sink(title, message)
    except Exception:  # noqa: BLE001 — сбой показа не должен останавливать планировщик
        logger.exception("Не удалось показать уведомление.")


async def _language() -> str:
    """Возвращает язык интерфейса из настроек.

    Планировщик работает независимо от открытого окна, поэтому язык берётся
    из базы, а не передаётся клиентом.

    Returns:
        str: код языка.
    """
    async with AsyncSessionFactory() as session:
        settings = await session.get(Settings, DEFAULT_USER_ID)
        return (settings.language if settings else None) or DEFAULT_LANGUAGE


async def _collect_due() -> List[tuple]:
    """Находит квесты, о которых пора напомнить, и помечает их отправленными.

    Пометка ставится в той же транзакции, что и выборка: иначе долгая
    генерация фразы моделью успела бы наложиться на следующий тик, и
    пользователь получил бы два одинаковых напоминания.

    Returns:
        List[tuple]: пары ``(название, минут до срока)``.
    """
    async with AsyncSessionFactory() as session:
        settings = await session.get(Settings, DEFAULT_USER_ID)
        if settings is not None and not settings.notifications_enabled:
            return []

        lead = settings.notify_lead_minutes if settings else 60
        now = utcnow()
        horizon = now + timedelta(minutes=lead)

        result = await session.scalars(
            select(Task)
            .where(
                Task.user_id == DEFAULT_USER_ID,
                Task.status == TaskStatus.PENDING,
                Task.deadline.is_not(None),
                Task.notified_at.is_(None),
            )
            .order_by(Task.deadline.asc())
            .limit(MAX_PER_TICK * 2)
        )

        due = []
        for task in result.all():
            deadline = ensure_utc(task.deadline)
            if deadline is None or deadline > horizon:
                continue
            minutes_left = max(0, int((deadline - now).total_seconds() // 60))
            task.notified_at = now
            due.append((task.title, minutes_left))
            if len(due) >= MAX_PER_TICK:
                break

        if due:
            await session.commit()
        return due


async def _sweep_penalties() -> None:
    """Закрывает просроченные квесты и уведомляет о списании."""
    from app.main import apply_overdue_penalties  # локальный импорт: циклическая зависимость

    async with AsyncSessionFactory() as session:
        failed, _, lost = await apply_overdue_penalties(session)

    if failed:
        titles = ", ".join(item.title[:30] for item in failed[:3])
        language = await _language()
        if language == "en":
            _dispatch(
                f"Overdue: {len(failed)}",
                f"{titles} — {lost} FT deducted. The deadlines have passed.",
            )
        else:
            _dispatch(
                f"Просрочено: {len(failed)}",
                f"{titles} — списано {lost} FT. Сроки прошли.",
            )


async def _loop() -> None:
    """Основной цикл планировщика."""
    logger.info("Планировщик напоминаний запущен (тик %s с).", TICK_SECONDS)
    try:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                # Штрафы применяет тот же код, что и маршрут: правило одно,
                # иначе баланс зависел бы от того, открыто ли окно.
                await _sweep_penalties()

                due = await _collect_due()
                if due:
                    language = await _language()

                for title, minutes_left in due:
                    phrase = await ai_module.deadline_nudge(title, minutes_left, language)
                    if language == "en":
                        heading = (
                            f"Deadline near: {title[:60]}"
                            if minutes_left > 0
                            else f"Deadline reached: {title[:60]}"
                        )
                    else:
                        heading = (
                            f"Срок близко: {title[:60]}"
                            if minutes_left > 0
                            else f"Срок наступил: {title[:60]}"
                        )
                    _dispatch(heading, phrase)
            except Exception:  # noqa: BLE001 — один сбойный тик не выключает цикл
                logger.exception("Ошибка в тике планировщика.")
    except asyncio.CancelledError:
        logger.info("Планировщик напоминаний остановлен.")
        raise


def start() -> None:
    """Запускает планировщик как фоновую задачу event loop."""
    global _task
    if _task is not None and not _task.done():
        return
    _task = asyncio.create_task(_loop(), name="myquestify-notifier")


async def stop() -> None:
    """Останавливает планировщик и дожидается завершения задачи."""
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    finally:
        _task = None
