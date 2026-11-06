use crate::{
    AppState,
    http::error::{HttpError, RequestId},
};
use axum::{Extension, Json, extract::State, http::StatusCode};
use serde_json::{Value, json};

pub async fn live() -> Json<Value> {
    Json(json!({"status": "live"}))
}

pub async fn ready(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
) -> Result<Json<Value>, HttpError> {
    if state
        .database
        .as_ref()
        .is_some_and(|database| database.is_ready())
    {
        Ok(Json(json!({"status": "ready"})))
    } else {
        Err(HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_not_ready",
            "Application storage is not ready.",
            &id,
        ))
    }
}

pub async fn meta(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
) -> Result<Json<Value>, HttpError> {
    let initialized = state
        .database
        .as_ref()
        .is_some_and(|database| database.is_ready());
    let indexing = if let Some(database) = state.database.as_ref() {
        serde_json::to_value(
            crate::http::index_status::app_indexing(&state, &database.repositories(), "global")
                .await
                .map_err(|_| HttpError::storage(&id))?,
        )
        .map_err(|_| HttpError::storage(&id))?
    } else {
        json!({"state":"recovering","caughtUp":false,"lastIndexedAt":null,"lagSeconds":null})
    };
    Ok(Json(json!({
        "name": "atproto_music", "version": env!("CARGO_PKG_VERSION"),
        "stage": if initialized { "backend" } else { "scaffold" },
        "capabilities": if initialized { vec!["storage"] } else { vec![] },
        "lexiconPrefix": state.config.as_ref().and_then(|config| config.namespace.as_ref()).map(|namespace| namespace.prefix()),
        "indexing": indexing
    })))
}
