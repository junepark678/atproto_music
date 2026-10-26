//! Public history and lookup over the already verified storage projection.
use crate::{
    AppState,
    http::{
        error::{HttpError, RequestId},
        pagination::{Pagination, query_error},
    },
};
use atmusic_core::{cursor::CursorBinding, follow::validate_did_syntax};
use axum::{
    Extension, Json,
    extract::{Path, RawQuery, State, rejection::PathRejection},
    http::StatusCode,
};
use serde_json::{Value, json};

pub async fn history(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
    RawQuery(raw_query): RawQuery,
) -> Result<Json<Value>, HttpError> {
    let Path(did) = path.map_err(|_| query_error("did", "Expected a valid DID path.", &id))?;
    validate_did_syntax(&did).map_err(|_| query_error("did", "Expected a DID.", &id))?;
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let pagination = Pagination::from_query(&state, CursorBinding::history(&did), raw_query, &id)?;
    let repository = database.repositories();
    let rows = repository
        .history(&did, pagination.bounds())
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let indexing = crate::http::index_status::app_indexing(&state, &repository, &did)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    pagination.response(rows, indexing, &id)
}

pub async fn record(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, HttpError> {
    let Path(uri) = path.map_err(|_| {
        HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_path",
            "The encoded record URI is invalid.",
            &id,
        )
    })?;
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let row = database
        .repositories()
        .scrobble(&uri)
        .await
        .map_err(|_| HttpError::storage(&id))?
        .ok_or_else(|| {
            HttpError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Scrobble not found.",
                &id,
            )
        })?;
    Ok(Json(json!({"scrobble": row})))
}
