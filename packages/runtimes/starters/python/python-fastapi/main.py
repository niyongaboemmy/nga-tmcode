from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="To-do API")


class NewTodo(BaseModel):
    title: str


class Todo(NewTodo):
    id: int
    done: bool = False


todos: List[Todo] = []


@app.get("/api/todos")
def list_todos() -> List[Todo]:
    return todos


@app.post("/api/todos", status_code=201)
def create_todo(body: NewTodo) -> Todo:
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="title is required")
    todo = Todo(id=len(todos) + 1, title=body.title.strip())
    todos.append(todo)
    return todo
