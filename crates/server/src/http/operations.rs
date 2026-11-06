use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use axum::{
    Extension, Json,
    extract::{Path, State, rejection::PathRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

pub async fn get_operation(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let session = session::authenticate(&state, &headers, &id).await?;
    let Path(operation_id) = path.map_err(|_| {
        HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_operation_id",
            "The operation identifier is malformed.",
            &id,
        )
    })?;
    let repository = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories();
    let operation = repository
        .operation(&session.did, &operation_id)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    if let Some(operation) = operation {
        return Ok(([("cache-control", "no-store")], Json(operation)).into_response());
    }
    if repository
        .operation_exists(&operation_id)
        .await
        .map_err(|_| HttpError::storage(&id))?
    {
        Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Operation belongs to another account.",
            &id,
        ))
    } else {
        Err(HttpError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Operation not found.",
            &id,
        ))
    }
}
