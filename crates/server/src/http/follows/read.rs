//! Public confirmed representative follow edges with authenticated cursors.
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
};
use serde_json::Value;

async fn page(
    state: AppState,
    id: RequestId,
    path: Result<Path<String>, PathRejection>,
    raw: Option<String>,
    followers: bool,
) -> Result<Json<Value>, HttpError> {
    let Path(did) = path.map_err(|_| query_error("did", "Expected a DID path.", &id))?;
    validate_did_syntax(&did).map_err(|_| query_error("did", "Expected a DID.", &id))?;
    let binding = if followers {
        CursorBinding::followers(&did)
    } else {
        CursorBinding::following(&did)
    };
    let pagination = Pagination::from_query(&state, binding, raw, &id)?;
    let repository = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories();
    let rows = repository
        .follow_page(&did, followers, pagination.bounds())
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let indexing = crate::http::index_status::app_indexing(&state, &repository, &did)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    pagination.follow_response(rows, indexing, &id)
}
pub async fn followers(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, HttpError> {
    page(state, id, path, raw, true).await
}
pub async fn following(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, HttpError> {
    page(state, id, path, raw, false).await
}
