#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.expect("bind :8080");
    println!("To-do API listening on http://localhost:8080/api/todos");
    axum::serve(listener, todo_api::routes::router()).await.expect("server");
}
