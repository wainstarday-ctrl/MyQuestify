"""Локальная генерация мотивационных фраз через ``llama-cpp-python``.

Ключевые свойства модуля:

* **Offline.** Модель читается из файла ``./models/model.gguf``; сетевых
  обращений нет ни при инициализации, ни при генерации.
* **Ленивая загрузка.** Веса подтягиваются при первом обращении, а не при
  старте приложения — окно PyWebView открывается мгновенно.
* **Неблокирующий вызов.** Инференс на CPU занимает секунды, поэтому он
  выносится в пул потоков, чтобы не останавливать event loop FastAPI.
* **Единственный экземпляр.** ``Llama`` не потокобезопасен, поэтому доступ
  к нему сериализуется через :class:`asyncio.Lock`.

Если файл модели отсутствует или ``llama-cpp-python`` не установлен, модуль
переходит в детерминированный резервный режим (см. :func:`fallbacks_for`).
Это осознанная деградация, а не заглушка: приложение остаётся работоспособным
на машине без весов, а флаг :func:`is_model_available` позволяет UI показать
реальный источник фразы.
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Dict, Final, List, Optional

# run_in_threadpool переносит вычисления в отдельный поток. Инференс
# языковой модели на процессоре занимает секунды и полностью блокирует
# поток выполнения; без выноса в пул интерфейс переставал бы отвечать на
# время генерации каждой фразы.
from fastapi.concurrency import run_in_threadpool

from app import prompt_formats
from app.config import (
    DEFAULT_LANGUAGE,
    LLM_MAX_TOKENS,
    LLM_MODEL_PATH,
    LLM_N_BATCH,
    LLM_N_CTX,
    LLM_N_GPU_LAYERS,
    LLM_N_THREADS,
    LLM_PROMPT_FORMAT,
    LLM_TEMPERATURE,
)

logger = logging.getLogger(__name__)

PROMPTS: Final[dict] = {
    "motivation": {
        "ru": (
            "Ты — краткий и тёплый наставник по продуктивности. "
            "На задачу пользователя отвечай ОДНОЙ мотивирующей фразой на русском языке. "
            "Не более 20 слов. Без списков, без кавычек, без пояснений."
        ),
        "en": (
            "You are a brief and warm productivity mentor. "
            "Reply to the user's task with ONE motivating sentence in English. "
            "No more than 20 words. No lists, no quotation marks, no explanations."
        ),
    },
    "oracle": {
        "ru": (
            "Ты — Оракул: голос древнего мыслителя, обращённый к человеку сегодняшнему. "
            "Говори по-русски, спокойно и коротко — не больше трёх предложений. "
            "Опирайся на образы природы, ремесла и пути. Не поучай свысока, не сыпь "
            "восклицаниями, не обещай чудес. Мягко возвращай собеседника к посильному "
            "шагу, который он может сделать сегодня. Никогда не давай медицинских, "
            "юридических или финансовых предписаний."
        ),
        "en": (
            "You are the Oracle: the voice of an ancient thinker speaking to a person "
            "of today. Speak English, calmly and briefly — no more than three sentences. "
            "Draw on images of nature, craft and the road. Do not lecture from above, "
            "do not pile on exclamations, do not promise miracles. Gently return your "
            "companion to a manageable step they can take today. Never give medical, "
            "legal or financial directions."
        ),
    },
    "expand": {
        "ru": (
            "Ты помогаешь разбить задачу на шаги. Дай РОВНО три коротких конкретных "
            "подшага на русском языке, каждый с новой строки, каждый начинается с «- ». "
            "Без нумерации, без вступлений, без пояснений. Каждый шаг — не длиннее "
            "восьми слов и описывает действие, а не намерение."
        ),
        "en": (
            "You help break a task into steps. Give EXACTLY three short, concrete "
            "sub-steps in English, each on a new line, each starting with '- '. "
            "No numbering, no preamble, no explanations. Each step is at most eight "
            "words and describes an action, not an intention."
        ),
    },
    "deadline": {
        "ru": (
            "Ты пишешь короткое напоминание о приближающемся сроке. Одна фраза "
            "на русском языке, не больше пятнадцати слов, тёплая и подбадривающая. "
            "Без паники, без упрёков, без восклицательных знаков."
        ),
        "en": (
            "You write a short reminder about an approaching deadline. One sentence "
            "in English, no more than fifteen words, warm and encouraging. "
            "No panic, no reproach, no exclamation marks."
        ),
    },
}


def prompt_for(kind: str, language: str) -> str:
    """Возвращает системную инструкцию нужного вида на нужном языке.

    Args:
        kind: ключ из :data:`PROMPTS`.
        language: код языка интерфейса.

    Returns:
        str: текст инструкции; при неизвестном языке — русский вариант.
    """
    variants = PROMPTS[kind]
    return variants.get(language) or variants[DEFAULT_LANGUAGE]

ORACLE_FALLBACKS_RU: Final[List[str]] = [
    "Река не спорит с камнем — она находит путь вокруг. Начни с того, что поддаётся.",
    "Всякая большая работа складывается из малых. Назови первую — и она перестанет быть большой.",
    "Мастер отличается от новичка не отсутствием усталости, а привычкой возвращаться.",
    "Сомнение — не преграда, а спутник. Иди вместе с ним, но не позволяй вести.",
    "Ты хочешь увидеть весь путь разом. Довольно и следующего шага.",
]

DEADLINE_FALLBACKS_RU: Final[List[str]] = [
    "Срок близко — но времени ещё достаточно для одного честного шага.",
    "Осталось немного. Начни с самого простого куска, остальное подтянется.",
    "Дедлайн на горизонте. Не спеши — просто не откладывай.",
]

ORACLE_FALLBACKS_EN: Final[List[str]] = [
    "A river does not argue with a stone; it finds a way around. Start where it gives.",
    "Every large work is made of small ones. Name the first and it stops being large.",
    "A master differs from a beginner not by absence of fatigue, but by the habit of returning.",
    "Doubt is not a barrier but a companion. Walk with it, do not let it lead.",
    "You want to see the whole road at once. The next step is enough.",
]

DEADLINE_FALLBACKS_EN: Final[List[str]] = [
    "The deadline is near, but there is still time for one honest step.",
    "Not much left. Begin with the simplest piece; the rest will follow.",
    "The deadline is on the horizon. No need to rush — just do not postpone.",
]

FALLBACK_PHRASES_EN: Final[List[str]] = [
    "One step today is worth ten plans for tomorrow.",
    "Start small — momentum will do the rest.",
    "Focus matters more than speed. You will manage.",
    "Every finished hour is a branch grown in your garden.",
    "The difficult becomes simple once you take it on.",
    "Do not wait for inspiration — it arrives along the way.",
]


def fallbacks_for(kind: str, language: str) -> List[str]:
    """Возвращает набор резервных фраз нужного вида и языка.

    Резервные фразы должны быть на языке интерфейса не меньше, чем ответы
    модели: именно они показываются, когда весов нет, и русский текст в
    английском интерфейсе выглядел бы сбоем.

    Args:
        kind: motivation, oracle или deadline.
        language: код языка.

    Returns:
        List[str]: непустой набор фраз.
    """
    table = {
        "motivation": {"ru": FALLBACK_PHRASES_RU, "en": FALLBACK_PHRASES_EN},
        "oracle": {"ru": ORACLE_FALLBACKS_RU, "en": ORACLE_FALLBACKS_EN},
        "deadline": {"ru": DEADLINE_FALLBACKS_RU, "en": DEADLINE_FALLBACKS_EN},
    }
    variants = table[kind]
    return variants.get(language) or variants[DEFAULT_LANGUAGE]


FALLBACK_PHRASES_RU: Final[List[str]] = [
    "Один шаг сегодня стоит десяти планов на завтра.",
    "Начни с малого — импульс сделает остальное.",
    "Сосредоточенность важнее скорости. Ты справишься.",
    "Каждый завершённый час — это выросшая ветка твоего сада.",
    "Сложное становится простым, когда за него берёшься.",
    "Не жди вдохновения — оно приходит по ходу работы.",
]

_llm: Optional[Any] = None
_llm_lock: asyncio.Lock = asyncio.Lock()
_load_attempted: bool = False

#: Разметка диалога загруженной модели. Определяется один раз при загрузке
#: и переиспользуется всеми видами генерации.
_format: Optional[prompt_formats.PromptFormat] = None


def is_model_available() -> bool:
    """Возвращает ``True``, если веса модели найдены на диске.

    Проверка файловая и дешёвая — используется в ``/api/health`` и при
    выборе источника фразы, не инициируя загрузку модели.
    """
    return LLM_MODEL_PATH.is_file()


def _load_model() -> Optional[Any]:
    """Синхронно загружает GGUF-модель с минимальными параметрами для CPU.

    Returns:
        Экземпляр ``llama_cpp.Llama`` либо ``None``, если библиотека не
        установлена, файл отсутствует или веса повреждены.
    """
    if not is_model_available():
        logger.warning(
            "Файл модели не найден: %s — используется резервный набор фраз.",
            LLM_MODEL_PATH,
        )
        return None

    try:
        # llama-cpp-python — привязка Python к библиотеке llama.cpp,
        # выполняющей инференс квантованных моделей на процессоре. Выбрана
        # вместо transformers, поскольку последняя требует полноразмерных
        # весов и практически рассчитана на видеокарту, что противоречит
        # требованию работать на обычном компьютере без ускорителя.
        #
        # Импорт локальный: пакет опционален, и его отсутствие не должно
        # препятствовать запуску приложения.
        from llama_cpp import Llama
    except ImportError:
        logger.warning(
            "Пакет llama-cpp-python не установлен — используется резервный набор фраз."
        )
        return None

    try:
        model = Llama(
            model_path=str(LLM_MODEL_PATH),
            n_ctx=LLM_N_CTX,
            n_batch=LLM_N_BATCH,
            n_threads=LLM_N_THREADS,
            n_gpu_layers=LLM_N_GPU_LAYERS,
            use_mlock=False,
            verbose=False,
        )
    except Exception:  # noqa: BLE001 — сбой весов не должен ронять приложение
        logger.exception("Не удалось инициализировать LLM, включён резервный режим.")
        return None

    global _format
    _format = prompt_formats.resolve(LLM_PROMPT_FORMAT, LLM_MODEL_PATH, model)

    logger.info(
        "LLM загружена: %s (потоков: %s, формат: %s)",
        LLM_MODEL_PATH.name, LLM_N_THREADS, _format.title,
    )
    return model


def _build_prompt(task_title: str, language: str = DEFAULT_LANGUAGE) -> str:
    """Собирает промпт для генерации мотивационной фразы.

    Разметка берётся из формата, определённого при загрузке модели, поэтому
    функция одинаково работает с Qwen, Llama 3, Mistral и Gemma.

    Args:
        task_title: название задачи пользователя.

    Returns:
        str: готовый текст промпта.
    """
    label = "Task" if language == "en" else "Задача"
    reminder = LANGUAGE_REMINDER.get(language, "")
    return _build_chat_prompt(
        prompt_for("motivation", language),
        [{"role": "user", "content": f"{label}: {task_title}\n\n{reminder}"}]
    )


def _postprocess(raw: str) -> str:
    """Приводит сырой вывод модели к одной чистой фразе.

    Обрезает служебные токены, кавычки и всё после первого перевода строки —
    маленькие модели склонны продолжать диалог за пользователя.

    Args:
        raw: текст, полученный от модели.

    Returns:
        str: очищенная фраза (пустая строка, если извлечь нечего).
    """
    text = raw.strip()
    # Обрезаем по служебным тегам всех поддерживаемых семейств: модель может
    # выдать их, даже если формат промпта определён верно.
    for marker in ("<|im_end|>", "<|eot_id|>", "<end_of_turn>", "</s>",
                   "<|endoftext|>", "<|im_start|>", "[INST]"):
        text = text.split(marker, 1)[0]
    text = text.split("\n", 1)[0].strip()
    text = text.strip('"“”«»').strip()
    if len(text) > 300:
        text = text[:297].rstrip() + "..."
    return text


def _generate_sync(task_title: str, language: str = DEFAULT_LANGUAGE) -> str:
    """Выполняет инференс в текущем потоке.

    Args:
        task_title: название задачи.

    Returns:
        str: сгенерированная фраза либо резервная, если вывод пуст.
    """
    assert _llm is not None, "_generate_sync вызван без инициализированной модели"

    completion = _llm.create_completion(
        prompt=_build_prompt(task_title, language),
        max_tokens=LLM_MAX_TOKENS,
        temperature=LLM_TEMPERATURE,
        top_p=0.9,
        repeat_penalty=1.15,
        stop=_stop_sequences(False),
    )
    phrase = _postprocess(completion["choices"][0]["text"])
    if phrase and not _matches_language(phrase, language):
        return random.choice(fallbacks_for("motivation", language))
    return phrase or random.choice(fallbacks_for("motivation", language))


async def generate_motivation(task_title: str,
                              language: str = DEFAULT_LANGUAGE) -> str:
    """Возвращает мотивационную фразу для задачи.

    Гарантированно не выбрасывает исключений: любая ошибка инференса
    логируется и подменяется резервной фразой, чтобы создание задачи
    никогда не срывалось из-за ИИ-модуля.

    Args:
        task_title: название задачи, введённое пользователем.

    Returns:
        str: непустая мотивационная фраза на русском языке.
    """
    global _llm, _load_attempted

    async with _llm_lock:
        if not _load_attempted:
            _load_attempted = True
            _llm = await run_in_threadpool(_load_model)

        if _llm is None:
            return random.choice(fallbacks_for("motivation", language))

        try:
            return await run_in_threadpool(_generate_sync, task_title, language)
        except Exception:  # noqa: BLE001
            logger.exception("Ошибка генерации мотивации, отдана резервная фраза.")
            return random.choice(fallbacks_for("motivation", language))


async def warmup() -> None:
    """Прогревает модель в фоне (опционально).

    Вызов из ``lifespan`` через ``asyncio.create_task`` убирает задержку
    первой генерации, не блокируя старт окна PyWebView.
    """
    global _llm, _load_attempted

    async with _llm_lock:
        if _load_attempted:
            return
        _load_attempted = True
        _llm = await run_in_threadpool(_load_model)


async def shutdown() -> None:
    """Освобождает веса модели при остановке приложения."""
    global _llm, _load_attempted, _format

    async with _llm_lock:
        _llm = None
        _format = None
        _load_attempted = False
        logger.info("LLM выгружена.")


# --------------------------------------------------------------------------- #
# Обобщённая генерация
# --------------------------------------------------------------------------- #

LANGUAGE_REMINDER: Final[dict] = {
    "ru": "Ответь на русском языке.",
    "en": "Answer in English.",
}


def _matches_language(text: str, language: str) -> bool:
    """Проверяет, что текст написан на ожидаемом языке.

    Проверка нужна не из недоверия к промпту, а из-за особенности моделей,
    дообученных под один язык: такая модель отвечает на нём даже при
    инструкции на другом. Определение ведётся по доле кириллицы среди букв —
    для пары «русский и английский» этого достаточно, а разбор словаря
    потребовал бы словарей в поставке.

    Args:
        text: ответ модели.
        language: ожидаемый язык.

    Returns:
        bool: ``True``, если язык совпадает или определить его нельзя.
    """
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 8:
        return True  # слишком короткий текст, судить не о чем

    cyrillic = sum(1 for c in letters if "\u0400" <= c <= "\u04ff")
    share = cyrillic / len(letters)
    return share > 0.5 if language == "ru" else share < 0.25


def _build_chat_prompt(system: str, turns: List[Dict[str, str]]) -> str:
    """Собирает промпт в разметке, которую понимает загруженная модель.

    Args:
        system: системная инструкция.
        turns: список словарей ``{"role": "user"|"assistant", "content": ...}``.

    Returns:
        str: готовый текст промпта.
    """
    fmt = _format or prompt_formats.FORMATS[prompt_formats.DEFAULT_FORMAT]
    return fmt.build(system, turns)


def _stop_sequences(keep_newlines: bool) -> List[str]:
    """Возвращает стоп-последовательности для текущего формата.

    Args:
        keep_newlines: не обрывать вывод на первом переводе строки. Нужно для
            многострочных ответов вроде списка подшагов; для однострочных
            добавляется перевод строки, иначе маленькие модели продолжают
            диалог за пользователя.

    Returns:
        List[str]: последовательности, на которых генерация прекращается.
    """
    fmt = _format or prompt_formats.FORMATS[prompt_formats.DEFAULT_FORMAT]
    stops = list(fmt.stops)
    if not keep_newlines:
        stops = ["\n"] + stops
    return stops


def _complete_sync(prompt: str, max_tokens: int, temperature: float,
                   keep_newlines: bool) -> str:
    """Выполняет инференс в текущем потоке.

    Args:
        prompt: готовый промпт.
        max_tokens: предел длины ответа.
        temperature: температура выборки.
        keep_newlines: не обрывать вывод на первом переводе строки
            (нужно для многострочных ответов вроде списка подшагов).

    Returns:
        str: очищенный текст.
    """
    assert _llm is not None, "_complete_sync вызван без инициализированной модели"

    stop = _stop_sequences(keep_newlines)
    completion = _llm.create_completion(
        prompt=prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        top_p=0.9,
        repeat_penalty=1.15,
        stop=stop,
    )
    raw = completion["choices"][0]["text"]
    if keep_newlines:
        text = raw.strip()
        for marker in ("<|im_end|>", "</s>", "<|endoftext|>"):
            text = text.split(marker, 1)[0]
        return text.strip()
    return _postprocess(raw)


async def _generate(system: str, turns: List[Dict[str, str]], fallbacks: List[str],
                    max_tokens: int = 96, temperature: float = LLM_TEMPERATURE,
                    keep_newlines: bool = False,
                    language: str = DEFAULT_LANGUAGE) -> str:
    """Общая точка генерации: загрузка модели, блокировка, резервный ответ.

    Гарантированно не выбрасывает исключений — любая ошибка инференса
    логируется и подменяется резервной фразой.

    Args:
        system: системная инструкция.
        turns: история реплик.
        fallbacks: набор фраз на случай отсутствия модели.
        max_tokens: предел длины ответа.
        temperature: температура выборки.
        keep_newlines: сохранять переводы строк в ответе.

    Returns:
        str: непустой текст.
    """
    global _llm, _load_attempted

    async with _llm_lock:
        if not _load_attempted:
            _load_attempted = True
            _llm = await run_in_threadpool(_load_model)

        if _llm is None:
            return random.choice(fallbacks)

        # Напоминание о языке приписывается к последней реплике: модель
        # следует ближайшему к ответу указанию охотнее, чем системному.
        reminder = LANGUAGE_REMINDER.get(language)
        prepared = list(turns)
        if reminder and prepared:
            last = dict(prepared[-1])
            last["content"] = f"{last.get('content', '')}\n\n{reminder}"
            prepared[-1] = last

        try:
            prompt = _build_chat_prompt(system, prepared)
            text = await run_in_threadpool(
                _complete_sync, prompt, max_tokens, temperature, keep_newlines
            )

            if text and not _matches_language(text, language):
                # Ответ на чужом языке выглядит сбоем даже когда осмыслен,
                # поэтому подменяется резервной фразой нужного языка.
                logger.info("Ответ модели не на языке интерфейса, отдана резервная фраза.")
                return random.choice(fallbacks)

            return text or random.choice(fallbacks)
        except Exception:  # noqa: BLE001
            logger.exception("Ошибка генерации, отдан резервный ответ.")
            return random.choice(fallbacks)


async def oracle_reply(history: List[Dict[str, str]],
                       language: str = DEFAULT_LANGUAGE) -> str:
    """Отвечает в диалоге с Оракулом.

    Проверка безопасности выполняется вызывающим кодом ДО обращения сюда:
    полагаться на следование системному промпту у модели такого размера
    нельзя (см. :mod:`app.oracle_safety`).

    Args:
        history: реплики диалога, последняя — от пользователя.

    Returns:
        str: ответ Оракула.
    """
    return await _generate(
        prompt_for("oracle", language), history[-8:],
        fallbacks_for("oracle", language),
        max_tokens=110, temperature=0.75, language=language
    )


async def expand_thought(task_title: str, thought: Optional[str],
                         language: str = DEFAULT_LANGUAGE) -> List[str]:
    """Предлагает три подшага для узла цепочки мыслей.

    Args:
        task_title: название квеста, задающее контекст.
        thought: текст разворачиваемого узла либо ``None`` для корня.

    Returns:
        List[str]: до трёх непустых строк.
    """
    focus = thought or task_title
    labels = {
        "ru": ("Квест", "Шаг, который надо разбить"),
        "en": ("Quest", "Step to break down"),
    }
    quest_word, step_word = labels.get(language) or labels[DEFAULT_LANGUAGE]

    turns = [{
        "role": "user",
        "content": f"{quest_word}: {task_title}\n{step_word}: {focus}",
    }]
    raw = await _generate(
        prompt_for("expand", language), turns, [""], max_tokens=120,
        temperature=0.6, keep_newlines=True, language=language
    )

    steps = []
    for line in raw.splitlines():
        cleaned = line.strip().lstrip("-–—*0123456789. ").strip()
        if cleaned and len(cleaned) > 2:
            steps.append(cleaned[:200])
        if len(steps) == 3:
            break

    if not steps:
        # Без модели разбиение всё равно должно быть осмысленным, поэтому
        # шаблон опирается на название квеста, а не на общие слова.
        if language == "en":
            steps = [
                f"Clarify what \"{focus[:40]}\" means in practice",
                "Do the smallest piece from start to finish",
                "Check the result and note what is left",
            ]
        else:
            steps = [
                f"Уточнить, что значит «{focus[:40]}» на практике",
                "Сделать самый маленький кусок целиком",
                "Проверить результат и записать, что осталось",
            ]
    return steps


async def deadline_nudge(task_title: str, minutes_left: int,
                         language: str = DEFAULT_LANGUAGE) -> str:
    """Сочиняет короткое напоминание о приближающемся дедлайне.

    Args:
        task_title: название квеста.
        minutes_left: сколько минут осталось до срока.

    Returns:
        str: одна фраза.
    """
    hours = max(1, round(minutes_left / 60))
    content = (
        f"Quest \"{task_title}\", about {hours} h until the deadline."
        if language == "en"
        else f"Квест «{task_title}», до срока примерно {hours} ч."
    )
    return await _generate(
        prompt_for("deadline", language), [{"role": "user", "content": content}],
        fallbacks_for("deadline", language),
        max_tokens=48, temperature=0.7, language=language
    )
