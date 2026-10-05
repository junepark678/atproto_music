//! Minimal executable scaffold; this is not a ready music application.

use atmusic_core::{ApiError, ErrorEnvelope};
use axum::{Json, Router, http::StatusCode, response::Html, routing::get};
use serde_json::{Value, json};

pub fn router() -> Router {
    Router::new()
        .route("/", get(index))
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/api/v1/meta", get(meta))
        .fallback(not_found)
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../assets/index.html"))
}

async fn live() -> Json<Value> {
    Json(json!({"status": "live"}))
}

async fn ready() -> (StatusCode, Json<ErrorEnvelope>) {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "not_initialized",
        "Scaffold only: application storage and authentication are not implemented.",
    )
}

async fn meta() -> Json<Value> {
    Json(json!({
        "name": "atproto_music",
        "version": env!("CARGO_PKG_VERSION"),
        "stage": "scaffold",
        "capabilities": []
    }))
}

async fn not_found() -> (StatusCode, Json<ErrorEnvelope>) {
    error(StatusCode::NOT_FOUND, "not_found", "Route not found.")
}

fn error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
) -> (StatusCode, Json<ErrorEnvelope>) {
    (
        status,
        Json(ErrorEnvelope {
            error: ApiError {
                code,
                message,
                request_id: uuid::Uuid::new_v4().to_string(),
            },
        }),
    )
}
