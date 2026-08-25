"""FastAPI-приложение MyQuestify.

Точка сборки проекта: маршруты API, отдача статики и UI, управление
жизненным циклом (инициализация БД, выгрузка LLM).

Статика монтируется двумя раздельными путями:

* ``/static`` → каталог ресурсов сборки (только чтение);
* ``/media``  → каталог загрузок в профиле пользователя (чтение и запись).

В базе хранится только имя файла фона; публичный URL собирается на лету.
Так расположение каталога данных можно менять между платформами, не мигрируя
БД — что понадобится при переносе на Android.

Сервер сознательно привязан к ``127.0.0.1``: приложение десктопное,
работает в offline-режиме и не должно быть доступно из локальной сети.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import AsyncIterator, List, Optional

# FastAPI выбран вместо Flask по двум причинам, существенным для проекта.
# Во-первых, встроенная валидация через Pydantic: правила проверки данных
# описываются один раз в схеме и применяются автоматически, без ручных
# условий в каждом обработчике. Во-вторых, нативная поддержка async/await —
# генерация ответа моделью занимает секунды, и синхронный фреймворк
# блокировал бы весь сервер на это время.
from fastapi import Depends, FastAPI, HTTPException, Path as PathParam, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
# SQLAlchemy используется вместо прямых SQL-запросов через sqlite3, чтобы
# схема данных описывалась в одном месте (app/models.py) и проверялась на
# уровне типов. Дополнительно ORM защищает от SQL-инъекций: параметры
# подставляются через плейсхолдеры, а не конкатенацией строк.
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import ai_module, notifier
from app.oracle_safety import Verdict, guard_reply, screen
from app.config import (
    APP_VERSION,
    DEFAULT_LANGUAGE,
    BACKGROUND_PRICE,
    DATA_DIR,
    DEFAULT_SCENE,
    DEFAULT_USER_ID,
    INDEX_FILE,
    IS_FROZEN,
    MAX_TREE_LEVEL,
    DEFAULT_PRIORITY,
    MEDIA_URL_PREFIX,
    PENALTY_GRACE_MINUTES,
    PENALTY_RATE,
    PRIORITIES,
    SCENES,
    STATIC_DIR,
    TASKS_PER_TREE_LEVEL,
    LLM_MODEL_PATH,
    MODELS_DIR,
    _bundled_model_candidates,
    adopt_bundled_model,
    localize,
    TOKENS_PER_HOUR,
    UPLOADS_DIR,
    ensure_runtime_dirs,
)
from app.database import dispose_db, get_default_user, get_session, init_db
from app.models import (
    Garden,
    OracleMessage,
    SceneUnlock,
    Settings,
    Task,
    TaskStatus,
    Thought,
    User,
    ensure_utc,
    utcnow,
)
from app.schemas import (
    ErrorResponse,
    GardenRead,
    MonthlyStat,
    OracleAsk,
    OracleMessageRead,
    OracleReply,
    OverdueSweepResponse,
    SettingsRead,
    SettingsUpdate,
    TaskPenaltyRead,
    TaskUpdate,
    ThoughtCreate,
    ThoughtRead,
    ThoughtUpdate,
    SceneRead,
    ScenePurchaseResponse,
    SceneSelectResponse,
    TaskCompleteResponse,
    TaskCreate,
    TaskRead,
)

logger = logging.getLogger("myquestify.api")


# --------------------------------------------------------------------------- #
# Жизненный цикл
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Готовит окружение при старте и корректно освобождает ресурсы при выходе."""
    ensure_runtime_dirs()

    # Перенос весов из поставки выполняется до инициализации модуля модели,
    # иначе первая проверка наличия файла дала бы отрицательный результат и
    # приложение сообщило бы, что модель не найдена.
    if adopt_bundled_model():
        logger.info("Веса модели перенесены из поставки в %s", MODELS_DIR)
    elif not LLM_MODEL_PATH.is_file():
        # Перечень проверенных мест выводится в журнал: сообщение «модель не
        # найдена» при физически присутствующем файле иначе не поддаётся
        # разбору — непонятно, куда именно смотрело приложение.
        logger.info(
            "Веса модели не найдены. Ожидаются в %s. Проверены также: %s",
            LLM_MODEL_PATH,
            ", ".join(str(path) for path in _bundled_model_candidates()),
        )

    await init_db()
    notifier.start()
    logger.info(
        "MyQuestify %s запущен (frozen=%s). Данные: %s. LLM доступна: %s",
        APP_VERSION, IS_FROZEN, DATA_DIR, ai_module.is_model_available(),
    )
    try:
        yield
    finally:
        await notifier.stop()
        await ai_module.shutdown()
        await dispose_db()
        logger.info("MyQuestify остановлен.")


app = FastAPI(
    title="MyQuestify API",
    description="Локальный геймифицированный таск-трекер с офлайн ИИ-мотивацией.",
    version=APP_VERSION,
    lifespan=lifespan,
)

# Единственный разрешённый источник — сам локальный сервер (PyWebView грузит
# страницу с него же). Внешние origin'ы не допускаются.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["*"],
)

# Каталоги должны существовать до монтирования: StaticFiles проверяет путь
# в момент создания и падает на отсутствующей директории.
ensure_runtime_dirs()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount(MEDIA_URL_PREFIX, StaticFiles(directory=UPLOADS_DIR), name="media")


# --------------------------------------------------------------------------- #
# Вспомогательные функции доменной логики
# --------------------------------------------------------------------------- #

