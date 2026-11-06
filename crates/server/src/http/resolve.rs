//! Explicit, bounded handle resolution; this read never creates a music user.
use std::collections::BTreeMap;

use atmusic_atproto::{
    http::safe_client::FetchError,
    identity::{IdentityError, normalize_handle},
};
use axum::{
    Extension, Json,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    http::error::{HttpError, RequestId},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveQuery {
    handle: String,
}

#[derive(Serialize)]
pub struct ResolvedIdentity {
    did: String,
    handle: String,
    verified: bool,
}

fn invalid_query(id: &RequestId) -> HttpError {
    let mut error = HttpError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_query",
        "A valid handle is required.",
        id,
    );
    error.fields = Some(BTreeMap::from([(
        "handle".into(),
        "Expected a handle.".into(),
    )]));
    error
}

fn resolution_error(error: IdentityError, id: &RequestId) -> HttpError {
    match error {
        IdentityError::InvalidHandle | IdentityError::InvalidDid => invalid_query(id),
        IdentityError::HandleMismatch
        | IdentityError::DidMismatch
        | IdentityError::AmbiguousHandle => {
            let mut error = HttpError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "identity_mismatch",
                "The handle could not be verified.",
                id,
            );
            error.fields = Some(BTreeMap::from([(
                "handle".into(),
                "Handle verification failed.".into(),
            )]));
            error
        }
        IdentityError::HandleNotFound | IdentityError::Fetch(FetchError::HttpStatus(404 | 410)) => {
            HttpError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Identity not found.",
                id,
            )
        }
        _ => HttpError::new(
            StatusCode::BAD_GATEWAY,
            "upstream_unavailable",
            "Identity resolution is unavailable.",
            id,
        ),
    }
}

pub async fn get(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    query: Result<Query<ResolveQuery>, QueryRejection>,
) -> Result<Response, HttpError> {
    let Query(query) = query.map_err(|_| invalid_query(&id))?;
    let handle = normalize_handle(&query.handle).map_err(|_| invalid_query(&id))?;
    let resolver = state.identity.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::BAD_GATEWAY,
            "upstream_unavailable",
            "Identity resolution is unavailable.",
            &id,
        )
    })?;
    let identity = resolver
        .resolve(&handle)
        .await
        .map_err(|error| resolution_error(error, &id))?;
    if !identity.verified || identity.handle.as_deref() != Some(handle.as_str()) {
        return Err(resolution_error(IdentityError::HandleMismatch, &id));
    }
    Ok((
        [("cache-control", "no-store")],
        Json(ResolvedIdentity {
            did: identity.did,
            handle,
            verified: true,
        }),
    )
        .into_response())
}
