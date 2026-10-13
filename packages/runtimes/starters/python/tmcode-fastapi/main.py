from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="To-do API")


class TodoIn(BaseModel):
    title: str


class Todo(TodoIn):
    id: int
    done: bool = False


todos: list[Todo] = [Todo(id=1, title="Learn FastAPI")]


@app.get("/api/todos")
def all_todos() -> list[Todo]:
    return todos


@app.get("/api/todos/{todo_id}")
def one_todo(todo_id: int) -> Todo:
    for t in todos:
        if t.id == todo_id:
            return t
    raise HTTPException(status_code=404, detail="Not found")


@app.post("/api/todos", status_code=201)
def create_todo(body: TodoIn) -> Todo:
    todo = Todo(id=len(todos) + 1, title=body.title)
    todos.append(todo)
    return todo