async def _owned_scene_keys(session: AsyncSession, user_id: int = DEFAULT_USER_ID) -> set:
    """Возвращает множество ключей сцен, купленных пользователем."""
    result = await session.scalars(
        select(SceneUnlock.scene_key).where(SceneUnlock.user_id == user_id)
    )
    return set(result.all())


async def _scene_catalog(session: AsyncSession, active_scene: str) -> List[SceneRead]:
    """Собирает витрину магазина: каталог из кода плюс флаги владения.

    Каталог живёт в :data:`app.config.SCENES`, а не в базе: список сцен
    меняется вместе с кодом, который их рисует, поэтому дублировать его в
    таблице значило бы иметь два источника правды.

    Args:
        session: активная сессия.
        active_scene: ключ выбранной сейчас сцены.

    Returns:
        List[SceneRead]: позиции витрины в порядке каталога.
    """
    owned = await _owned_scene_keys(session)
    language = await _language(session)
    return [
        SceneRead(
            key=key,
            title=localize(meta["title"], language),
            tagline=localize(meta["tagline"], language),
            description=localize(meta["description"], language),
            price=meta["price"],
            owned=key in owned or meta["price"] == 0,
            active=key == active_scene,
        )
        for key, meta in SCENES.items()
    ]


async def _language(session: AsyncSession) -> str:
    """Возвращает язык интерфейса из настроек пользователя.

    Язык хранится на сервере, а не передаётся клиентом в каждом запросе:
    от него зависит и фоновая генерация — напоминания о сроках приходят,
    когда интерфейс закрыт и спросить его не у кого.

    Args:
        session: активная сессия.

    Returns:
        str: код языка; при отсутствии настроек — язык по умолчанию.
    """
    settings = await session.get(Settings, DEFAULT_USER_ID)
    return (settings.language if settings else None) or DEFAULT_LANGUAGE


def _background_url(filename: Optional[str]) -> Optional[str]:
    """Собирает публичный URL фона из имени файла.

    Args:
        filename: имя файла в каталоге загрузок либо ``None``.

    Returns:
        Optional[str]: URL вида ``/media/<файл>`` или ``None``.
    """
    return f"{MEDIA_URL_PREFIX}/{filename}" if filename else None


def _serialize_task(task: Task) -> TaskRead:
    """Преобразует ORM-задачу в схему ответа, вычисляя просрочку на лету."""
    return TaskRead(
        id=task.id,
        title=task.title,
        estimated_hours=task.estimated_hours,
        reward=task.reward,
        status=task.status,
        motivation=task.motivation,
        created_at=ensure_utc(task.created_at),
        deadline=ensure_utc(task.deadline),
        completed_at=ensure_utc(task.completed_at),
        is_overdue=task.is_overdue,
        priority=task.priority or DEFAULT_PRIORITY,
        penalty=task.penalty or 0,
    )


def _calculate_reward(estimated_hours: int, priority: str = DEFAULT_PRIORITY) -> int:
    """Считает награду с учётом приоритета.

    База — ``estimated_hours * TOKENS_PER_HOUR``, затем множитель приоритета.
    Округление вверх, чтобы срочный квест на час не давал дробь.

    Args:
        estimated_hours: оценка в часах.
        priority: ключ из :data:`app.config.PRIORITIES`.

    Returns:
        int: награда в токенах.
    """
    meta = PRIORITIES.get(priority) or PRIORITIES[DEFAULT_PRIORITY]
    base = estimated_hours * TOKENS_PER_HOUR
    return int(round(base * meta["reward_multiplier"]))


def _calculate_penalty(task: Task) -> int:
    """Считает штраф за просроченный квест.

    Штраф равен половине награды. Приоритет учтён в самой награде, поэтому
    срыв срочного квеста обходится дороже автоматически, без отдельного
    множителя.

    Args:
        task: просроченный квест.

    Returns:
        int: сколько токенов снять (не больше награды).
    """
    penalty = int(round(task.reward * PENALTY_RATE))
    return max(0, min(penalty, task.reward))


async def _recalculate_tree_level(session: AsyncSession, garden: Garden) -> int:
    """Пересчитывает уровень дерева по числу завершённых задач.

    Уровень растёт на единицу за каждые :data:`TASKS_PER_TREE_LEVEL`
    завершённых задач и ограничен :data:`MAX_TREE_LEVEL`. Расчёт от факта
    (а не инкрементом) делает состояние сада воспроизводимым: удаление или
    ручная правка задач не оставляет уровень рассинхронизированным.

    Args:
        session: активная сессия.
        garden: запись сада, подлежащая обновлению.

    Returns:
        int: актуальный уровень дерева.
    """
    completed_count = await session.scalar(
        select(func.count())
        .select_from(Task)
        .where(Task.user_id == garden.user_id, Task.status == TaskStatus.COMPLETED)
    )
    level = 1 + (int(completed_count or 0) // TASKS_PER_TREE_LEVEL)
    garden.tree_level = min(level, MAX_TREE_LEVEL)
    return garden.tree_level


async def _commit_if_changed(session: AsyncSession) -> bool:
    """Сохраняет изменения, если они есть.

    Читающие обработчики всё же вынуждены завершать сделку: ``_get_garden`` и
    ``_get_settings`` создают недостающую строку при первом обращении, и без
    сохранения она пропадала бы. Но создаётся она однажды, а обработчик
    вызывается при каждом обновлении интерфейса — открытие списка квестов,
    чтение сада, чтение настроек идут подряд, и каждое завершало сделку
    впустую.

    Пустое завершение не бесплатно: SQLite записывает отметку в журнал и
    сбрасывает её на диск. Режим WAL делает это дешевле, но не даром, а на
    настольном приложении обращения к диску складываются с тем, что делает
    в это же время оболочка окна.

    Проверка идёт по составу сделки, а не по методу запроса: обработчик
    может создать строку и при чтении, и решать это должен он сам, а не
    правило, записанное где-то ещё.

    Args:
        session: текущая сделка с базой.

    Returns:
        bool: было ли что сохранять.
    """
    if not (session.new or session.dirty or session.deleted):
        return False

    await session.commit()
    return True


async def _get_garden(session: AsyncSession, user_id: int = DEFAULT_USER_ID) -> Garden:
    """Возвращает сад пользователя, создавая запись при её отсутствии."""
    garden = await session.get(Garden, user_id)
    if garden is None:
        garden = Garden(user_id=user_id, bg_image_path=None, tree_level=1)
        session.add(garden)
        await session.flush()
    return garden


# --------------------------------------------------------------------------- #
# UI
# --------------------------------------------------------------------------- #

@app.get("/", include_in_schema=False)
async def serve_index() -> FileResponse:
    """Отдаёт единственную HTML-страницу приложения.

    Raises:
        HTTPException: если ``templates/index.html`` не попал в сборку.
    """
    if not INDEX_FILE.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"index.html не найден: {INDEX_FILE}",
        )
    return FileResponse(INDEX_FILE, media_type="text/html")


