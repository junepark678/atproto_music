//! Public, fixed-window statistics from confirmed current records.

use std::collections::BTreeMap;

use atmusic_core::follow::validate_did_syntax;
use atmusic_storage::{Statistics, StatisticsWindow};
use axum::{
    Extension, Json,
    extract::{Path, RawQuery, State, rejection::PathRejection},
    http::StatusCode,
};

use crate::{
    AppState,
    http::error::{HttpError, RequestId},
};

fn invalid(field: &str, message: &'static str, id: &RequestId) -> HttpError {
    let mut error = HttpError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_query",
        "Query validation failed.",
        id,
    );
    error.fields = Some(BTreeMap::from([(field.into(), message.into())]));
    error
}

fn query(raw: Option<String>, id: &RequestId) -> Result<(StatisticsWindow, u32), HttpError> {
    let mut window = None;
    let mut limit = None;
    for (field, value) in url::form_urlencoded::parse(raw.as_deref().unwrap_or_default().as_bytes())
    {
        let target = match field.as_ref() {
            "window" => &mut window,
            "limit" => &mut limit,
            "cursor" => return Err(invalid("cursor", "Statistics do not use cursors.", id)),
            _ => continue,
        };
        if target.replace(value.into_owned()).is_some() {
            return Err(invalid(&field, "Parameter must occur only once.", id));
        }
    }
    let window = window.map_or(Ok(StatisticsWindow::All), |value| {
        StatisticsWindow::parse(&value)
            .ok_or_else(|| invalid("window", "Expected all, 7d, 30d or 365d.", id))
    })?;
    let limit = limit.map_or(Ok(10), |value| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid(
                "limit",
                "Expected an integer between 1 and 100.",
                id,
            ));
        }
        value
            .parse::<u32>()
            .ok()
            .filter(|limit| (1..=100).contains(limit))
            .ok_or_else(|| invalid("limit", "Expected an integer between 1 and 100.", id))
    })?;
    Ok((window, limit))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(id): Extension<RequestId>,
    path: Result<Path<String>, PathRejection>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Statistics>, HttpError> {
    let Path(did) = path.map_err(|_| invalid("did", "Expected a valid DID path.", &id))?;
    validate_did_syntax(&did).map_err(|_| invalid("did", "Expected a DID.", &id))?;
    let (window, limit) = query(raw, &id)?;
    let as_of = state.clock.now();
    let database = state
        .database
        .as_ref()
        .ok_or_else(|| HttpError::storage(&id))?;
    let response = database
        .repositories()
        .statistics(&did, window, as_of, limit)
        .await
        .map_err(|_| HttpError::storage(&id))?;
    Ok(Json(response))
}
