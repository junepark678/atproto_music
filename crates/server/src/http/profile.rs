//! Public DID profiles using confirmed active projection counts.
use std::collections::BTreeMap;

use atmusic_core::follow::validate_did_syntax;
use atmusic_storage::Indexing;
use axum::{
    Extension, Json,
    extract::{Path, State, rejection::PathRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::{
    AppState,
    http::error::{HttpError, RequestId},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub did: String,
    pub handle: Option<String>,
    pub joined_at: String,
    pub indexed_at: Option<String>,
    pub total_scrobbles: i64,
    pub follower_count: i64,
    pub following_count: i64,
    pub indexing: Indexing,
}

fn invalid_did(id: &RequestId) -> HttpError {
    let mut error = HttpError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_query",
        "Query validation failed.",
        id,
    );
    error.fields = Some(BTreeMap::from([("did".into(), "Expected a DID.".into())]));
    error
}

pub async fn get(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Response, HttpError> {
    let Path(did) = path.map_err(|_| invalid_did(&id))?;
    validate_did_syntax(&did).map_err(|_| invalid_did(&id))?;
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let repository = database.repositories();
    let user = repository
        .active_user(&did)
        .await
        .map_err(|_| HttpError::storage(&id))?
        .ok_or_else(|| {
            HttpError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Profile not found.",
                &id,
            )
        })?;
    let (total_scrobbles, follower_count, following_count) =
        repository
            .public_counts(&did)
            .await
            .map_err(|_| HttpError::storage(&id))?;
    let indexing = crate::http::index_status::app_indexing(&state, &repository, &did)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    // Stored aliases are display hints, not verification evidence. Refresh only
    // an already-known active DID through the bounded identity cache; a stale or
    // unavailable chain removes the display claim without hiding music history.
    let handle = match state.identity.as_ref() {
        Some(resolver) => resolver.resolve(&did).await.ok().and_then(|identity| {
            (identity.verified && identity.did == did)
                .then_some(identity.handle)
                .flatten()
        }),
        None => None,
    };
    // Do not let HTTP caches retain a profile across a confirmed local mutation
    // or account deactivation. Identity caching remains independently <= 300s.
    Ok((
        [("cache-control", "no-store")],
        Json(Profile {
            did: user.did,
            handle,
            joined_at: user.joined_at,
            indexed_at: user.indexed_at,
            total_scrobbles,
            follower_count,
            following_count,
            indexing,
        }),
    )
        .into_response())
}