@app.get("/api/health", include_in_schema=False)
async def health() -> JSONResponse:
    """Диагностика: режим запуска, наличие весов LLM и путь к данным.

    Путь к каталогу данных отдаётся намеренно — после упаковки в ``.exe``
    база лежит в профиле пользователя, и это единственный быстрый способ
    узнать где именно, не открывая лог.
    """
    return JSONResponse({
        "status": "ok",
        "version": APP_VERSION,
        "frozen": IS_FROZEN,
        "llm_available": ai_module.is_model_available(),
        "llm_backend": ai_module.is_backend_available(),
        "model_path": str(LLM_MODEL_PATH),
        "data_dir": str(DATA_DIR),
    })


# --------------------------------------------------------------------------- #
# Задачи
# --------------------------------------------------------------------------- #

@app.get(
    "/api/tasks/",
    response_model=List[TaskRead],
    summary="Список задач",
    tags=["tasks"],
)
async def list_tasks(session: AsyncSession = Depends(get_session)) -> List[TaskRead]:
    """Возвращает все задачи пользователя.

    Порядок: завершённые в конце, остальные по приоритету — срочные выше
    обычных, обычные выше спокойных, — затем по сроку и дате создания.
    Просроченные остаются среди открытых: их можно доделать.
    """
    result = await session.scalars(
        select(Task)
        .where(Task.user_id == DEFAULT_USER_ID)
        .order_by(
            # Вниз уходит только завершённое. Просроченный квест остаётся
            # среди открытых: его можно доделать и получить половину
            # награды, а спрятанный в конце списка он будет забыт.
            (Task.status == TaskStatus.COMPLETED).asc(),
            # Срочное вверху среди невыполненных: CASE вместо сортировки по
            # строке, иначе «high» оказался бы после «low» по алфавиту.
            case(
                (Task.priority == "high", 1),
                (Task.priority == "normal", 2),
                else_=3,
            ).asc(),
            Task.deadline.is_(None).asc(),
            Task.deadline.asc(),
            Task.created_at.desc(),
        )
    )
    return [_serialize_task(task) for task in result.all()]


@app.post(
    "/api/tasks/",
    response_model=TaskRead,
    status_code=status.HTTP_201_CREATED,
    summary="Создать задачу",
    tags=["tasks"],
)
async def create_task(
    payload: TaskCreate,
    session: AsyncSession = Depends(get_session),
) -> TaskRead:
    """Создаёт задачу и генерирует мотивирующую фразу локальной моделью.

    Награда фиксируется сразу по формуле ``estimated_hours * 10`` и
    начисляется позже, при завершении задачи.

    Args:
        payload: валидированные входные данные.
        session: сессия БД.

    Returns:
        TaskRead: созданная задача с полем ``motivation``.
    """
    language = await _language(session)
    motivation = await ai_module.generate_motivation(payload.title, language)

    task = Task(
        user_id=DEFAULT_USER_ID,
        title=payload.title,
        estimated_hours=payload.estimated_hours,
        reward=_calculate_reward(payload.estimated_hours, payload.priority),
        status=TaskStatus.PENDING,
        motivation=motivation,
        deadline=payload.deadline,
        priority=payload.priority,
    )
    session.add(task)
    await session.commit()
    await session.refresh(task)

    logger.info("Создана задача id=%s (награда: %s)", task.id, task.reward)
    return _serialize_task(task)


