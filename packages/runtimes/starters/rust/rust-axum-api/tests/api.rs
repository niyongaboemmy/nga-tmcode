use axum::{body::Body, http::{Request, StatusCode}};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn creates_a_todo() {
    let app = todo_api::routes::router();
    let response = app
        .oneshot(
            Request::post("/api/todos")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"title":"Revise maths"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], br#"{"id":1,"title":"Revise maths","done":false}"#);
}
