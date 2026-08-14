"""ORM-модели MyQuestify (SQLAlchemy 2.0, декларативный стиль с ``Mapped``).

Схема соответствует спецификации проекта:

* ``users``  — баланс focus-токенов пользователя;
* ``tasks``  — задачи с оценкой трудозатрат, наградой и статусом;
* ``garden`` — состояние «Сада Вдохновения» (фон + уровень дерева).

Приложение локальное и однопользовательское, поэтому запись в ``users``
с идентификатором :data:`app.config.DEFAULT_USER_ID` создаётся при
инициализации БД и служит владельцем всех задач и сада.
"""

from __future__ import annotations

import enum
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum as SqlEnum,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    backref,
    mapped_column,
    relationship,
)


class Base(DeclarativeBase):
    """Базовый декларативный класс для всех моделей проекта."""


class TaskStatus(str, enum.Enum):
    """Жизненный цикл задачи.

    Наследование от :class:`str` позволяет напрямую сериализовать значение
    в JSON и сравнивать его со строками, приходящими из фронтенда.
    """

    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"


def ensure_utc(value: Optional[datetime]) -> Optional[datetime]:
    """Приводит значение из БД к aware-времени в UTC.

    SQLite не хранит смещение таймзоны: диалект пишет компоненты даты как
    есть и возвращает naive-объект даже для колонки ``DateTime(timezone=True)``.
    Если отдать такое значение клиенту, Pydantic сериализует его без ``Z``,
    а ``new Date()`` в браузере прочитает строку как локальное время — и
    дедлайн уедет ровно на часовой пояс пользователя.

    Args:
        value: значение из БД либо ``None``.

    Returns:
        Optional[datetime]: aware-время в UTC либо ``None``.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def utcnow() -> datetime:
    """Возвращает текущее время в UTC с явной таймзоной.

    Используется вместо устаревшего ``datetime.utcnow()``, который отдаёт
    naive-объект и приводит к ошибкам при сравнении с ``deadline``.
    """
    return datetime.now(tz=timezone.utc)


class User(Base):
    """Пользователь приложения и его баланс внутренней валюты."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("focus_tokens >= 0", name="ck_users_tokens_non_negative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    focus_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )

    tasks: Mapped[List["Task"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin"
    )
    garden: Mapped[Optional["Garden"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False, lazy="selectin"
    )

    def __repr__(self) -> str:  # pragma: no cover - отладочное представление
        """Краткое представление записи для журнала и отладчика."""
        return f"<User id={self.id} focus_tokens={self.focus_tokens}>"


class Task(Base):
    """Задача таск-трекера.

    ``reward`` фиксируется в момент создания по формуле
    ``estimated_hours * TOKENS_PER_HOUR``. Хранение награды в самой записи
    делает экономику воспроизводимой: изменение тарифа в конфиге не
    переоценивает задним числом уже созданные задачи.
    """

    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint("estimated_hours > 0", name="ck_tasks_hours_positive"),
        CheckConstraint("reward >= 0", name="ck_tasks_reward_non_negative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    estimated_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    reward: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    status: Mapped[TaskStatus] = mapped_column(
        SqlEnum(
            TaskStatus,
            name="task_status",
            native_enum=False,
            values_callable=lambda members: [member.value for member in members],
        ),
        nullable=False,
        default=TaskStatus.PENDING,
        server_default=TaskStatus.PENDING.value,
        index=True,
    )

    # Фраза, сгенерированная локальной LLM в момент создания задачи.
    motivation: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    deadline: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # Момент отправки напоминания о дедлайне: повторно не беспокоим.
    notified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Приоритет из app.config.PRIORITIES: множит и награду, и штраф.
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, default="normal", server_default="normal", index=True
    )
    # Сколько токенов снято за просрочку. Хранится в записи, а не считается
    # заново: тариф в конфиге может измениться, а история — нет.
    penalty: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    failed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="tasks", lazy="selectin")

    @property
    def is_overdue(self) -> bool:
        """``True``, если задача не завершена и дедлайн уже прошёл.

        SQLite не хранит смещение таймзоны: диалект записывает компоненты
        даты как есть и возвращает naive-объект, даже если колонка объявлена
        как ``DateTime(timezone=True)``. Прямое сравнение с aware-временем
        падало бы с ``TypeError``, поэтому naive-значение трактуется как UTC —
        именно в UTC оно и записывалось.
        """
        if self.deadline is None or self.status is not TaskStatus.PENDING:
            return False

        return ensure_utc(self.deadline) < utcnow()

    def __repr__(self) -> str:  # pragma: no cover - отладочное представление
        """Краткое представление записи для журнала и отладчика."""
        return f"<Task id={self.id} title={self.title!r} status={self.status.value}>"