@app.patch(
    "/api/tasks/{task_id}/complete",
    response_model=TaskCompleteResponse,
    summary="Завершить задачу и начислить токены",
    tags=["tasks"],
    responses={
        404: {"model": ErrorResponse, "description": "Квест не найден"},
        409: {"model": ErrorResponse, "description": "Квест уже завершён"},
    },
)
async def complete_task(
    task_id: int = PathParam(..., ge=1, description="Идентификатор задачи"),
    session: AsyncSession = Depends(get_session),
) -> TaskCompleteResponse:
    """Переводит задачу в статус ``completed`` и начисляет focus-токены.

    Просроченный квест завершить можно: штраф за истечение срока удержан
    отдельно, и суммарно опоздавший получает половину награды. Повторное
    завершение отклоняется с кодом 409, поэтому награда не начисляется
    дважды.

    Args:
        task_id: идентификатор задачи.
        session: сессия БД.

    Returns:
        TaskCompleteResponse: задача, новый баланс и уровень дерева.

    Raises:
        HTTPException: 404 — задача не найдена; 409 — задача уже завершена
            или провалена.
    """
    task = await session.get(Task, task_id)
    if task is None or task.user_id != DEFAULT_USER_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Задача не найдена"
        )
    # Завершать разрешено и просроченный квест: штраф уже удержан, и с
    # учётом полной награды опоздавший получает половину. Запрет наказывал
    # бы за попытку доделать работу. Повторное завершение отклоняется —
    # иначе награду можно было бы начислить дважды.
    if task.status is TaskStatus.COMPLETED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Квест уже завершён",
        )

    user: User = await get_default_user(session)
    garden = await _get_garden(session)

    tokens_earned = _calculate_reward(task.estimated_hours, task.priority or DEFAULT_PRIORITY)

    task.status = TaskStatus.COMPLETED
    task.completed_at = utcnow()
    # Завершённый квест не должен напомнить о себе следующим тиком.
    task.notified_at = task.notified_at or utcnow()
    task.reward = tokens_earned
    user.focus_tokens += tokens_earned

    await session.flush()
    tree_level = await _recalculate_tree_level(session, garden)

    await session.commit()
    await session.refresh(task)

    logger.info(
        "Задача id=%s завершена: +%s токенов (баланс: %s, уровень дерева: %s)",
        task.id, tokens_earned, user.focus_tokens, tree_level,
    )

    return TaskCompleteResponse(
        task=_serialize_task(task),
        focus_tokens=user.focus_tokens,
        tokens_earned=tokens_earned,
        tree_level=tree_level,
    )


# --------------------------------------------------------------------------- #
# Состояние сцены
# --------------------------------------------------------------------------- #

@app.get(
    "/api/garden/",
    response_model=GardenRead,
    summary="Состояние сада",
    tags=["garden"],
)
async def read_garden(session: AsyncSession = Depends(get_session)) -> GardenRead:
    """Возвращает фон, уровень дерева и текущий баланс токенов."""
    user = await get_default_user(session)
    garden = await _get_garden(session)
    await _commit_if_changed(session)

    return GardenRead(
        user_id=garden.user_id,
        bg_image_path=_background_url(garden.bg_image_path),
        tree_level=garden.tree_level,
        focus_tokens=user.focus_tokens,
        background_price=BACKGROUND_PRICE,
        active_scene=garden.active_scene or DEFAULT_SCENE,
        scenes=await _scene_catalog(session, garden.active_scene or DEFAULT_SCENE),
    )


# --------------------------------------------------------------------------- #
# Магазин сцен
# --------------------------------------------------------------------------- #

@app.get(
    "/api/shop/",
    response_model=List[SceneRead],
    summary="Витрина сцен",
    tags=["shop"],
)
async def read_shop(session: AsyncSession = Depends(get_session)) -> List[SceneRead]:
    """Возвращает каталог сцен с отметками о покупке и активности."""
    garden = await _get_garden(session)
    await _commit_if_changed(session)
    return await _scene_catalog(session, garden.active_scene or DEFAULT_SCENE)


@app.post(
    "/api/shop/{scene_key}/purchase",
    response_model=ScenePurchaseResponse,
    summary="Купить сцену",
    tags=["shop"],
    responses={
        402: {"model": ErrorResponse, "description": "Недостаточно токенов"},
        404: {"model": ErrorResponse, "description": "Сцена отсутствует в каталоге"},
        409: {"model": ErrorResponse, "description": "Сцена уже куплена"},
    },
)
async def purchase_scene(
    scene_key: str = PathParam(..., description="Ключ сцены из каталога"),
    session: AsyncSession = Depends(get_session),
) -> ScenePurchaseResponse:
    """Покупает сцену, списывает токены и делает её активной.

    Повторную покупку отсекает первичный ключ таблицы, поэтому двойное
    списание невозможно даже при двух одновременных запросах.

    Args:
        scene_key: ключ сцены.
        session: сессия БД.

    Returns:
        ScenePurchaseResponse: новый баланс и обновлённая витрина.

    Raises:
        HTTPException: 404 — нет в каталоге; 409 — уже куплена;
            402 — не хватает токенов.
    """
    meta = SCENES.get(scene_key)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Сцена «{scene_key}» отсутствует в каталоге",
        )

    existing = await session.get(SceneUnlock, (DEFAULT_USER_ID, scene_key))
    if existing is not None or meta["price"] == 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Сцена уже доступна"
        )

    user = await get_default_user(session)
    price = int(meta["price"])
    if user.focus_tokens < price:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Недостаточно токенов: нужно {price}, доступно {user.focus_tokens}",
        )

    garden = await _get_garden(session)
    user.focus_tokens -= price
    session.add(SceneUnlock(user_id=DEFAULT_USER_ID, scene_key=scene_key, price_paid=price))
    # Купленная сцена сразу становится активной: иначе покупка внешне
    # ничего не меняет и выглядит как несработавшая кнопка.
    garden.active_scene = scene_key

    await session.commit()
    logger.info("Куплена сцена %s за %s токенов (остаток: %s)", scene_key, price, user.focus_tokens)

    return ScenePurchaseResponse(
        focus_tokens=user.focus_tokens,
        tokens_spent=price,
        active_scene=scene_key,
        scenes=await _scene_catalog(session, scene_key),
    )


