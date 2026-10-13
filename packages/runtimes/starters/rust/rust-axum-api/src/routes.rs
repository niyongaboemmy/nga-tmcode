use std::sync::{Arc, Mutex};

use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
pub struct Todo {
    pub id: usize,
    pub title: String,
    pub done: bool,
}

#[derive(Deserialize)]
pub struct NewTodo {
    pub title: String,
}

type Todos = Arc<Mutex<Vec<Todo>>>;

pub fn router() -> Router {
    let todos: Todos = Arc::default();
    Router::new().route("/api/todos", get(list).post(create)).with_state(todos)
}

async fn list(State(todos): State<Todos>) -> Json<Vec<Todo>> {
    Json(todos.lock().unwrap().clone())
}

async fn create(State(todos): State<Todos>, Json(body): Json<NewTodo>) -> Result<(StatusCode, Json<Todo>), StatusCode> {
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut todos = todos.lock().unwrap();
    let todo = Todo { id: todos.len() + 1, title, done: false };
    todos.push(todo.clone());
    Ok((StatusCode::CREATED, Json(todo)))
}
