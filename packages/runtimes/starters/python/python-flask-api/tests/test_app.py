import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402


def test_create_and_list_todos():
    client = create_app().test_client()
    created = client.post("/api/todos", json={"title": "Revise maths"})
    assert created.status_code == 201
    assert client.get("/api/todos").get_json() == [{"id": 1, "title": "Revise maths", "done": False}]


def test_title_is_required():
    assert create_app().test_client().post("/api/todos", json={}).status_code == 400
