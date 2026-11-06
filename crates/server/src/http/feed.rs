//! Global and session-bound following feeds over current verified records.
use atmusic_core::cursor::CursorBinding;
use axum::{
    Extension, Json,
    extract::{RawQuery, State},
    http::HeaderMap,
};
use serde_json::Value;

use crate::{
    AppState,
    auth::session,
    http::{
        error::{HttpError, RequestId},
        pagination::{Pagination, query_error},
    },
};

fn scope(raw_query: Option<&str>, id: &RequestId) -> Result<bool, HttpError> {
    let mut following = None;
    for (field, value) in url::form_urlencoded::parse(raw_query.unwrap_or_default().as_bytes()) {
        if field != "scope" {
            continue;
        }
        let value = match value.as_ref() {
            "global" => false,
            "following" => true,
            _ => return Err(query_error("scope", "Expected global or following.", id)),
        };
        if following.replace(value).is_some() {
            return Err(query_error("scope", "Parameter must occur only once.", id));
        }
    }
    Ok(following.unwrap_or(false))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> Result<Json<Value>, HttpError> {
    let following = scope(raw_query.as_deref(), &id)?;
    let viewer = if following {
        Some(session::authenticate(&state, &headers, &id).await?.did)
    } else {
        None
    };
    let binding = viewer
        .as_ref()
        .map_or_else(CursorBinding::global_feed, CursorBinding::following_feed);
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let pagination = Pagination::from_query(&state, binding, raw_query, &id)?;
    let repository = database.repositories();
    let rows = repository
        .feed(viewer.as_deref(), pagination.bounds())
        .await
        .map_err(|_| HttpError::storage(&id))?;
    let indexing = crate::http::index_status::app_indexing(&state, &repository, "global")
        .await
        .map_err(|_| HttpError::storage(&id))?;
    pagination.response(rows, indexing, &id)
}
