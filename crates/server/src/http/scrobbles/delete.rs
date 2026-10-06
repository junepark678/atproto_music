//! Owner deletion hides immediately and succeeds only after verified absence.
use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use atmusic_core::follow::validate_did_syntax;
use atmusic_storage::{DeletionAdmission, NewOperation};
use axum::{
    Extension, Json,
    extract::{Path, State, rejection::PathRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;

pub async fn delete(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let session = session::authenticate(&state, &headers, &id).await?;
    session.require_csrf(&headers, &state, &id)?;
    let Path(uri) = path.map_err(|_| invalid_uri(&id))?;
    let components: Vec<&str> = uri
        .strip_prefix("at://")
        .ok_or_else(|| invalid_uri(&id))?
        .split('/')
        .collect();
    if components.len() != 3
        || validate_did_syntax(components[0]).is_err()
        || matches!(components[2], "." | "..")
        || components[2].is_empty()
        || components[2].len() > 512
        || !components[2]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~:-".contains(&b))
    {
        return Err(invalid_uri(&id));
    }
    if components[0] != session.did {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "wrong_owner",
            "Only the record owner may delete this scrobble.",
            &id,
        ));
    }
    let config = state
        .config
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let namespace = config
        .namespace
        .as_ref()
        .ok_or_else(|| unavailable_namespace(&id))?;
    namespace
        .require_publication()
        .map_err(|_| unavailable_namespace(&id))?;
    if components[1] != namespace.scrobble_collection() {
        return Err(invalid_uri(&id));
    }
    let worker = state.outbox.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "outbox_not_ready",
            "Verified PDS deletion is not initialized.",
            &id,
        )
    })?;
    let input = NewOperation {
        operation_id: uuid::Uuid::new_v4().to_string(),
        owner: session.did,
        kind: "scrobble_delete".into(),
        created_at: state.clock.now().to_rfc3339(),
        record_uri: Some(uri.clone()),
        collection: components[1].into(),
        rkey: components[2].into(),
        payload_json: None,
        canonical_digest: None,
    };
    let repository = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories();
    match repository
        .admit_scrobble_deletion(input)
        .await
        .map_err(|_| HttpError::storage(&id))?
    {
        DeletionAdmission::ConfirmedAbsent | DeletionAdmission::CancelledUnsent => {
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        DeletionAdmission::Pending(operation) => {
            worker.notify();
            Ok((
                StatusCode::ACCEPTED,
                Json(json!({"operationId":operation.operation_id,"state":"pending"})),
            )
                .into_response())
        }
        DeletionAdmission::Failed(operation) => {
            let mut error = HttpError::new(
                StatusCode::BAD_GATEWAY,
                "deletion_failed",
                "Remote deletion failed; the local scrobble remains hidden. Inspect the operation status.",
                &id,
            );
            if let Ok(location) = format!("/api/v1/operations/{}", operation.operation_id).parse() {
                error.headers.insert("location", location);
            }
            Err(error)
        }
    }
}
fn invalid_uri(id: &RequestId) -> HttpError {
    HttpError::new(
        StatusCode::BAD_REQUEST,
        "invalid_record_uri",
        "Supply an encoded full scrobble AT URI.",
        id,
    )
}
fn unavailable_namespace(id: &RequestId) -> HttpError {
    HttpError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "namespace_not_production",
        "Deletion requires a configured namespace with recorded owner evidence.",
        id,
    )
}
