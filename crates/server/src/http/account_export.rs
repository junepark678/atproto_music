//! Authenticated point-in-time export of the owner's indexed public records.
use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
pub async fn export(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let owner = session::authenticate(&state, &headers, &id).await?;
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let repository = database.repositories();
    let relay = state
        .config
        .as_ref()
        .and_then(|config| config.relay_url.as_ref())
        .map(|url| url.as_str());
    let export = repository
        .export_account_with_relay(&owner.did, &state.clock.now().to_rfc3339(), relay)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let mut response = Json(export).into_response();
    response.headers_mut().insert(
        "content-disposition",
        HeaderValue::from_static("attachment; filename=\"music-export.json\""),
    );
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}
