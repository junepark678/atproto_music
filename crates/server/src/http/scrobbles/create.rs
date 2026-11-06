//! Admit validated owner requests atomically; acknowledgements never claim publication.
use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use atmusic_atproto::pds::record_key::allocate_scrobble_rkey;
use atmusic_core::scrobble::ScrobbleInput;
use atmusic_storage::{Admission, NewOperation, StorageError};
use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Response, HttpError> {
    let session = session::authenticate(&state, &headers, &id).await?;
    session.require_csrf(&headers, &state, &id)?;
    let key = if headers.get_all("idempotency-key").iter().count() == 1 {
        headers
            .get("idempotency-key")
            .and_then(|header| header.to_str().ok())
    } else {
        None
    }
    .filter(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|byte| (32..=126).contains(&byte))
    })
    .ok_or_else(|| {
        HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_idempotency_key",
            "Idempotency-Key must contain 1 to 128 printable ASCII characters.",
            &id,
        )
    })?;
    let Json(body) = body.map_err(|error| {
        HttpError::new(
            if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            },
            if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                "body_too_large"
            } else {
                "invalid_json"
            },
            "Supply a valid JSON scrobble within the request size limit.",
            &id,
        )
    })?;
    let now = state.clock.now();
    let mut input = ScrobbleInput::from_json(&body, now).map_err(|validation| {
        let mut error = HttpError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_scrobble",
            "Scrobble validation failed.",
            &id,
        );
        error.fields = Some(BTreeMap::from([(
            validation.field,
            validation.message.into(),
        )]));
        error
    })?;
    input.listened_at = chrono::DateTime::parse_from_rfc3339(&input.listened_at)
        .map_err(|_| HttpError::storage(&id))?
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let input_value = serde_json::to_value(&input).map_err(|_| HttpError::storage(&id))?;
    let input_digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&input_value).map_err(|_| HttpError::storage(&id))?,
    ));
    let config = state
        .config
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let namespace = config.namespace.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "namespace_not_production",
            "Publication requires a configured namespace with recorded owner evidence.",
            &id,
        )
    })?;
    namespace.require_publication().map_err(|_| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "namespace_not_production",
            "Publication requires a configured namespace with recorded owner evidence.",
            &id,
        )
    })?;
    let worker = state.outbox.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "outbox_not_ready",
            "Verified PDS publication is not initialized.",
            &id,
        )
    })?;
    let record = input
        .into_record(namespace, now)
        .map_err(|_| HttpError::storage(&id))?;
    let payload_value = serde_json::to_value(&record).map_err(|_| HttpError::storage(&id))?;
    let payload = serde_json::to_string(&payload_value).map_err(|_| HttpError::storage(&id))?;
    let digest = hex::encode(Sha256::digest(payload.as_bytes()));
    let collection = namespace.scrobble_collection();
    let owner = session.did;
    let factory_owner = owner.clone();
    let repository = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories();
    let admitted = repository
        .admit_scrobble_factory(owner, key.into(), input_digest, move || {
            let rkey = allocate_scrobble_rkey(now)
                .map_err(|_| StorageError::Invariant("record identity allocation failed"))?;
            let uri = format!("at://{factory_owner}/{collection}/{rkey}");
            Ok(NewOperation {
                operation_id: uuid::Uuid::new_v4().to_string(),
                owner: factory_owner,
                kind: "scrobble_create".into(),
                created_at: now.to_rfc3339(),
                record_uri: Some(uri),
                collection,
                rkey,
                payload_json: Some(payload),
                canonical_digest: Some(digest),
            })
        })
        .await
        .map_err(|error| match error {
            StorageError::IdempotencyConflict => HttpError::new(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "Idempotency-Key was already used for a different scrobble.",
                &id,
            ),
            _ => HttpError::storage(&id),
        })?;
    let operation = match admitted {
        Admission::Created(operation) | Admission::Replayed(operation) => operation,
    };
    if operation.state == "succeeded"
        && let Some(uri) = &operation.record_uri
        && let Some(scrobble) = repository
            .scrobble(uri)
            .await
            .map_err(|_| HttpError::storage(&id))?
    {
        return Ok((StatusCode::CREATED, Json(json!({"scrobble":scrobble}))).into_response());
    }
    if operation.state != "pending" {
        let mut error = HttpError::new(
            StatusCode::CONFLICT,
            "idempotency_result_unavailable",
            "The original operation is terminal and cannot be republished; inspect its operation status.",
            &id,
        );
        if let Ok(location) = format!("/api/v1/operations/{}", operation.operation_id).parse() {
            error.headers.insert("location", location);
        }
        return Err(error);
    }
    worker.notify();
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"operationId":operation.operation_id,"state":"pending"})),
    )
        .into_response())
}
