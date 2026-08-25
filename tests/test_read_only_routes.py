"""Читающие маршруты настольной версии не должны трогать базу.

Мобильная версия страдала от того же и заметнее: там каждый запрос,
включая чтение, перекладывал в хранилище весь журнал. На настольной версии
цена ниже — SQLite в режиме WAL завершает пустую сделку дёшево, — но она
не нулевая, а одно обновление интерфейса вызывает подряд чтение списка
квестов, сада, витрины и настроек.

Сложность в том, что два читающих обработчика всё-таки вправе писать:
``_get_garden`` и ``_get_settings`` создают недостающую строку при первом
обращении. Поэтому проверяется не «никогда не пишет», а «пишет только
тогда, когда есть что записать»: первое обращение может завершить сделку,
последующие — нет.

Запуск::

    python -m pytest tests/test_read_only_routes.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """Приложение на отдельной базе во временном каталоге.

    База берётся новая на каждый тест: состояние строк — как раз то, что
    здесь проверяется, и общая база связала бы тесты между собой.
    """
    monkeypatch.setenv("MYQUESTIFY_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("MYQUESTIFY_NO_LLM", "1")

    for name in [m for m in list(sys.modules) if m.startswith("app.")]:
        del sys.modules[name]

    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    from app.main import app  # noqa: E402 — импорт после подмены окружения

    with fastapi_testclient.TestClient(app) as instance:
        yield instance


def count_commits(monkeypatch) -> list:
    """Перехватывает завершение сделки и складывает вызовы в список.

    Returns:
        list: пополняется при каждом завершении сделки.
    """
    from sqlalchemy.ext.asyncio import AsyncSession

    seen: list = []
    original = AsyncSession.commit

    async def spy(self):
        seen.append(True)
        return await original(self)

    monkeypatch.setattr(AsyncSession, "commit", spy)
    return seen


READ_ROUTES = [
    "/api/tasks/",
    "/api/garden/",
    "/api/shop/",
    "/api/settings/",
    "/api/oracle/",
    "/api/priorities/",
]


def test_reads_do_not_commit_when_nothing_changed(client, monkeypatch) -> None:
    """Повторное чтение не завершает сделку.

    Первый проход допускает записи: создаются строки сада и настроек.
    Второй идёт по тем же адресам, когда создавать уже нечего, — и должен
    пройти без единого завершения.
    """
    for route in READ_ROUTES:
        assert client.get(route).status_code == 200

    commits = count_commits(monkeypatch)

    for route in READ_ROUTES:
        assert client.get(route).status_code == 200

    assert commits == [], (
        f"читающие маршруты завершили сделку {len(commits)} раз, "
        "хотя менять было нечего"
    )


def test_write_still_commits(client, monkeypatch) -> None:
    """Изменение по-прежнему сохраняется.

    Обратная сторона проверки выше: отказ от лишнего завершения не должен
    превратиться в отказ от нужного.
    """
    for route in READ_ROUTES:
        client.get(route)

    commits = count_commits(monkeypatch)

    response = client.post(
        "/api/tasks/",
        json={"title": "Проверка сохранения", "estimated_hours": 2, "priority": "normal"},
    )
    assert response.status_code in (200, 201), response.text
    assert commits, "создание квеста прошло без сохранения"

    # Запись действительно осела в базе, а не только в ответе.
    listed = client.get("/api/tasks/").json()
    assert any(task["title"] == "Проверка сохранения" for task in listed)
