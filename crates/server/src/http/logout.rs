use crate::{
    AppState,
    auth::session,
    http::error::{HttpError, RequestId},
};
use axum::{
    Extension,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

pub async fn logout(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let session = session::authenticate(&state, &headers, &id).await?;
    session.require_csrf(&headers, &state, &id)?;
    state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?
        .repositories()
        .delete_session(&session.session_hash)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    // Invalidate locally first. A bounded upstream outage cannot keep the cookie usable.
    if let Some(oauth) = &state.oauth
        && oauth
            .revoke(&session.did, state.clock.now().timestamp())
            .await
            .is_err()
    {
        tracing::warn!(request_id = %id.0, outcome = "revocation_failed", "local logout complete; upstream revocation did not complete");
    }
    Ok((
        StatusCode::NO_CONTENT,
        [
            (
                "set-cookie",
                "atmusic_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
            ),
            ("cache-control", "no-store"),
        ],
    )
        .into_response())
}
