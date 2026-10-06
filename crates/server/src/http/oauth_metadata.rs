use axum::{
    Extension, Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{
    AppState,
    config::Config,
    http::error::{HttpError, RequestId},
};

/// Required identity authentication plus the two configured music collections.
/// Public profile information does not require an identity management scope.
pub fn scopes(config: &Config) -> Vec<String> {
    let mut scopes = vec!["atproto".into()];
    if let Some(namespace) = &config.namespace {
        scopes.push(format!("repo:{}", namespace.scrobble_collection()));
        scopes.push(format!("repo:{}", namespace.follow_collection()));
    }
    scopes
}

pub fn document(config: &Config) -> Result<Value, &'static str> {
    if config.public_origin.port().is_some() {
        return Err("invalid_oauth_origin");
    }
    let client_id = config
        .public_origin
        .join("/oauth/client-metadata.json")
        .map_err(|_| "invalid_oauth_origin")?;
    let callback = config
        .public_origin
        .join("/api/v1/auth/callback")
        .map_err(|_| "invalid_oauth_origin")?;
    Ok(json!({
        "client_id": client_id.as_str(),
        "client_uri": config.public_origin.as_str(),
        "client_name": "AT Music",
        "application_type": "web",
        "redirect_uris": [callback.as_str()],
        "scope": scopes(config).join(" "),
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "dpop_bound_access_tokens": true,
        "require_pushed_authorization_requests": true
    }))
}

pub async fn client_metadata(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
) -> Result<Response, HttpError> {
    let config = state.config.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "configuration_missing",
            "Application configuration is unavailable.",
            &id,
        )
    })?;
    let document = document(config).map_err(|_| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_oauth_origin",
            "OAuth requires a public HTTPS origin without a port.",
            &id,
        )
    })?;
    Ok(([("cache-control", "no-cache")], Json(document)).into_response())
}
