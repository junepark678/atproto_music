use atmusic_atproto::oauth::service::CallbackQuery;
use axum::{
    Extension,
    extract::{Query, State, rejection::QueryRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};

use crate::{
    AppState,
    auth::session,
    http::{
        auth_start::safe_error,
        error::{HttpError, RequestId},
    },
};

pub async fn callback(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    query: Result<Query<CallbackQuery>, QueryRejection>,
) -> Result<Response, HttpError> {
    let Query(query) = query.map_err(|_| {
        HttpError::new(
            StatusCode::BAD_REQUEST,
            "invalid_oauth_callback",
            "OAuth callback requires code, state, and issuer.",
            &id,
        )
    })?;
    let oauth = state.oauth.as_ref().ok_or_else(|| {
        HttpError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "oauth_unavailable",
            "OAuth is unavailable.",
            &id,
        )
    })?;
    let now = state.clock.now();
    let material = oauth
        .callback(query, now.timestamp())
        .await
        .map_err(|error| safe_error(error, &id, true))?;
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let config = state
        .config
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let issued = session::issue(database, config.encryption_key(), &material.did, now)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let destination = config
        .public_origin
        .join("/feed")
        .map_err(|_| HttpError::storage(&id))?;
    let mut response = Redirect::to(destination.as_str()).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&issued.cookie).map_err(|_| HttpError::storage(&id))?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
