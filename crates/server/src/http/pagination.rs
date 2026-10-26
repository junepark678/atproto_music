//! Shared cursor admission and page serialization for chronological scrobbles.
use crate::{
    AppState,
    http::error::{HttpError, RequestId},
};
use atmusic_core::cursor::{CursorBinding, CursorCodec, CursorPosition, PageCursor};
use atmusic_storage::repositories::{FollowRow, Indexing, PageBounds, ScrobbleRow};
use axum::{Json, http::StatusCode};
use chrono::SecondsFormat;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
struct ListQuery {
    limit: Option<String>,
    cursor: Option<String>,
}

pub(crate) fn query_error(field: &str, message: &'static str, id: &RequestId) -> HttpError {
    let mut error = HttpError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_query",
        "Query validation failed.",
        id,
    );
    error.fields = Some(BTreeMap::from([(field.into(), message.into())]));
    error
}

fn invalid_cursor(id: &RequestId) -> HttpError {
    HttpError::new(
        StatusCode::BAD_REQUEST,
        "invalid_cursor",
        "The pagination cursor is invalid for this request.",
        id,
    )
}

fn parse_query(raw: Option<String>, id: &RequestId) -> Result<(u32, Option<String>), HttpError> {
    let mut query = ListQuery::default();
    for (field, value) in url::form_urlencoded::parse(raw.as_deref().unwrap_or_default().as_bytes())
    {
        let target = match field.as_ref() {
            "limit" => &mut query.limit,
            "cursor" => &mut query.cursor,
            _ => continue,
        };
        if target.replace(value.into_owned()).is_some() {
            return Err(query_error(&field, "Parameter must occur only once.", id));
        }
    }
    let limit = query.limit.map_or(Ok(20), |value| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(query_error(
                "limit",
                "Expected an integer between 1 and 100.",
                id,
            ));
        }
        value
            .parse::<u32>()
            .ok()
            .filter(|value| (1..=100).contains(value))
            .ok_or_else(|| query_error("limit", "Expected an integer between 1 and 100.", id))
    })?;
    Ok((limit, query.cursor))
}

pub(crate) struct Pagination {
    binding: CursorBinding,
    codec: CursorCodec,
    cursor: Option<PageCursor>,
    as_of: String,
    limit: u32,
}
impl Pagination {
    pub(crate) fn from_query(
        state: &AppState,
        binding: CursorBinding,
        raw_query: Option<String>,
        id: &RequestId,
    ) -> Result<Self, HttpError> {
        let (limit, token) = parse_query(raw_query, id)?;
        let config = state
            .config
            .as_ref()
            .ok_or_else(|| HttpError::storage(id))?;
        let codec = CursorCodec::from_application_key(config.encryption_key())
            .map_err(|_| HttpError::storage(id))?;
        let cursor = token
            .as_deref()
            .map(|token| {
                codec
                    .decode(token, &binding)
                    .map_err(|_| invalid_cursor(id))
            })
            .transpose()?;
        let as_of = cursor.as_ref().map_or_else(
            || {
                state
                    .clock
                    .now()
                    .to_rfc3339_opts(SecondsFormat::Nanos, true)
            },
            |cursor| cursor.as_of.clone(),
        );
        Ok(Self {
            binding,
            codec,
            cursor,
            as_of,
            limit,
        })
    }
    pub(crate) fn bounds(&self) -> PageBounds {
        PageBounds {
            upper: self
                .cursor
                .as_ref()
                .map(|cursor| (cursor.upper.timestamp.clone(), cursor.upper.uri.clone())),
            last: self
                .cursor
                .as_ref()
                .map(|cursor| (cursor.last.timestamp.clone(), cursor.last.uri.clone())),
            limit: self.limit + 1,
        }
    }
    pub(crate) fn response(
        self,
        rows: Vec<ScrobbleRow>,
        indexing: Indexing,
        id: &RequestId,
    ) -> Result<Json<Value>, HttpError> {
        self.response_with(rows, indexing, id, row_position)
    }
    pub(crate) fn follow_response(
        self,
        rows: Vec<FollowRow>,
        indexing: Indexing,
        id: &RequestId,
    ) -> Result<Json<Value>, HttpError> {
        self.response_with(rows, indexing, id, |row| {
            CursorPosition::new(&row.created_at, &row.uri)
        })
    }
    fn response_with<T: Serialize>(
        self,
        mut rows: Vec<T>,
        indexing: Indexing,
        id: &RequestId,
        position: fn(&T) -> Result<CursorPosition, atmusic_core::cursor::CursorError>,
    ) -> Result<Json<Value>, HttpError> {
        let has_more = rows.len() > self.limit as usize;
        rows.truncate(self.limit as usize);
        let next_cursor = if has_more {
            let first = rows.first().ok_or_else(|| HttpError::storage(id))?;
            let last = position(rows.last().ok_or_else(|| HttpError::storage(id))?)
                .map_err(|_| HttpError::storage(id))?;
            let next = if let Some(cursor) = self.cursor {
                cursor.advance(last)
            } else {
                PageCursor::new(
                    self.binding,
                    position(first).map_err(|_| HttpError::storage(id))?,
                    last,
                    &self.as_of,
                )
            }
            .map_err(|_| HttpError::storage(id))?;
            Some(
                self.codec
                    .encode(&next)
                    .map_err(|_| HttpError::storage(id))?,
            )
        } else {
            None
        };
        Ok(Json(
            json!({"items": rows, "nextCursor": next_cursor, "asOf": self.as_of, "indexing": indexing}),
        ))
    }
}
fn row_position(row: &ScrobbleRow) -> Result<CursorPosition, atmusic_core::cursor::CursorError> {
    CursorPosition::new(&row.listened_at, &row.uri)
}
