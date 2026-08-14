"""Pydantic v2 схемы: контракт между FastAPI и фронтендом.

Схемы намеренно отделены от ORM-моделей: они задают публичный контракт API
и не позволяют случайно раскрыть внутренние поля (``user_id``, служебные
метки времени) при расширении схемы БД.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import TaskStatus


class TaskCreate(BaseModel):
    """Входные данные для ``POST /api/tasks/``."""

    title: str = Field(..., min_length=1, max_length=200, description="Название задачи")
    estimated_hours: int = Field(
        ..., ge=1, le=24, description="Оценка трудозатрат в часах (1–24)"
    )
    deadline: Optional[datetime] = Field(
        default=None, description="Необязательный дедлайн (ISO 8601)"
    )
    priority: str = Field(
        default="normal", pattern="^(low|normal|high)$",
        description="Приоритет: множит награду и штраф",
    )

    @field_validator("title")
    @classmethod
    def _strip_title(cls, value: str) -> str:
        """Убирает окружающие пробелы и запрещает пустую строку."""
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Название задачи не может состоять из пробелов")
        return cleaned


class TaskRead(BaseModel):
    """Представление задачи, отдаваемое клиенту."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    estimated_hours: int
    reward: int
    status: TaskStatus
    motivation: Optional[str] = None
    created_at: datetime
    deadline: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    is_overdue: bool = False
    priority: str = "normal"
    penalty: int = 0


class SceneRead(BaseModel):
    """Позиция каталога сцен для витрины магазина."""

    key: str
    title: str
    tagline: str
    description: str
    price: int
    owned: bool
    active: bool


class OverdueSweepResponse(BaseModel):
    """Результат проверки просроченных квестов."""

    failed: List[TaskPenaltyRead]
    focus_tokens: int
    tokens_lost: int


class GardenRead(BaseModel):
    """Состояние сцены вместе с балансом токенов и каталогом.

    Баланс и каталог включены в ответ намеренно: интерфейс должен показать
    цены и доступность покупок сразу, без второго запроса.
    """

    model_config = ConfigDict(from_attributes=True)

    user_id: int
    bg_image_path: Optional[str] = None
    tree_level: int
    focus_tokens: int
    background_price: int
    active_scene: str
    scenes: List[SceneRead]


class ScenePurchaseResponse(BaseModel):
    """Результат покупки сцены."""

    focus_tokens: int
    tokens_spent: int
    active_scene: str
    scenes: List[SceneRead]


class SceneSelectResponse(BaseModel):
    """Результат переключения активной сцены."""

    active_scene: str
    tree_level: int


class TaskPenaltyRead(BaseModel):
    """Сведения о применённом штрафе — для уведомления пользователя."""

    task_id: int
    title: str
    penalty: int


class TaskCompleteResponse(BaseModel):
    """Результат завершения задачи: обновлённая задача и новое состояние экономики."""

    task: TaskRead
    focus_tokens: int
    tokens_earned: int
    tree_level: int


class ErrorResponse(BaseModel):
    """Унифицированное тело ошибки (используется в OpenAPI-описании)."""

    detail: str


class ThoughtRead(BaseModel):
    """Узел цепочки мыслей вместе с потомками."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    task_id: int
    parent_id: Optional[int] = None
    text: str
    done: bool
    generated: bool
    children: List["ThoughtRead"] = Field(default_factory=list)


class ThoughtCreate(BaseModel):
    """Новый узел цепочки."""

    text: str = Field(..., min_length=1, max_length=400)
    parent_id: Optional[int] = Field(default=None, description="Родительский узел")

    @field_validator("text")
    @classmethod
    def _strip_text(cls, value: str) -> str:
        """Убирает окружающие пробелы и отклоняет пустую строку.

        Проверка выполняется здесь, а не в обработчике: правило относится к
        самим данным и должно действовать при любом способе их получения.

        Args:
            value: исходный текст мысли.

        Returns:
            str: очищенный текст.

        Raises:
            ValueError: если после очистки строка пуста.
        """
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Текст мысли не может быть пустым")
        return cleaned


class ThoughtUpdate(BaseModel):
    """Изменение узла: текст, отметка выполнения или оба поля."""

    text: Optional[str] = Field(default=None, min_length=1, max_length=400)
    done: Optional[bool] = None


class OracleMessageRead(BaseModel):
    """Реплика диалога с Оракулом."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    content: str
    created_at: datetime