@app.patch(
    "/api/garden/scene/{scene_key}",
    response_model=SceneSelectResponse,
    summary="Переключить активную сцену",
    tags=["shop"],
    responses={
        403: {"model": ErrorResponse, "description": "Сцена не куплена"},
        404: {"model": ErrorResponse, "description": "Сцена отсутствует в каталоге"},
    },
)
async def select_scene(
    scene_key: str = PathParam(..., description="Ключ сцены из каталога"),
    session: AsyncSession = Depends(get_session),
) -> SceneSelectResponse:
    """Делает купленную сцену активной.

    Args:
        scene_key: ключ сцены.
        session: сессия БД.

    Returns:
        SceneSelectResponse: активная сцена и текущий уровень.

    Raises:
        HTTPException: 404 — нет в каталоге; 403 — не куплена.
    """
    meta = SCENES.get(scene_key)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Сцена «{scene_key}» отсутствует в каталоге",
        )

    owned = await _owned_scene_keys(session)
    if scene_key not in owned and meta["price"] != 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Сцена ещё не куплена",
        )

    garden = await _get_garden(session)
    garden.active_scene = scene_key
    await session.commit()

    return SceneSelectResponse(active_scene=scene_key, tree_level=garden.tree_level)


# --------------------------------------------------------------------------- #
# Цепочка мыслей
# --------------------------------------------------------------------------- #

def _thought_tree(nodes: List[Thought], parent_id: Optional[int] = None) -> List[ThoughtRead]:
    """Собирает дерево из плоского списка узлов.

    Рекурсия идёт по загруженному списку, а не по базе: одно обращение вместо
    запроса на каждый уровень вложенности.

    Args:
        nodes: все узлы квеста.
        parent_id: родитель текущего уровня.

    Returns:
        List[ThoughtRead]: узлы уровня со вложенными потомками.
    """
    return [
        ThoughtRead(
            id=node.id,
            task_id=node.task_id,
            parent_id=node.parent_id,
            text=node.text,
            done=node.done,
            generated=node.generated,
            children=_thought_tree(nodes, node.id),
        )
        for node in nodes
        if node.parent_id == parent_id
    ]


async def _load_thoughts(session: AsyncSession, task_id: int) -> List[Thought]:
    """Возвращает все узлы квеста в порядке отображения."""
    result = await session.scalars(
        select(Thought)
        .where(Thought.task_id == task_id)
        .order_by(Thought.position.asc(), Thought.id.asc())
    )
    return list(result.all())


async def _require_task(session: AsyncSession, task_id: int) -> Task:
    """Возвращает квест пользователя либо поднимает 404."""
    task = await session.get(Task, task_id)
    if task is None or task.user_id != DEFAULT_USER_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Квест не найден"
        )
    return task


@app.get(
    "/api/tasks/{task_id}/thoughts",
    response_model=List[ThoughtRead],
    summary="Цепочка мыслей квеста",
    tags=["thoughts"],
)
async def read_thoughts(
    task_id: int = PathParam(..., ge=1),
    session: AsyncSession = Depends(get_session),
) -> List[ThoughtRead]:
    """Возвращает дерево мыслей, разобранное по уровням вложенности."""
    await _require_task(session, task_id)
    return _thought_tree(await _load_thoughts(session, task_id))


@app.post(
    "/api/tasks/{task_id}/thoughts",
    response_model=ThoughtRead,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить мысль",
    tags=["thoughts"],
)
async def create_thought(
    payload: ThoughtCreate,
    task_id: int = PathParam(..., ge=1),
    session: AsyncSession = Depends(get_session),
) -> ThoughtRead:
    """Создаёт узел цепочки, при необходимости вложенный в другой.

    Raises:
        HTTPException: 404 — нет квеста; 400 — родитель из чужой цепочки.
    """
    await _require_task(session, task_id)

    if payload.parent_id is not None:
        parent = await session.get(Thought, payload.parent_id)
        if parent is None or parent.task_id != task_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Родительская мысль принадлежит другому квесту",
            )

    siblings = await session.scalar(
        select(func.count())
        .select_from(Thought)
        .where(Thought.task_id == task_id, Thought.parent_id == payload.parent_id)
    )

    thought = Thought(
        task_id=task_id,
        parent_id=payload.parent_id,
        text=payload.text,
        position=int(siblings or 0),
    )
    session.add(thought)
    await session.commit()
    await session.refresh(thought)

    return ThoughtRead(
        id=thought.id, task_id=thought.task_id, parent_id=thought.parent_id,
        text=thought.text, done=thought.done, generated=thought.generated, children=[],
    )


@app.patch(
    "/api/thoughts/{thought_id}",
    response_model=ThoughtRead,
    summary="Изменить мысль",
    tags=["thoughts"],
)
async def update_thought(
    payload: ThoughtUpdate,
    thought_id: int = PathParam(..., ge=1),
    session: AsyncSession = Depends(get_session),
) -> ThoughtRead:
    """Меняет текст узла и/или отметку выполнения."""
    thought = await session.get(Thought, thought_id)
    if thought is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Мысль не найдена"
        )
    await _require_task(session, thought.task_id)

    if payload.text is not None:
        thought.text = payload.text.strip()
    if payload.done is not None:
        thought.done = payload.done

    await session.commit()
    await session.refresh(thought)

    nodes = await _load_thoughts(session, thought.task_id)
    return ThoughtRead(
        id=thought.id, task_id=thought.task_id, parent_id=thought.parent_id,
        text=thought.text, done=thought.done, generated=thought.generated,
        children=_thought_tree(nodes, thought.id),
    )


