//! Cookie-authorized, durable follow intentions; queued work is never public confirmation.
use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use atmusic_core::follow::validate_did_syntax;
use atmusic_storage::{FollowIntent, StorageError};
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Path, State, rejection::PathRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::collections::BTreeMap;

async fn mutate(
    state: AppState,
    id: RequestId,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    body: Bytes,
    create: bool,
) -> Result<Response, HttpError> {
    let session = session::authenticate(&state, &headers, &id).await?;
    session.require_csrf(&headers, &state, &id)?;
    let invalid = |field: &str, message: &str| {
        let mut error = HttpError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_follow",
            "Follow validation failed.",
            &id,
        );
        error.fields = Some(BTreeMap::from([(field.into(), message.into())]));
        error
    };
    let Path(subject) = path.map_err(|_| invalid("did", "Expected a DID path."))?;
    validate_did_syntax(&subject).map_err(|_| invalid("did", "Expected a DID."))?;
    if subject == session.did {
        return Err(invalid("did", "Cannot follow yourself."));
    }
    if !body.is_empty() {
        return Err(invalid("body", "This endpoint has no request body."));
    }
    let config = state
        .config
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let namespace = config.namespace.clone();
    let ready = state.outbox.is_some()
        && namespace
            .as_ref()
            .is_some_and(|namespace| namespace.require_publication().is_ok());
    let now = state.clock.now();
    let actor = session.did;
    let factory_actor = actor.clone();
    let factory_subject = subject.clone();
    let repository = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories();
    let intent = repository
        .follow_intent(actor, subject, create, ready, move || {
            let namespace = namespace.ok_or(StorageError::Invariant("outbox_not_ready"))?;
            atmusic_atproto::pds::follow::operation(
                &factory_actor,
                &factory_subject,
                &namespace,
                now,
                create,
                uuid::Uuid::new_v4().to_string(),
            )
            .map_err(|_| StorageError::Invariant("invalid follow record"))
        })
        .await
        .map_err(|error| match error {
            StorageError::Invariant("outbox_not_ready") => HttpError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "outbox_not_ready",
                "Verified PDS publication is not initialized.",
                &id,
            ),
            _ => HttpError::storage(&id),
        })?;
    match intent {
        FollowIntent::Failed(operation) => {
            let mut response = HttpError::new(
                StatusCode::BAD_GATEWAY,
                "deletion_failed",
                "Remote follow removal failed; inspect the original operation.",
                &id,
            )
            .into_response();
            response.headers_mut().insert(
                axum::http::header::LOCATION,
                format!("/api/v1/operations/{}", operation.operation_id)
                    .parse()
                    .expect("operation UUID header"),
            );
            Ok(response)
        }
        FollowIntent::Existing(follow) => {
            Ok((StatusCode::OK, Json(json!({"follow":follow}))).into_response())
        }
        FollowIntent::Absent => Ok(StatusCode::NO_CONTENT.into_response()),
        FollowIntent::Pending(operation) => {
            let worker = state.outbox.as_ref().ok_or_else(|| {
                HttpError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "outbox_not_ready",
                    "Verified PDS publication is not initialized.",
                    &id,
                )
            })?;
            worker.notify();
            Ok((
                StatusCode::ACCEPTED,
                Json(json!({"operationId":operation.operation_id,"state":"pending"})),
            )
                .into_response())
        }
    }
}
pub async fn put(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    body: Bytes,
) -> Result<Response, HttpError> {
    mutate(state, id, headers, path, body, true).await
}
pub async fn delete(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    body: Bytes,
) -> Result<Response, HttpError> {
    mutate(state, id, headers, path, body, false).await
}