class OracleAsk(BaseModel):
    """Вопрос Оракулу."""

    message: str = Field(..., min_length=1, max_length=1000)

    @field_validator("message")
    @classmethod
    def _strip_message(cls, value: str) -> str:
        """Убирает окружающие пробелы и отклоняет пустое сообщение.

        Args:
            value: исходный текст вопроса.

        Returns:
            str: очищенный текст.

        Raises:
            ValueError: если после очистки строка пуста.
        """
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Сообщение не может быть пустым")
        return cleaned


class OracleReply(BaseModel):
    """Ответ Оракула вместе с пометкой о срабатывании защиты."""

    reply: str
    guarded: bool = Field(
        default=False,
        description="Ответ выдан защитным слоем, а не моделью",
    )


class SettingsRead(BaseModel):
    """Пользовательские настройки."""

    model_config = ConfigDict(from_attributes=True)

    theme: str
    language: str
    notifications_enabled: bool
    notify_lead_minutes: int
    reduce_motion: bool
    show_hints: bool
    rotate_ccw_key: str
    rotate_cw_key: str


class SettingsUpdate(BaseModel):
    """Частичное изменение настроек: приходят только изменённые поля."""

    theme: Optional[str] = Field(default=None, pattern="^(dark|light)$")
    language: Optional[str] = Field(default=None, pattern="^(ru|en)$")
    notifications_enabled: Optional[bool] = None
    notify_lead_minutes: Optional[int] = Field(default=None, ge=5, le=1440)
    reduce_motion: Optional[bool] = None
    show_hints: Optional[bool] = None
    # Код клавиши из KeyboardEvent.code: буквы, цифры, стрелки.
    rotate_ccw_key: Optional[str] = Field(
        default=None, pattern="^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space)$"
    )
    rotate_cw_key: Optional[str] = Field(
        default=None, pattern="^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space)$"
    )


class TaskUpdate(BaseModel):
    """Изменение квеста: приходят только редактируемые поля.

    Все поля необязательны, поэтому интерфейс может отправить одно изменение,
    не зная и не пересылая остальные значения. Отличить «поле не прислали» от
    «поле сбросили в null» позволяет ``model_dump(exclude_unset=True)`` на
    стороне обработчика — это важно для срока, который допустимо снять.
    """

    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    estimated_hours: Optional[int] = Field(default=None, ge=1, le=24)
    deadline: Optional[datetime] = None
    priority: Optional[str] = Field(default=None, pattern="^(low|normal|high)$")

    @field_validator("title")
    @classmethod
    def _strip_title(cls, value: Optional[str]) -> Optional[str]:
        """Убирает окружающие пробелы и отклоняет пустое название.

        Args:
            value: новое название либо ``None``.

        Returns:
            Optional[str]: очищенное название.

        Raises:
            ValueError: если после очистки строка пуста.
        """
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Название квеста не может состоять из пробелов")
        return cleaned


class MonthlyStat(BaseModel):
    """Итоги одного месяца для панели прогресса."""

    year: int
    month: int
    completed: int = Field(description="Завершённых квестов")
    failed: int = Field(description="Просроченных квестов")
    pending: int = Field(description="Открытых квестов")
    earned: int = Field(description="Начислено токенов")
    lost: int = Field(description="Удержано штрафами")
    hours: int = Field(description="Часов, заложенных в завершённые квесты")
    rate: int = Field(description="Доля доведённых до конца среди закрытых, %")