@app.delete(
    "/api/thoughts/{thought_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить мысль вместе с поддеревом",
    tags=["thoughts"],
)
async def delete_thought(
    thought_id: int = PathParam(..., ge=1),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Удаляет узел и всех его потомков."""
    thought = await session.get(Thought, thought_id)
    if thought is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Мысль не найдена"
        )
    await _require_task(session, thought.task_id)

    await session.delete(thought)
    await session.commit()


@app.post(
    "/api/tasks/{task_id}/thoughts/expand",
    response_model=List[ThoughtRead],
    summary="Развернуть мысль моделью",
    tags=["thoughts"],
)
async def expand_thoughts(
    task_id: int = PathParam(..., ge=1),
    parent_id: Optional[int] = None,
    session: AsyncSession = Depends(get_session),
) -> List[ThoughtRead]:
    """Просит модель предложить три подшага и сохраняет их как узлы.

    Args:
        task_id: квест.
        parent_id: узел, который разворачиваем; ``None`` — корень цепочки.
        session: сессия БД.

    Returns:
        List[ThoughtRead]: созданные узлы.
    """
    task = await _require_task(session, task_id)

    parent_text = None
    if parent_id is not None:
        parent = await session.get(Thought, parent_id)
        if parent is None or parent.task_id != task_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Мысль принадлежит другому квесту",
            )
        parent_text = parent.text

    language = await _language(session)
    steps = await ai_module.expand_thought(task.title, parent_text, language)

    offset = await session.scalar(
        select(func.count())
        .select_from(Thought)
        .where(Thought.task_id == task_id, Thought.parent_id == parent_id)
    )

    created = []
    for index, step in enumerate(steps):
        node = Thought(
            task_id=task_id, parent_id=parent_id, text=step,
            position=int(offset or 0) + index, generated=True,
        )
        session.add(node)
        created.append(node)

    await session.commit()
    for node in created:
        await session.refresh(node)

    logger.info("Развёрнута цепочка квеста id=%s: %s узлов", task_id, len(created))
    return [
        ThoughtRead(
            id=node.id, task_id=node.task_id, parent_id=node.parent_id,
            text=node.text, done=node.done, generated=node.generated, children=[],
        )
        for node in created
    ]


# --------------------------------------------------------------------------- #
# Чат с Оракулом
# --------------------------------------------------------------------------- #

@app.get(
    "/api/oracle/",
    response_model=List[OracleMessageRead],
    summary="История диалога с Оракулом",
    tags=["oracle"],
)
async def read_oracle(session: AsyncSession = Depends(get_session)) -> List[OracleMessageRead]:
    """Возвращает последние реплики диалога в хронологическом порядке."""
    result = await session.scalars(
        select(OracleMessage)
        .where(OracleMessage.user_id == DEFAULT_USER_ID)
        .order_by(OracleMessage.id.desc())
        .limit(40)
    )
    messages = list(result.all())[::-1]
    return [
        OracleMessageRead(
            id=message.id, role=message.role, content=message.content,
            created_at=ensure_utc(message.created_at),
        )
        for message in messages
    ]


@app.post(
    "/api/oracle/",
    response_model=OracleReply,
    summary="Задать вопрос Оракулу",
    tags=["oracle"],
)
async def ask_oracle(
    payload: OracleAsk,
    session: AsyncSession = Depends(get_session),
) -> OracleReply:
    """Отвечает на реплику пользователя.

    Порядок принципиален: защитный слой проверяет сообщение **до** обращения
    к модели. Модель такого размера системному промпту следует нестабильно,
    поэтому отказ не может зависеть от неё — он детерминирован кодом.
    Сгенерированный ответ проверяется ещё раз на выходе.

    Args:
        payload: сообщение пользователя.
        session: сессия БД.

    Returns:
        OracleReply: ответ и пометка о срабатывании защиты.
    """
    session.add(OracleMessage(
        user_id=DEFAULT_USER_ID, role="user", content=payload.message
    ))

    language = await _language(session)
    verdict, canned = screen(payload.message, language)
    guarded = verdict is not Verdict.ALLOW

    if guarded:
        reply = canned or ""
        logger.info("Защита Оракула: вердикт %s", verdict.value)
    else:
        history_result = await session.scalars(
            select(OracleMessage)
            .where(OracleMessage.user_id == DEFAULT_USER_ID)
            .order_by(OracleMessage.id.desc())
            .limit(8)
        )
        history = [
            {"role": "assistant" if item.role == "oracle" else "user",
             "content": item.content}
            for item in list(history_result.all())[::-1]
        ]
        history.append({"role": "user", "content": payload.message})
        reply = guard_reply(await ai_module.oracle_reply(history, language), language)

    session.add(OracleMessage(
        user_id=DEFAULT_USER_ID, role="oracle", content=reply
    ))
    await session.commit()

    return OracleReply(reply=reply, guarded=guarded)


@app.delete(
    "/api/oracle/",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Очистить диалог",
    tags=["oracle"],
)
async def clear_oracle(session: AsyncSession = Depends(get_session)) -> None:
    """Удаляет всю историю диалога."""
    messages = await session.scalars(
        select(OracleMessage).where(OracleMessage.user_id == DEFAULT_USER_ID)
    )
    for message in messages.all():
        await session.delete(message)
    await session.commit()


# --------------------------------------------------------------------------- #
# Настройки
# --------------------------------------------------------------------------- #

async def _get_settings(session: AsyncSession) -> Settings:
    """Возвращает настройки пользователя, создавая их при отсутствии."""
    settings = await session.get(Settings, DEFAULT_USER_ID)
    if settings is None:
        settings = Settings(user_id=DEFAULT_USER_ID)
        session.add(settings)
        await session.flush()
    return settings


@app.get(
    "/api/settings/",
    response_model=SettingsRead,
    summary="Настройки интерфейса и уведомлений",
    tags=["settings"],
)
async def read_settings(session: AsyncSession = Depends(get_session)) -> SettingsRead:
    """Возвращает текущие настройки."""
    settings = await _get_settings(session)
    await _commit_if_changed(session)
    return SettingsRead.model_validate(settings)


@app.patch(
    "/api/settings/",
    response_model=SettingsRead,
    summary="Изменить настройки",
    tags=["settings"],
)
async def update_settings(
    payload: SettingsUpdate,
    session: AsyncSession = Depends(get_session),
) -> SettingsRead:
    """Применяет частичное изменение настроек.

    Пустые поля не трогаются: интерфейс шлёт только то, что менял, и не
    обязан знать текущие значения остальных полей.
    """
    settings = await _get_settings(session)

    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(settings, field, value)

    await session.commit()
    await session.refresh(settings)
    return SettingsRead.model_validate(settings)


# --------------------------------------------------------------------------- #
# Штрафы за просрочку
# --------------------------------------------------------------------------- #

async def apply_overdue_penalties(session: AsyncSession) -> tuple:
    """Переводит просроченные квесты в статус ``failed`` и списывает токены.

    Функция общая для маршрута и фонового планировщика: правило начисления
    штрафа должно быть одно, иначе баланс разъедется в зависимости от того,
    открыто ли окно приложения.

    Отсрочка :data:`PENALTY_GRACE_MINUTES` спасает от штрафа за минуту
    опоздания, пока пользователь дожимает задачу. Баланс не уходит в минус:
    отнимается не больше, чем есть — долговая яма не мотивирует, а отбивает
    желание открывать приложение.

    Args:
        session: активная сессия.

    Returns:
        tuple: (список TaskPenaltyRead, новый баланс, сумма списания).
    """
    user = await get_default_user(session)
    cutoff = utcnow() - timedelta(minutes=PENALTY_GRACE_MINUTES)

    result = await session.scalars(
        select(Task).where(
            Task.user_id == DEFAULT_USER_ID,
            Task.status == TaskStatus.PENDING,
            Task.deadline.is_not(None),
        )
    )

    failed: List[TaskPenaltyRead] = []
    total = 0

    for task in result.all():
        deadline = ensure_utc(task.deadline)
        if deadline is None or deadline > cutoff:
            continue

        penalty = _calculate_penalty(task)
        penalty = min(penalty, user.focus_tokens - total)
        penalty = max(0, penalty)

        task.status = TaskStatus.FAILED
        task.failed_at = utcnow()
        task.penalty = penalty
        task.notified_at = task.notified_at or utcnow()

        total += penalty
        failed.append(TaskPenaltyRead(task_id=task.id, title=task.title, penalty=penalty))

    if failed:
        user.focus_tokens = max(0, user.focus_tokens - total)
        await session.commit()
        logger.info("Просрочено квестов: %s, списано %s токенов", len(failed), total)

    return failed, user.focus_tokens, total


@app.post(
    "/api/tasks/sweep_overdue",
    response_model=OverdueSweepResponse,
    summary="Закрыть просроченные квесты со штрафом",
    tags=["tasks"],
)
async def sweep_overdue(
    session: AsyncSession = Depends(get_session),
) -> OverdueSweepResponse:
    """Проверяет просрочку и применяет штрафы.

    Вызывается интерфейсом при запуске: пока приложение было закрыто,
    сроки могли пройти, и пользователь должен увидеть это сразу.
    """
    failed, tokens, lost = await apply_overdue_penalties(session)
    return OverdueSweepResponse(failed=failed, focus_tokens=tokens, tokens_lost=lost)


@app.get(
    "/api/priorities/",
    summary="Справочник приоритетов",
    tags=["tasks"],
)
async def read_priorities(
    session: AsyncSession = Depends(get_session),
) -> JSONResponse:
    """Отдаёт приоритеты с множителями — интерфейс показывает их в подсказках."""
    language = await _language(session)
    return JSONResponse([
        {
            "key": key,
            "title": localize(meta["title"], language),
            "reward_multiplier": meta["reward_multiplier"],
        }
        for key, meta in sorted(PRIORITIES.items(), key=lambda item: item[1]["order"])
    ])


# --------------------------------------------------------------------------- #
# Правка и удаление квестов
# --------------------------------------------------------------------------- #

@app.patch(
    "/api/tasks/{task_id}",
    response_model=TaskRead,
    summary="Изменить квест",
    tags=["tasks"],
    responses={
        404: {"model": ErrorResponse, "description": "Квест не найден"},
        409: {"model": ErrorResponse, "description": "Завершённый квест не редактируется"},
    },
)
async def update_task(
    payload: TaskUpdate,
    task_id: int = PathParam(..., ge=1, description="Идентификатор квеста"),
    session: AsyncSession = Depends(get_session),
) -> TaskRead:
    """Меняет название, оценку, приоритет или срок квеста.

    Награда пересчитывается при изменении оценки или приоритета: она
    описывает будущее вознаграждение, и оставить её прежней значило бы
    показывать пользователю неверную величину.

    Завершённые квесты не редактируются: награда за них уже начислена, и
    правка оценки задним числом рассогласовала бы баланс с историей.

    При переносе срока в будущее снимаются отметка об отправленном
    напоминании и статус провала: перенос срока — это осознанное решение
    продолжить работу, а не попытка обойти штраф. Уже удержанные токены
    при этом не возвращаются.

    Args:
        payload: изменяемые поля; отсутствующие остаются прежними.
        task_id: идентификатор квеста.
        session: сессия БД.

    Returns:
        TaskRead: обновлённый квест.

    Raises:
        HTTPException: 404 — квест не найден; 409 — квест уже завершён.
    """
    task = await _require_task(session, task_id)

    if task.status is TaskStatus.COMPLETED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Завершённый квест изменить нельзя",
        )

    changes = payload.model_dump(exclude_unset=True)

    if "title" in changes and changes["title"] is not None:
        task.title = changes["title"]
    if "estimated_hours" in changes and changes["estimated_hours"] is not None:
        task.estimated_hours = changes["estimated_hours"]
    if "priority" in changes and changes["priority"] is not None:
        task.priority = changes["priority"]

    if "deadline" in changes:
        task.deadline = changes["deadline"]
        moved_forward = (
            changes["deadline"] is None
            or ensure_utc(changes["deadline"]) > utcnow()
        )
        if moved_forward:
            task.notified_at = None
            if task.status is TaskStatus.FAILED:
                task.status = TaskStatus.PENDING
                task.failed_at = None

    task.reward = _calculate_reward(
        task.estimated_hours, task.priority or DEFAULT_PRIORITY
    )

    await session.commit()
    await session.refresh(task)

    logger.info("Квест id=%s изменён (награда: %s)", task.id, task.reward)
    return _serialize_task(task)


@app.delete(
    "/api/tasks/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить квест",
    tags=["tasks"],
    responses={404: {"model": ErrorResponse, "description": "Квест не найден"}},
)
async def delete_task(
    task_id: int = PathParam(..., ge=1, description="Идентификатор квеста"),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Удаляет квест вместе с его цепочкой мыслей.

    Начисленные или удержанные токены не пересчитываются: баланс отражает
    совершённые действия, а удаление записи не отменяет того, что квест был
    выполнен или просрочен. Уровень сцены пересчитывается, поскольку он
    вычисляется от числа завершённых квестов.

    Args:
        task_id: идентификатор квеста.
        session: сессия БД.

    Raises:
        HTTPException: 404 — квест не найден.
    """
    task = await _require_task(session, task_id)

    # Цепочка мыслей связана каскадом на уровне БД, но SQLAlchemy должна
    # знать об удалении, чтобы очистить свой кэш идентификаторов.
    nodes = await session.scalars(select(Thought).where(Thought.task_id == task_id))
    for node in nodes.all():
        await session.delete(node)

    await session.delete(task)
    await session.flush()

    garden = await _get_garden(session)
    await _recalculate_tree_level(session, garden)
    await session.commit()

    logger.info("Квест id=%s удалён", task_id)


# --------------------------------------------------------------------------- #
# Статистика по месяцам
# --------------------------------------------------------------------------- #

@app.get(
    "/api/stats/monthly",
    response_model=List[MonthlyStat],
    summary="Помесячная статистика",
    tags=["tasks"],
)
async def read_monthly_stats(
    months: int = 6,
    session: AsyncSession = Depends(get_session),
) -> List[MonthlyStat]:
    """Собирает итоги по месяцам: сколько закрыто, просрочено и заработано.

    Квест относится к месяцу по дате завершения, а для незакрытых — по дате
    создания. Привязка к дате создания для всех исказила бы картину: квест,
    заведённый в марте и закрытый в апреле, — это результат апреля.

    Группировка выполняется в Python, а не запросом с ``GROUP BY``: SQLite
    хранит время без указания зоны, и приведение к местным месяцам средствами
    SQL потребовало бы строковых операций над датами, чувствительных к
    формату записи.

    Args:
        months: сколько последних месяцев вернуть (1–24).
        session: сессия БД.

    Returns:
        List[MonthlyStat]: месяцы в хронологическом порядке.
    """
    limit = max(1, min(int(months), 24))

    result = await session.scalars(
        select(Task).where(Task.user_id == DEFAULT_USER_ID)
    )
    tasks = list(result.all())

    buckets: dict = {}
    for task in tasks:
        moment = ensure_utc(task.completed_at) or ensure_utc(task.created_at)
        if moment is None:
            continue
        key = (moment.year, moment.month)
        bucket = buckets.setdefault(
            key,
            {"completed": 0, "failed": 0, "pending": 0, "earned": 0, "lost": 0, "hours": 0},
        )

        if task.status is TaskStatus.COMPLETED:
            bucket["completed"] += 1
            bucket["earned"] += task.reward
            bucket["hours"] += task.estimated_hours
        elif task.status is TaskStatus.FAILED:
            bucket["failed"] += 1
        else:
            bucket["pending"] += 1

        bucket["lost"] += task.penalty or 0

    now = utcnow()
    keys = []
    year, month = now.year, now.month
    for _ in range(limit):
        keys.append((year, month))
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    keys.reverse()

    stats = []
    for key in keys:
        data = buckets.get(key, {"completed": 0, "failed": 0, "pending": 0,
                                 "earned": 0, "lost": 0, "hours": 0})
        closed = data["completed"] + data["failed"]
        stats.append(MonthlyStat(
            year=key[0],
            month=key[1],
            completed=data["completed"],
            failed=data["failed"],
            pending=data["pending"],
            earned=data["earned"],
            lost=data["lost"],
            hours=data["hours"],
            # Доля доведённых до конца среди закрытых. Незавершённые в
            # знаменатель не входят: они ещё могут быть выполнены, и их
            # учёт занижал бы показатель текущего месяца.
            rate=round(100 * data["completed"] / closed) if closed else 0,
        ))
    return stats