class Garden(Base):
    """Состояние сцены пользователя.

    Таблица хранит выбранную сцену и уровень, от которого зависит её
    наполнение. Колонка ``bg_image_path`` осталась от снятой возможности
    менять фон: удаление колонки в SQLite требует пересоздания таблицы, что
    для неиспользуемого поля неоправданно.
    """

    __tablename__ = "garden"
    __table_args__ = (
        CheckConstraint("tree_level >= 1", name="ck_garden_level_positive"),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    bg_image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    tree_level: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # Ключ активной сцены из app.config.SCENES.
    active_scene: Mapped[str] = mapped_column(
        String(32), nullable=False, default="garden", server_default="garden"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow,
        server_default=func.now(),
    )

    user: Mapped["User"] = relationship(back_populates="garden", lazy="selectin")

    def __repr__(self) -> str:  # pragma: no cover - отладочное представление
        """Краткое представление записи для журнала и отладчика."""
        return f"<Garden user_id={self.user_id} tree_level={self.tree_level}>"


class SceneUnlock(Base):
    """Купленная пользователем интерактивная сцена.

    Отдельная таблица вместо колонки со списком: покупка каждой сцены — это
    отдельная строка, поэтому повторную покупку ловит первичный ключ, а не
    прикладная проверка. Ключ сцены не является внешним, потому что каталог
    сцен живёт в коде (``app.config.SCENES``), а не в базе.
    """

    __tablename__ = "scene_unlocks"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    scene_key: Mapped[str] = mapped_column(String(32), primary_key=True)
    price_paid: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unlocked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )

    # Связь объявлена ради порядка операций при сохранении. По одному лишь
    # внешнему ключу SQLAlchemy не выводит зависимость между мапперами и
    # может отправить INSERT в scene_unlocks прежде строки в users, что
    # нарушит ограничение FOREIGN KEY. Наличие relationship задаёт порядок
    # явно, поэтому строка обязательна, хотя обходом связи код не пользуется.
    user: Mapped["User"] = relationship()

    def __repr__(self) -> str:  # pragma: no cover - отладочное представление
        """Краткое представление записи для журнала и отладчика."""
        return f"<SceneUnlock user_id={self.user_id} scene={self.scene_key}>"


class Thought(Base):
    """Узел цепочки мыслей — разбор квеста на шаги произвольной вложенности.

    Дерево хранится ссылкой на родителя, а не вложенным JSON: так каждый узел
    можно отметить выполненным, переставить или развернуть моделью отдельным
    запросом, не переписывая всю цепочку целиком.

    Каскад ``delete-orphan`` на самоссылке удаляет поддерево вместе с узлом —
    иначе дети остались бы висеть без родителя.
    """

    __tablename__ = "thoughts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("thoughts.id", ondelete="CASCADE"), nullable=True, index=True
    )

    text: Mapped[str] = mapped_column(String(400), nullable=False)
    done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                       server_default="0")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    generated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                            server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )

    task: Mapped["Task"] = relationship()
    children: Mapped[List["Thought"]] = relationship(
        cascade="all, delete-orphan",
        backref=backref("parent", remote_side=[id]),
        lazy="selectin",
    )

    def __repr__(self) -> str:  # pragma: no cover - отладочное представление
        """Краткое представление записи для журнала и отладчика."""
        return f"<Thought id={self.id} task={self.task_id} parent={self.parent_id}>"


class OracleMessage(Base):
    """Реплика в диалоге с Оракулом.

    История нужна не только для показа: маленькая модель без контекста
    предыдущих реплик отвечает невпопад, поэтому последние сообщения
    подмешиваются в промпт.
    """

    __tablename__ = "oracle_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)   # user | oracle
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )

    user: Mapped["User"] = relationship()

    def __repr__(self) -> str:  # pragma: no cover - отладочное представление
        """Краткое представление записи для журнала и отладчика."""
        return f"<OracleMessage id={self.id} role={self.role}>"


class Settings(Base):
    """Пользовательские настройки интерфейса и уведомлений.

    Хранятся в базе, а не в localStorage: тема должна применяться и при
    первом кадре после запуска ``.exe``, а планировщик напоминаний живёт на
    сервере и о содержимом браузерного хранилища ничего не знает.
    """

    __tablename__ = "settings"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    theme: Mapped[str] = mapped_column(String(16), nullable=False, default="dark",
                                        server_default="dark")
    # Язык интерфейса и ответов модели. Хранится вместе с прочими
    # настройками, потому что от него зависит и серверная генерация текста,
    # а не только подписи на экране.
    language: Mapped[str] = mapped_column(String(8), nullable=False, default="ru",
                                           server_default="ru")
    notifications_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="1"
    )
    notify_lead_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=60, server_default="60"
    )
    reduce_motion: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )
    # Подсказка над сценой: гаснет сама, но кому-то мешает и это.
    show_hints: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="1"
    )
    # Клавиши поворота предмета в сценах. Хранятся как коды KeyboardEvent.code
    # (KeyQ, KeyE): раскладка не влияет, и на кириллице сочетание не ломается.
    rotate_ccw_key: Mapped[str] = mapped_column(
        String(24), nullable=False, default="KeyQ", server_default="KeyQ"
    )
    rotate_cw_key: Mapped[str] = mapped_column(
        String(24), nullable=False, default="KeyE", server_default="KeyE"
    )

    user: Mapped["User"] = relationship()

    def __repr__(self) -> str:  # pragma: no cover - отладочное представление
        """Краткое представление записи для журнала и отладчика."""
        return f"<Settings user_id={self.user_id} theme={self.theme}>"
