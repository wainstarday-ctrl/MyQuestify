"""Форматы промптов для разных семейств локальных моделей.

Зачем нужен отдельный модуль. Инструктивные модели обучались на разметке
диалога, и каждое семейство размечает его по-своему: Qwen и большинство
китайских моделей используют ChatML, Llama 3 — собственные теги
``<|start_header_id|>``, Mistral — ``[INST] … [/INST]``, Gemma —
``<start_of_turn>``. Промпт в чужом формате модель воспринимает как обычный
текст: она отвечает мимо инструкции, дописывает реплики за пользователя или
зацикливается.

Приложение поставляется без весов, и пользователь волен положить любой файл
``.gguf``. Поэтому формат определяется автоматически — по метаданным GGUF,
а при их отсутствии по имени файла. Ручное переопределение остаётся в
:data:`app.config.LLM_PROMPT_FORMAT`.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Dict, Final, List, Optional

logger = logging.getLogger("myquestify.prompt")


class PromptFormat:
    """Описание разметки диалога одного семейства моделей.

    Args:
        key: короткий идентификатор формата.
        title: человекочитаемое название для журнала и документации.
        system: шаблон системной инструкции; ``{content}`` — текст.
        user: шаблон реплики пользователя.
        assistant: шаблон завершённой реплики модели (используется в истории).
        tail: строка, открывающая ответ модели.
        stops: последовательности, на которых генерацию нужно оборвать.
        merge_system: ``True``, если семейство не поддерживает отдельную
            системную роль и инструкцию нужно приклеить к первой реплике
            пользователя (так устроены Mistral и Gemma).
    """

    def __init__(
        self,
        key: str,
        title: str,
        system: str,
        user: str,
        assistant: str,
        tail: str,
        stops: List[str],
        merge_system: bool = False,
    ) -> None:
        """Сохраняет шаблоны разметки. Описание параметров — в классе."""
        self.key = key
        self.title = title
        self.system = system
        self.user = user
        self.assistant = assistant
        self.tail = tail
        self.stops = stops
        self.merge_system = merge_system

    def build(self, system: str, turns: List[Dict[str, str]]) -> str:
        """Собирает готовый промпт.

        Args:
            system: системная инструкция.
            turns: реплики диалога в виде ``{"role": ..., "content": ...}``.

        Returns:
            str: текст промпта, оканчивающийся приглашением к ответу.
        """
        parts: List[str] = []
        pending_system = system

        if not self.merge_system and system:
            parts.append(self.system.format(content=system))
            pending_system = ""

        for turn in turns:
            content = turn.get("content", "")
            if turn.get("role") == "assistant":
                parts.append(self.assistant.format(content=content))
                continue

            if pending_system:
                # Инструкция приклеивается к первой реплике пользователя:
                # у семейств без системной роли иного места для неё нет.
                content = f"{pending_system}\n\n{content}"
                pending_system = ""
            parts.append(self.user.format(content=content))

        parts.append(self.tail)
        return "".join(parts)


#: Все поддерживаемые форматы. Порядок важен для автоопределения по имени:
#: более специфичные шаблоны идут раньше общих.
FORMATS: Final[Dict[str, PromptFormat]] = {
    "chatml": PromptFormat(
        key="chatml",
        title="ChatML (Qwen, Vikhr, Yi, OpenChat)",
        system="<|im_start|>system\n{content}<|im_end|>\n",
        user="<|im_start|>user\n{content}<|im_end|>\n",
        assistant="<|im_start|>assistant\n{content}<|im_end|>\n",
        tail="<|im_start|>assistant\n",
        stops=["<|im_end|>", "<|im_start|>", "</s>"],
    ),
    "llama3": PromptFormat(
        key="llama3",
        title="Llama 3 / 3.1 / 3.2",
        system="<|start_header_id|>system<|end_header_id|>\n\n{content}<|eot_id|>",
        user="<|start_header_id|>user<|end_header_id|>\n\n{content}<|eot_id|>",
        assistant="<|start_header_id|>assistant<|end_header_id|>\n\n{content}<|eot_id|>",
        tail="<|start_header_id|>assistant<|end_header_id|>\n\n",
        stops=["<|eot_id|>", "<|end_of_text|>", "<|start_header_id|>"],
    ),
    "mistral": PromptFormat(
        key="mistral",
        title="Mistral / Mixtral (Instruct)",
        system="",
        user="[INST] {content} [/INST]",
        assistant=" {content}</s>",
        tail="",
        stops=["</s>", "[INST]"],
        merge_system=True,
    ),
    "gemma": PromptFormat(
        key="gemma",
        title="Gemma / Gemma 2",
        system="",
        user="<start_of_turn>user\n{content}<end_of_turn>\n",
        assistant="<start_of_turn>model\n{content}<end_of_turn>\n",
        tail="<start_of_turn>model\n",
        stops=["<end_of_turn>", "<start_of_turn>"],
        merge_system=True,
    ),
    "alpaca": PromptFormat(
        key="alpaca",
        title="Alpaca / Vicuna и прочие текстовые шаблоны",
        system="{content}\n\n",
        user="### Инструкция:\n{content}\n\n",
        assistant="### Ответ:\n{content}\n\n",
        tail="### Ответ:\n",
        stops=["### Инструкция:", "### Instruction:", "</s>"],
    ),
}

DEFAULT_FORMAT: Final[str] = "chatml"

#: Признаки в имени файла. Проверяются по порядку, первое совпадение выигрывает.
_NAME_HINTS: Final[List[tuple]] = [
    ("llama3", ("llama-3", "llama3", "llama_3")),
    ("gemma", ("gemma",)),
    ("mistral", ("mistral", "mixtral", "zephyr")),
    ("chatml", ("qwen", "vikhr", "yi-", "openchat", "hermes", "saiga", "chatml")),
    ("alpaca", ("alpaca", "vicuna", "wizard")),
]


def _detect_by_name(path: Path) -> Optional[str]:
    """Определяет формат по имени файла модели.

    Args:
        path: путь к файлу ``.gguf``.

    Returns:
        Optional[str]: ключ формата либо ``None``.
    """
    name = path.name.lower()
    for key, markers in _NAME_HINTS:
        if any(marker in name for marker in markers):
            return key
    return None


def _detect_by_metadata(model: object) -> Optional[str]:
    """Определяет формат по шаблону чата, зашитому в GGUF.

    Современные сборки GGUF несут поле ``tokenizer.chat_template`` — это
    Jinja-шаблон разметки. Разбирать его целиком не нужно: достаточно найти
    характерные теги, потому что каждое семейство использует свои.

    Args:
        model: экземпляр ``llama_cpp.Llama``.

    Returns:
        Optional[str]: ключ формата либо ``None``, если метаданных нет.
    """
    template = ""
    try:
        metadata = getattr(model, "metadata", None) or {}
        template = str(metadata.get("tokenizer.chat_template", ""))
    except Exception:  # noqa: BLE001 — отсутствие метаданных не ошибка
        return None

    if not template:
        return None

    markers = [
        ("chatml", "<|im_start|>"),
        ("llama3", "<|start_header_id|>"),
        ("gemma", "<start_of_turn>"),
        ("mistral", "[INST]"),
    ]
    for key, marker in markers:
        if marker in template:
            return key

    if re.search(r"###\s*(Instruction|Инструкция)", template):
        return "alpaca"
    return None


def resolve(configured: str, path: Path, model: object = None) -> PromptFormat:
    """Выбирает формат промпта для загруженной модели.

    Порядок: явная настройка → метаданные GGUF → имя файла → ChatML.
    Метаданные надёжнее имени, потому что файл легко переименовать, а
    шаблон внутри файла остаётся от обучения.

    Args:
        configured: значение :data:`app.config.LLM_PROMPT_FORMAT`.
        path: путь к файлу модели.
        model: загруженный ``llama_cpp.Llama``, если доступен.

    Returns:
        PromptFormat: описание разметки диалога.
    """
    if configured and configured != "auto":
        chosen = FORMATS.get(configured)
        if chosen:
            logger.info("Формат промпта задан вручную: %s", chosen.title)
            return chosen
        logger.warning("Неизвестный формат «%s», включено автоопределение.", configured)

    if model is not None:
        key = _detect_by_metadata(model)
        if key:
            logger.info("Формат промпта определён по метаданным GGUF: %s", FORMATS[key].title)
            return FORMATS[key]

    key = _detect_by_name(path)
    if key:
        logger.info("Формат промпта определён по имени файла: %s", FORMATS[key].title)
        return FORMATS[key]

    logger.info(
        "Формат промпта определить не удалось, используется %s. "
        "Если ответы бессвязны, задайте LLM_PROMPT_FORMAT в app/config.py.",
        FORMATS[DEFAULT_FORMAT].title,
    )
    return FORMATS[DEFAULT_FORMAT]
