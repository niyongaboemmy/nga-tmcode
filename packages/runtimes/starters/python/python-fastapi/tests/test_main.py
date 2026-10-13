import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402


def test_create_and_list_todos():
    client = TestClient(app)
    created = client.post("/api/todos", json={"title": "Revise maths"})
    assert created.status_code == 201
    assert created.json()["title"] == "Revise maths"
    assert client.get("/api/todos").json()[0]["done"] is False
