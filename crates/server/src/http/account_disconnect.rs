//! Local disconnect has one SQLite transaction and no public PDS mutation.
use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use axum::{
    Extension,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
pub async fn disconnect(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let owner = session::authenticate(&state, &headers, &id).await?;
    owner.require_csrf(&headers, &state, &id)?;
    state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories()
        .disconnect(owner.did, state.clock.now().to_rfc3339())
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_static(
            "atmusic_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        ),
    );
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}
