use atmusic_atproto::{identity::IdentityError, oauth::service::OAuthError};
use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

use crate::{
    AppState,
    http::error::{HttpError, RequestId},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    handle: String,
}

pub async fn start(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    body: Result<Json<StartRequest>, JsonRejection>,
) -> Result<Response, HttpError> {
    let config = state
        .config
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    if headers.get_all("origin").iter().count() != 1
        || headers
            .get("origin")
            .and_then(|header| header.to_str().ok())
            != Some(config.public_origin.as_str().trim_end_matches('/'))
    {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "origin_forbidden",
            "Sign-in requires the configured application origin.",
            &id,
        ));
    }
    let Json(body) = body.map_err(|error| {
        let status = error.status();
        let mut error = HttpError::new(
            if matches!(
                status,
                StatusCode::UNPROCESSABLE_ENTITY | StatusCode::PAYLOAD_TOO_LARGE
            ) {
                status
            } else {
                StatusCode::BAD_REQUEST
            },
            "invalid_request",
            "Supply a JSON object with one handle field.",
            &id,
        );
        if error.status == StatusCode::UNPROCESSABLE_ENTITY {
            error.fields = Some(BTreeMap::from([(
                "body".into(),
                "Expected one string handle field and no unknown fields.".into(),
            )]));
        }
        error
    })?;
    let oauth = state.oauth.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "oauth_unavailable",
            "OAuth is unavailable.",
            &id,
        )
    })?;
    let url = oauth
        .start(&body.handle, state.clock.now().timestamp())
        .await
        .map_err(|error| safe_error(error, &id, false))?;
    Ok((
        [("cache-control", "no-store")],
        Json(json!({"authorizationUrl": url})),
    )
        .into_response())
}

pub fn safe_error(error: OAuthError, id: &RequestId, callback: bool) -> HttpError {
    let (status, code) = match error {
        OAuthError::InvalidState => (StatusCode::BAD_REQUEST, "invalid_oauth_state"),
        OAuthError::IssuerMismatch
        | OAuthError::Discovery(
            atmusic_atproto::oauth::discovery::DiscoveryError::IssuerMismatch,
        ) => (StatusCode::UNAUTHORIZED, "issuer_mismatch"),
        OAuthError::SubjectMismatch => (StatusCode::UNAUTHORIZED, "subject_mismatch"),
        OAuthError::Identity(
            IdentityError::InvalidHandle
            | IdentityError::InvalidDid
            | IdentityError::HandleMismatch,
        ) => (StatusCode::UNPROCESSABLE_ENTITY, "invalid_identity"),
        OAuthError::Identity(
            IdentityError::HandleNotFound
            | IdentityError::Fetch(atmusic_atproto::http::safe_client::FetchError::HttpStatus(
                404 | 410,
            )),
        ) => (StatusCode::NOT_FOUND, "handle_not_found"),
        OAuthError::Storage => (StatusCode::SERVICE_UNAVAILABLE, "oauth_storage_unavailable"),
        OAuthError::Discovery(
            atmusic_atproto::oauth::discovery::DiscoveryError::UnsupportedOAuthServer,
        ) => (StatusCode::BAD_GATEWAY, "unsupported_oauth_server"),
        OAuthError::MissingNonce => (StatusCode::BAD_GATEWAY, "missing_dpop_nonce"),
        OAuthError::NonceExhausted => (StatusCode::BAD_GATEWAY, "dpop_nonce_retry_exhausted"),
        OAuthError::ScopeMismatch | OAuthError::InvalidResponse if callback => {
            (StatusCode::UNAUTHORIZED, "invalid_oauth_response")
        }
        _ => (StatusCode::BAD_GATEWAY, "oauth_upstream_failed"),
    };
    let status = if callback
        && status != StatusCode::BAD_REQUEST
        && status != StatusCode::SERVICE_UNAVAILABLE
    {
        StatusCode::UNAUTHORIZED
    } else {
        status
    };
    let mut error = HttpError::new(
        status,
        code,
        "OAuth authorization could not be completed.",
        id,
    );
    if status == StatusCode::UNPROCESSABLE_ENTITY {
        error.fields = Some(BTreeMap::from([(
            "handle".into(),
            "Expected a bidirectionally verified handle or supported DID.".into(),
        )]));
    }
    error
}
