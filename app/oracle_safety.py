"""Защитный слой «Чата с Оракулом».

Почему он существует отдельно от промпта. Модель на 1.5 млрд параметров
инструкциям следует нестабильно: системный промпт с запретом она нарушит при
достаточно настойчивой формулировке. Полагаться на неё в вопросах вреда
нельзя, поэтому проверка стоит **перед** генерацией и не зависит от модели
вообще — это детерминированный код, который нельзя уговорить.

Три исхода:

* ``CRISIS``  — признаки мыслей о самоповреждении. Персона Оракула здесь
  снимается намеренно: витиеватая речь древнего мыслителя в такой момент
  звучит как отстранённость. Отвечаем прямо, тепло и предлагаем помощь.
* ``HARMFUL`` — просьба, ведущая к вреду или нарушению закона. Оракул
  отказывает мягко и переводит разговор к тому, что за просьбой стоит.
* ``ALLOW``   — обычный разговор, идёт в модель.

Списки заведомо грубые: ложное срабатывание стоит одного неловкого ответа,
пропуск — гораздо дороже. При сомнении выбираем перехват.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Final, List, Optional, Pattern, Tuple


class Verdict(str, Enum):
    """Решение фильтра по реплике пользователя."""

    ALLOW = "allow"
    CRISIS = "crisis"
    HARMFUL = "harmful"


def _compile(patterns: List[str]) -> List[Pattern]:
    """Компилирует список выражений без учёта регистра."""
    return [re.compile(pattern, re.IGNORECASE | re.UNICODE) for pattern in patterns]


# Признаки мыслей о самоповреждении. Формулировки намеренно широкие.
_CRISIS: Final[List[Pattern]] = _compile([
    r"\bсуицид",
    r"самоубий",
    r"поконч(ить|у)\s+(с\s+собой|жизнь)",
    r"уби(ть|ю)\s+себя",
    r"не\s+хочу\s+(больше\s+)?жить",
    r"жить\s+не\s+хочется",
    r"хочу\s+(умереть|сдохнуть|исчезнуть\s+навсегда)",
    r"смысла\s+жить\s+нет",
    r"причин(ять|ю)\s+себе\s+боль",
    r"режу\s+себя",
    r"\bселфхарм",
    r"\bself[- ]?harm\b",
    r"\bkill\s+myself\b",
    r"\bsuicid",
    r"\bend\s+my\s+life\b",
    # Второе лицо: реплика пользователя в такой форме звучит редко, но
    # именно так выглядел бы опасный совет со стороны модели, а тот же
    # список применяется и к её ответу.
    r"\bkill\s+(your|him|her|them)self\b",
    r"\bend\s+(your|his|her|their)\s+life\b",
    r"\bhurt\s+yourself\b",
    r"уби(ть|й)\s+себя",
    r"поконч(и|ить)\s+с\s+собой",
    r"причини\s+себе",
])

# Просьбы, ведущие к вреду другим или к нарушению закона.
_HARMFUL: Final[List[Pattern]] = _compile([
    r"как\s+(мне\s+)?(сделать|собрать|изготовить|синтезировать)\s+.{0,24}"
    r"(бомб|взрывчат|напалм|оружи|яд\b|отрав)",
    r"(бомб|взрывчат|напалм)\w*\s+(своими\s+руками|в\s+домашних)",
    r"как\s+.{0,20}(убить|покалечить|избить|отравить)\s+(человек|его|её|соседа|людей)",
    r"(синтез|сварить|приготовить)\w*\s+.{0,20}"
    r"(наркотик|мефедрон|амфетамин|метамфетамин|героин)",
    r"как\s+(взломать|ломать)\s+.{0,24}(аккаунт|почт|банк|камер|телефон\s+\w+)",
    r"(вредоносн|шифровальщик|ransomware|кейлоггер)\w*\s+.{0,20}(написать|код|сделать)",
    r"как\s+.{0,20}(подделать|обналичить)\s+.{0,20}(документ|паспорт|подпись|карт)",
    r"\bдетск\w+\s+порн",
    r"как\s+.{0,20}(преследовать|выследить)\s+.{0,20}(человек|бывш|девушк)",
])

# Прямая, без персоны: в кризисный момент образ древнего мыслителя мешает.
CRISIS_REPLY_RU: Final[str] = (
    "Я остановлюсь и скажу прямо, без иносказаний: то, что ты описываешь, "
    "звучит тяжело, и с этим не стоит оставаться наедине. Я — программа, и я "
    "не смогу дать ту поддержку, которая сейчас нужна.\n\n"
    "Пожалуйста, поговори с кем-то живым: с близким человеком, которому "
    "доверяешь, или со специалистом. Если хочешь, я помогу найти, куда можно "
    "обратиться в твоём регионе — просто скажи.\n\n"
    "Квесты и дедлайны подождут. Ты — важнее любого из них."
)

CRISIS_REPLY_EN: Final[str] = (
    "I will stop and say this plainly, without metaphor: what you describe "
    "sounds heavy, and it is not something to carry alone. I am a program, and "
    "I cannot give the kind of support that is needed right now.\n\n"
    "Please talk to someone living: a person you trust, or a professional. If "
    "you want, I can help you find where to turn in your region — just say so.\n\n"
    "Quests and deadlines can wait. You matter more than any of them."
)

HARMFUL_REPLIES_EN: Final[Tuple[str, ...]] = (
    "Here I fall silent. This path leads to someone else's harm, and no goal "
    "justifies it — I will not point the way along it.\n\n"
    "But behind such a question there is usually another, a real one: anger, "
    "fear or helplessness. Tell me about that one — with it I can help.",

    "No. The knowledge you ask for breaks lives, and I will not give it.\n\n"
    "Tell me instead what brought you to it. Working through the cause is slow "
    "work, but at least it leads somewhere other than a cliff.",
)

HARMFUL_REPLIES_RU: Final[Tuple[str, ...]] = (
    "Здесь я умолкаю. Эта тропа ведёт к чужой беде, и никакая цель её не "
    "оправдывает — я не стану указывать по ней путь.\n\n"
    "Но за всяким таким вопросом обычно стоит другой, настоящий: злость, "
    "страх или бессилие. Расскажи о нём — с ним я помогу.",

    "Нет. Знание, о котором ты просишь, ломает жизни, и я не буду его давать.\n\n"
    "Скажи лучше, что тебя к этому привело. Разобрать причину — работа "
    "долгая, но она хотя бы ведёт куда-то, кроме пропасти.",
)


def screen(message: str, language: str = "ru") -> Tuple[Verdict, Optional[str]]:
    """Проверяет реплику пользователя до обращения к модели.

    Args:
        message: текст пользователя.
        language: язык интерфейса; определяет, на каком языке будет выдан
            перехваченный ответ. Ответ на чужом языке в кризисной ситуации
            попросту не будет прочитан.

    Returns:
        Tuple[Verdict, Optional[str]]: вердикт и готовый ответ, если генерацию
        нужно перехватить. Для :attr:`Verdict.ALLOW` ответ равен ``None``.
    """
    crisis = CRISIS_REPLY_EN if language == "en" else CRISIS_REPLY_RU
    harmful = HARMFUL_REPLIES_EN if language == "en" else HARMFUL_REPLIES_RU
    text = (message or "").strip()
    if not text:
        return Verdict.ALLOW, None

    # Кризис проверяется первым: он важнее любой другой категории, даже если
    # реплика попадает под обе.
    for pattern in _CRISIS:
        if pattern.search(text):
            return Verdict.CRISIS, crisis

    for pattern in _HARMFUL:
        if pattern.search(text):
            # Ответ выбирается по длине текста, а не случайно: одинаковая
            # реплика должна давать одинаковый ответ, иначе выглядит как
            # лотерея, которую можно «прокрутить» до нужного результата.
            return Verdict.HARMFUL, harmful[len(text) % len(harmful)]

    return Verdict.ALLOW, None


def guard_reply(reply: str, language: str = "ru") -> str:
    """Последняя проверка уже сгенерированного ответа.

    Модель может сама свернуть в опасную тему, даже если вопрос был
    безобидным. Проверка выхода дешевле разбирательства постфактум.

    Args:
        reply: текст, полученный от модели.
        language: язык интерфейса.

    Returns:
        str: исходный ответ либо безопасная замена.
    """
    verdict, replacement = screen(reply, language)
    if verdict is Verdict.ALLOW:
        return reply
    if verdict is Verdict.CRISIS:
        # В ответе модели такие формулировки почти наверняка означают, что она
        # подхватила тему, а не что пользователь в кризисе. Отдаём нейтральное.
        return (
            "The thought went astray, and I cut it off myself. Let us return to "
            "what you can do today."
            if language == "en"
            else "Мысль ушла не туда, и я обрываю её сам. Вернёмся к тому, "
                 "что ты можешь сделать сегодня."
        )
    fallback = HARMFUL_REPLIES_EN if language == "en" else HARMFUL_REPLIES_RU
    return replacement or fallback[0]
